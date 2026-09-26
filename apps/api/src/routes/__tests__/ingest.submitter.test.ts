/**
 * Task 3（身份归因）：ingest 接线署名（submitter）+ 归一化唯一性。
 *
 * 语义裁决（owner 定稿）：
 * - submitter 过 normalizeHandle，非法 → 422；不带 = 匿名（合法）。
 * - 带 submitter 首次落库 → agents.owner = 归一化 handle。
 * - 复用分支：owner 仅在「原为空 且 本次带署名」时写入，已有 owner 永不清空（D8）。
 * - handle 已被别的 agent 占用 → 409 owner-taken（署名已被占用）。
 * - 名字唯一性判定切到归一化层：'Claude-Code' 已存 → 'claude-code' 不同钥同样 403。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { buildIngestPayload, ensureKeypair, runSuite, signPayload, type SuiteResult } from 'agent-to-trust';
import { buildApp } from '../../app';
import { createDb, type Database } from '../../db/client';
import { migrate } from '../../db/migrate';
import { agents } from '../../db/schema';

const TEST_URL = process.env.TEST_DATABASE_URL;
if (!TEST_URL) throw new Error('TEST_DATABASE_URL 未设置');

let app: FastifyInstance;
let db: Database;
let keyA: { publicKeyPem: string; privateKeyPem: string };
let keyB: { publicKeyPem: string; privateKeyPem: string };
let suiteFixture: SuiteResult;
let dirs: string[] = [];

function post(body: unknown) {
  return app.inject({ method: 'POST', url: '/ingest/results', payload: body as Record<string, unknown> });
}

/** 构造带可选 submitter 的签名 payload（submitter 不在 AgentMeta，手动附加后重签）。 */
function payloadWith(
  meta: { name: string },
  kp: { publicKeyPem: string; privateKeyPem: string },
  submitter?: string,
): Record<string, unknown> {
  const base = buildIngestPayload(suiteFixture, meta, kp);
  const { signature: _sig, ...body } = base;
  const full = submitter !== undefined ? { ...body, submitter } : body;
  return { ...full, signature: signPayload(kp.privateKeyPem, full) };
}

async function agentRow(agentId: string) {
  const [row] = await db.select().from(agents).where(eq(agents.id, agentId));
  return row;
}

beforeAll(async () => {
  await migrate(TEST_URL);
  db = createDb(TEST_URL);
  app = buildApp(db);
  await db.execute(sql`TRUNCATE evidence, credit_scores, score_snapshots, agents, ingest_nonces CASCADE`);
  const da = mkdtempSync(join(tmpdir(), 'a2t-sub-a-'));
  const dbb = mkdtempSync(join(tmpdir(), 'a2t-sub-b-'));
  dirs = [da, dbb];
  keyA = ensureKeypair(da);
  keyB = ensureKeypair(dbb);
  suiteFixture = await runSuite({ reply: async () => '10' }, { filter: (id) => id === 'coding-sum' });
});

afterAll(async () => {
  await app.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  const client = (db as unknown as { $client?: { end: () => Promise<void> } }).$client;
  await client?.end();
});

describe('POST /ingest/results submitter（署名）', () => {
  it('①带 submitter → agents.owner 落归一化 handle + name_normalized 落库', async () => {
    const res = await post(payloadWith({ name: 'sub-agent-a' }, keyA, '@Jeremy'));
    expect(res.statusCode).toBe(200);
    const row = await agentRow(res.json().agentId);
    expect(row?.owner).toBe('jeremy');
    expect(row?.nameNormalized).toBe('sub-agent-a');
  });

  it("②归一化变体名：'Claude-Code' 已存 → 'claude-code' 不同钥 403", async () => {
    const first = await post(payloadWith({ name: 'Norm-Variant' }, keyA));
    expect(first.statusCode).toBe(200);
    const second = await post(payloadWith({ name: 'norm-variant' }, keyB));
    expect(second.statusCode).toBe(403);
    expect((second.json() as { error: string }).error).toBe('该 agent 名称已被其他密钥绑定');
  });

  it('③同钥先带署名后不带重传 → owner 保持不被清空（D8）', async () => {
    const first = await post(payloadWith({ name: 'persist-agent' }, keyA, '@keeper'));
    expect(first.statusCode).toBe(200);
    const agentId = first.json().agentId;
    const second = await post(payloadWith({ name: 'persist-agent' }, keyA));
    expect(second.statusCode).toBe(200);
    const row = await agentRow(agentId);
    expect(row?.owner).toBe('keeper');
  });

  it('④两个不同 agent 抢同一 handle → 第二个 409 owner-taken', async () => {
    const first = await post(payloadWith({ name: 'handle-a' }, keyA, '@hot-handle'));
    expect(first.statusCode).toBe(200);
    // 变体写法 @HOT-HANDLE 归一化后同值，同样要拦
    const second = await post(payloadWith({ name: 'handle-b' }, keyB, '@HOT-HANDLE'));
    expect(second.statusCode).toBe(409);
    expect((second.json() as { error: string }).error).toBe('署名已被占用');
    // 抢注者不得落库
    const row = await agentRow('ext-handle-b');
    expect(row).toBeUndefined();
  });

  it('⑤非法 submitter → 422；不带 submitter → 匿名（owner null）', async () => {
    const bad = await post(payloadWith({ name: 'sub-bad' }, keyA, 'has space!'));
    expect(bad.statusCode).toBe(422);
    const anon = await post(payloadWith({ name: 'sub-anon' }, keyA));
    expect(anon.statusCode).toBe(200);
    const row = await agentRow(anon.json().agentId);
    expect(row?.owner).toBeNull();
  });
});
