/**
 * 密钥即身份：同名 agent 补绑 pubkey（dogfood 2026-09-01 发现的 401 bug）。
 * 复现路径：POST /agents 创建无密钥 agent → /arena/register 同名+密钥（CLI 提示"同钥复用"）
 * → 发事件 401 "pubkey 与 agent 注册密钥不符"（pubkey 从未绑定）。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { ensureKeypair, signPayload } from 'agent-to-trust';
import { buildApp } from '../../app';
import { createDb, type Database } from '../../db/client';
import { migrate } from '../../db/migrate';
import { agents } from '../../db/schema';

const TEST_URL = process.env.TEST_DATABASE_URL;
if (!TEST_URL) throw new Error('TEST_DATABASE_URL 未设置');

let app: FastifyInstance;
let db: Database;
let keys: ReturnType<typeof ensureKeypair>;
let dirs: string[] = [];

beforeAll(async () => {
  await migrate(TEST_URL);
  db = createDb(TEST_URL);
  app = buildApp(db);
  await db.execute(
    sql`TRUNCATE arena_events, arena_sessions, agents, ingest_nonces CASCADE`,
  );
  const d = mkdtempSync(join(tmpdir(), 'a2t-identity-'));
  dirs = [d];
  keys = ensureKeypair(d);
});

afterAll(async () => {
  await app?.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe('upsertAgentIdentity 同名补绑 pubkey', () => {
  it('无密钥 agent 同名 arena 注册后必须绑定 pubkey，事件验签通过（端到端）', async () => {
    // 1) 普通注册（无密钥）——dogfood 场景：先 POST /agents 再跑 CLI
    const reg = await app.inject({
      method: 'POST',
      url: '/agents',
      payload: { name: 'legacy-agent' },
    });
    expect(reg.statusCode).toBe(201);
    const agentId = reg.json().id;

    // 2) Arena 同名注册 + 密钥 → 复用 agentId 且必须补绑 pubkey
    const arena = await app.inject({
      method: 'POST',
      url: '/arena/register',
      payload: { name: 'legacy-agent', pubkey: keys.publicKeyPem },
    });
    expect(arena.statusCode).toBe(201);
    expect(arena.json().agentId).toBe(agentId);

    const [row] = await db.select().from(agents).where(eq(agents.id, agentId));
    expect(row?.pubkey).toBe(keys.publicKeyPem);
    expect(row?.verificationLevel).toBe('basic');

    // 3) 端到端：建会话 → 该身份发事件 → 不得 401
    const sess = await app.inject({
      method: 'POST',
      url: '/arena/sessions',
      payload: { scenario: 'e2e-identity', buyerAgentId: agentId },
    });
    expect(sess.statusCode).toBe(201);
    const sid = sess.json().id;

    const envelope = {
      sessionId: sid,
      seq: 1,
      type: 'OFFER',
      fromAgent: agentId,
      payload: { price: 10 },
      nonce: `n-${randomUUID()}`,
      ts: Date.now(),
    };
    const ev = await app.inject({
      method: 'POST',
      url: `/arena/sessions/${sid}/events`,
      payload: {
        ...envelope,
        sig: signPayload(keys.privateKeyPem, envelope),
        pubkey: keys.publicKeyPem,
      },
    });
    expect(ev.statusCode).toBe(201);
  });

  it('已绑钥 agent 换钥注册 → 403 name-taken（钥不可被覆盖）', async () => {
    const d = mkdtempSync(join(tmpdir(), 'a2t-identity-2-'));
    dirs.push(d);
    const other = ensureKeypair(d);
    const dup = await app.inject({
      method: 'POST',
      url: '/arena/register',
      payload: { name: 'legacy-agent', pubkey: other.publicKeyPem },
    });
    expect(dup.statusCode).toBe(403);
  });
});

describe('Task 2 迁移：agents.name_normalized + verify_challenges', () => {
  it('agents.name_normalized 列存在', async () => {
    const res = await db.execute(
      sql`SELECT 1 FROM information_schema.columns WHERE table_name = 'agents' AND column_name = 'name_normalized'`,
    );
    expect(res.rows).toHaveLength(1);
  });

  it('uq_agents_name_normalized 部分唯一索引存在（WHERE name_normalized IS NOT NULL）', async () => {
    const res = await db.execute(
      sql`SELECT indexdef FROM pg_indexes WHERE tablename = 'agents' AND indexname = 'uq_agents_name_normalized'`,
    );
    expect(res.rows).toHaveLength(1);
    const def = String((res.rows[0] as { indexdef: string }).indexdef);
    expect(def).toContain('UNIQUE');
    expect(def).toContain('(name_normalized) WHERE (name_normalized IS NOT NULL)');
  });

  it('verify_challenges 表存在（challenge/agent_id/created_at）', async () => {
    const res = await db.execute(
      sql`SELECT column_name FROM information_schema.columns WHERE table_name = 'verify_challenges' ORDER BY ordinal_position`,
    );
    const names = res.rows.map((r) => String((r as { column_name: string }).column_name));
    expect(names).toEqual(expect.arrayContaining(['challenge', 'agent_id', 'created_at']));
  });

  it('部分唯一索引语义：非空归一化名冲突 23505；NULL 不入索引可共存', async () => {
    // 用裸 pg Pool 断言错误码（drizzle 0.38 会把 pg 错误包一层，裸驱动拿 code 最直接）
    const { Pool } = await import('pg');
    const pool = new Pool({ connectionString: TEST_URL });
    const a = `uq-a-${randomUUID()}`;
    const b = `uq-b-${randomUUID()}`;
    await pool.query('INSERT INTO agents (id, name, name_normalized) VALUES ($1, $2, $3)', [
      a,
      a,
      'dup-target',
    ]);
    await expect(
      pool.query('INSERT INTO agents (id, name, name_normalized) VALUES ($1, $2, $3)', [
        b,
        b,
        'dup-target',
      ]),
    ).rejects.toMatchObject({ code: '23505' });
    // 部分索引：NULL 不受约束，多行共存
    const c = `uq-null1-${randomUUID()}`;
    const d = `uq-null2-${randomUUID()}`;
    await pool.query('INSERT INTO agents (id, name) VALUES ($1, $1)', [c]);
    await pool.query('INSERT INTO agents (id, name) VALUES ($1, $1)', [d]);
    // 清理自插数据，不污染后续用例
    await pool.query('DELETE FROM agents WHERE id = ANY($1)', [[a, b, c, d]]);
    await pool.end();
  });
});
