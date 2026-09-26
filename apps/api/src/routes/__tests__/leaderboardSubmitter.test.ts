/**
 * 身份归因 T5：公开 API 出参暴露 submitter（署名）。
 *
 * 背景：ingest 已把署名写入 agents.owner（内部列名仍叫 owner，出口统一叫 submitter）。
 * 三个端点纯增量新增 `submitter: a.owner ?? null`：
 * - GET /leaderboard（手工映射行）
 * - GET /agents/:id（整行返回处加字段）
 * - GET /agents/by-name/:name（整行返回处加字段）
 *
 * 红线：纯增量——既有字段（含 owner 本身，老消费者可能引用）不删不改名。
 * 防泄漏：leaderboard_visible=false 的隐藏号不出榜（署名不得借榜单绕过可见性开关）。
 *
 * 测试库只用 TEST_DATABASE_URL（acl_test），生产库零接触。
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app';
import { createDb, type Database } from '../../db/client';
import { migrate } from '../../db/migrate';
import { agents } from '../../db/schema';

const TEST_URL = process.env.TEST_DATABASE_URL;
if (!TEST_URL) throw new Error('TEST_DATABASE_URL 未设置');

let app: FastifyInstance;
let db: Database;

const OWNERED_ID = 'ag-sub-owner';
const OWNERED_NAME = 'submitter-owner';
const ANON_ID = 'ag-sub-anon';
const ANON_NAME = 'submitter-anon';
const HIDDEN_ID = 'ag-sub-hidden';
const HIDDEN_NAME = 'submitter-hidden';

interface LbRow {
  agentId: string;
  submitter: string | null;
}

async function lb(): Promise<LbRow[]> {
  const res = await app.inject({ method: 'GET', url: '/leaderboard' });
  expect(res.statusCode).toBe(200);
  return res.json() as LbRow[];
}

beforeAll(async () => {
  await migrate(TEST_URL);
  db = createDb(TEST_URL);
  app = buildApp(db);
  await db.execute(
    sql`TRUNCATE arena_events, arena_sessions, agents, ingest_nonces, credit_scores, score_snapshots, evidence CASCADE`,
  );

  await db.insert(agents).values([
    // 有署名：三个端点都应透出 submitter='jeremy'（无 pubkey → source='manual'，可进榜）
    { id: OWNERED_ID, name: OWNERED_NAME, owner: 'jeremy', status: 'active', verificationLevel: 'basic' },
    // 无署名：submitter 必须是 null（不是 undefined/空串）
    { id: ANON_ID, name: ANON_NAME, owner: null, status: 'active', verificationLevel: 'basic' },
    // 隐藏号（有署名但 opt-out）：绝不出榜，署名不得借榜单泄漏
    {
      id: HIDDEN_ID,
      name: HIDDEN_NAME,
      owner: 'jeremy',
      status: 'active',
      verificationLevel: 'basic',
      leaderboardVisible: false,
    },
  ]);
});

afterAll(async () => {
  await app?.close();
  const client = (db as unknown as { $client?: { end: () => Promise<void> } }).$client;
  await client?.end();
});

describe('GET /leaderboard 暴露 submitter', () => {
  it("有署名 → 行内 submitter:'jeremy'", async () => {
    const rows = await lb();
    const row = rows.find((r) => r.agentId === OWNERED_ID);
    expect(row).toBeDefined();
    expect(row!.submitter).toBe('jeremy');
  });

  it('无署名 → submitter:null', async () => {
    const rows = await lb();
    const row = rows.find((r) => r.agentId === ANON_ID);
    expect(row).toBeDefined();
    expect(row!.submitter).toBeNull();
  });

  it('隐藏号（leaderboard_visible=false）不出榜——署名不得绕过可见性开关', async () => {
    const rows = await lb();
    expect(rows.find((r) => r.agentId === HIDDEN_ID)).toBeUndefined();
  });
});

describe('GET /agents/:id 暴露 submitter（纯增量）', () => {
  it("有署名 → submitter:'jeremy'，且既有 owner 字段仍在（老消费者不破坏）", async () => {
    const res = await app.inject({ method: 'GET', url: `/agents/${OWNERED_ID}` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { submitter?: string | null; owner?: string | null };
    expect(body.submitter).toBe('jeremy');
    expect(body.owner).toBe('jeremy');
  });

  it('无署名 → submitter:null', async () => {
    const res = await app.inject({ method: 'GET', url: `/agents/${ANON_ID}` });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { submitter: string | null }).submitter).toBeNull();
  });
});

describe('GET /agents/by-name/:name 暴露 submitter（纯增量）', () => {
  it("有署名 → submitter:'jeremy'，且既有 owner 字段仍在", async () => {
    const res = await app.inject({ method: 'GET', url: `/agents/by-name/${OWNERED_NAME}` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { submitter?: string | null; owner?: string | null };
    expect(body.submitter).toBe('jeremy');
    expect(body.owner).toBe('jeremy');
  });

  it('无署名 → submitter:null', async () => {
    const res = await app.inject({ method: 'GET', url: `/agents/by-name/${ANON_NAME}` });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { submitter: string | null }).submitter).toBeNull();
  });
});
