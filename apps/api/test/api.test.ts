import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { createDb } from '../src/db/client';
import { setupTestDatabase, testDatabaseUrl, truncateAll } from './helpers';

let app: ReturnType<typeof buildApp>;

beforeAll(async () => {
  await setupTestDatabase();
  app = buildApp(createDb(testDatabaseUrl()));
  await app.ready();
});

beforeEach(async () => {
  await truncateAll();
});

function createAgent(name = 'test-agent') {
  return app.inject({
    method: 'POST',
    url: '/agents',
    payload: { name, capabilities: ['research', 'search'] },
  });
}

// 验收维度映射：docs/TESTING.md
// 正确性 / 确定性 / 可解释性 / 鲁棒性 / 数据完整性 / 持久化

// 注（D3，2026-09-09 拍板）：POST /agents/:id/evidence 的 source 白名单已收紧为
// 仅 'simulation'（真实证据走 /ingest/results 验签链路）。本文件原先用 'benchmark'
// 作为占位源，现统一改为 'simulation'——这些用例考的是提交/重算/可追溯，不涉源权重。
describe('[正确性] Correctness', () => {
  it('创建 + 查询 Agent', async () => {
    const res = await createAgent();
    expect(res.statusCode).toBe(201);
    const agent = res.json();
    expect(agent.name).toBe('test-agent');
    expect(agent.verificationLevel).toBe('unverified');

    const get = await app.inject({ method: 'GET', url: `/agents/${agent.id}` });
    expect(get.statusCode).toBe(200);
    expect(get.json().name).toBe('test-agent');
  });

  it('全失败证据 → 证据本身贡献 0 分（reliability 含重现性加成，一期新口径）', async () => {
    const agent = (await createAgent('fail-agent')).json();
    await app.inject({ method: 'POST', url: `/agents/${agent.id}/evidence`, payload: { dimension: 'reliability', source: 'simulation', result: 'failure' } });
    await app.inject({ method: 'POST', url: `/agents/${agent.id}/evidence`, payload: { dimension: 'reliability', source: 'simulation', result: 'failure' } });
    const res = await app.inject({ method: 'POST', url: `/agents/${agent.id}/score` });
    // 2026-09-27 一期 reliability 激活后期望值手工重算（plan 任务 3 Step 4）：
    // 两次 POST /evidence 内部各触发一次重算并留一条 score=0 快照（evidence.ts:72）→
    // 第 3 次计算取到同版本相邻零漂移历史 [0,0] → cons=100 →
    // reliability = round2(0.5×0（全失败证据分）+ 0.5×100) = 50 →
    // v0.3 覆盖置信系数：cov=0.2（仅 reliability 维）→ 系数 0.6 → 总分 = round(0.2×50×10×0.6) = 60。
    // 失败证据本身仍贡献 0 分，加成来自快照重现性（不是失败证据得分）。
    expect(res.json().score).toBe(60);
    const rel = res.json().dimensions.find((d: { dimension: string }) => d.dimension === 'reliability');
    expect(rel.evidenceCount).toBe(2); // 失败证据计入计数（证据分 0）
  });
});

describe('[鲁棒性] Robustness — 输入校验', () => {
  it('缺 name → 400', async () => {
    const res = await app.inject({ method: 'POST', url: '/agents', payload: {} });
    expect(res.statusCode).toBe(400);
  });

  it('重名 → 409', async () => {
    await createAgent();
    const res = await createAgent();
    expect(res.statusCode).toBe(409);
  });

  it('非法维度 → 422', async () => {
    const agent = (await createAgent()).json();
    const res = await app.inject({
      method: 'POST',
      url: `/agents/${agent.id}/evidence`,
      payload: { dimension: 'not_a_dimension', result: 'success' },
    });
    expect(res.statusCode).toBe(422);
  });

  it('非法 result → 422', async () => {
    const agent = (await createAgent()).json();
    const res = await app.inject({
      method: 'POST',
      url: `/agents/${agent.id}/evidence`,
      payload: { dimension: 'capability', result: 'boom' },
    });
    expect(res.statusCode).toBe(422);
  });

  it('不存在的 agent 提交 evidence → 404', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/agents/nope/evidence',
      payload: { dimension: 'capability', result: 'success' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('不存在的 agent 查 score → 404', async () => {
    const res = await app.inject({ method: 'GET', url: '/agents/nope/score' });
    expect(res.statusCode).toBe(404);
  });
});

describe('[可解释性] Explainability — 可追溯', () => {
  it('score.evidenceRefs 与提交的 evidence id 一一对应', async () => {
    const agent = (await createAgent('trace-agent')).json();
    const ids: string[] = [];
    for (const d of ['capability', 'reliability', 'delivery']) {
      const r = await app.inject({ method: 'POST', url: `/agents/${agent.id}/evidence`, payload: { dimension: d, source: 'simulation', result: 'success' } });
      ids.push(r.json().evidence.id);
    }
    const res = await app.inject({ method: 'POST', url: `/agents/${agent.id}/score` });
    const body = res.json();
    expect(body.evidenceCount).toBe(3);
    expect(body.evidenceRefs.sort()).toEqual(ids.sort());
  });
});

describe('[确定性] Determinism + [持久化] Persistence', () => {
  it('落库后重复 GET score 返回一致', async () => {
    const agent = (await createAgent('persist-agent')).json();
    for (const ev of [
      { dimension: 'capability', source: 'simulation', result: 'success' },
      { dimension: 'reliability', source: 'simulation', result: 'success' },
      { dimension: 'delivery', source: 'simulation', result: 'success' },
    ]) {
      await app.inject({ method: 'POST', url: `/agents/${agent.id}/evidence`, payload: ev });
    }
    const posted = await app.inject({ method: 'POST', url: `/agents/${agent.id}/score` });
    expect(posted.statusCode).toBe(200);
    const body = posted.json();
    expect(body.score).not.toBeNull();
    expect(body.modelVersion).toBe('baseline-v0.3');
    expect(body.confidence).toBeGreaterThan(0);

    const again = await app.inject({ method: 'GET', url: `/agents/${agent.id}/score` });
    expect(again.json().score).toBe(body.score);
    expect(again.json().evidenceRefs).toEqual(body.evidenceRefs);
  });
});

describe('[自动更新] P0-9 Reputation Engine — 事件驱动分数', () => {
  it('提交 evidence 后自动重算分数（无需手动 POST /score）', async () => {
    const agent = (await createAgent('auto-agent')).json();
    const r = await app.inject({
      method: 'POST',
      url: `/agents/${agent.id}/evidence`,
      payload: { dimension: 'capability', source: 'simulation', result: 'success' },
    });
    expect(r.statusCode).toBe(201);
    const body = r.json();
    expect(body.evidence).toBeDefined();
    expect(body.score).toBeDefined();
    expect(body.score.score).not.toBeNull();

    // 分数已落库：GET 返回一致（分数可追踪变化）
    const get = await app.inject({ method: 'GET', url: `/agents/${agent.id}/score` });
    expect(get.statusCode).toBe(200);
    expect(get.json().score).toBe(body.score.score);
  });
});
