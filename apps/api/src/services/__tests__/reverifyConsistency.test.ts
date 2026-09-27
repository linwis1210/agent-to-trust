import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { buildIngestPayload, ensureKeypair, runSuite } from 'agent-to-trust';
import { buildApp } from '../../app';
import { createDb, type Database } from '../../db/client';
import { migrate } from '../../db/migrate';
import { reverifyAgent } from '../reverify';
import { evidence } from '../../db/schema';

/**
 * reverify 的言行一致证据——**真集成**测试（一期 Integrity 第四通道）。
 *
 * 口径：服务端用同版本题集重放 endpoint，能复现宣称成绩 → integrity/success 证据；
 * 复现不了 → integrity/failure（或 partial）证据；不可达 / 无 endpoint → 不落行。
 * append-only 防刷屏：与该 agent 最新一行 reverify 证据同 result → 跳过。
 *
 * DB 红线：只连 acl_test（TEST_DATABASE_URL），绝不碰生产 acl 库。
 */
const TEST_URL = process.env.TEST_DATABASE_URL;
if (!TEST_URL) throw new Error('TEST_DATABASE_URL 未设置');

let app: FastifyInstance;
let db: Database;
let keypair: { publicKeyPem: string; privateKeyPem: string };

// 审计 A4 后 endpoint 必须是公网 http(s)（127.0.0.1 会被 isPublicEndpoint 拒），
// 因此用公网域名 + 注入 fetch stub。
const CASE_IDS: string[] = ['coding-sum', 'reasoning-sequence'];

const CONSISTENT = 'https://rv-cons.example.com/consistent';
const INCONSISTENT = 'https://rv-cons.example.com/inconsistent';
const UNREACHABLE = 'https://rv-cons.example.com/unreachable';

/** 按 prompt 路由「客观题正确答案」。 */
function correctAnswerFor(prompt: string): string {
  if (prompt.includes('reduce((a, b)')) return 'The answer is 10.';
  if (prompt.includes('2, 4, 8, 16')) return 'The answer is 32.';
  throw new Error(`fixture 未覆盖的 prompt：${prompt.slice(0, 80)}`);
}

/** inconsistent=true 时 coding-sum 答错（reasoning-sequence 仍对 → 部分匹配率 0.5）。 */
function replyFor(prompt: string, inconsistent: boolean): string {
  if (prompt.includes('reduce((a, b)')) {
    return inconsistent ? 'The answer is 999.' : correctAnswerFor(prompt);
  }
  if (prompt.includes('2, 4, 8, 16')) return correctAnswerFor(prompt);
  throw new Error(`fixture 未覆盖的 prompt：${prompt.slice(0, 80)}`);
}

/**
 * fetch stub：URL 含 /inconsistent → 客观题答错一份；/unreachable → 直接抛错（模拟不可达）。
 */
const fetchSpy = vi.fn(async (input: string, init?: RequestInit) => {
  const url = String(input);
  if (url.includes('/unreachable')) throw new Error('ECONNREFUSED（测试模拟）');
  const body = JSON.parse(String(init?.body ?? '{}')) as {
    messages?: { content?: string }[];
  };
  const prompt = body.messages?.[0]?.content ?? '';
  const answer = replyFor(prompt, url.includes('/inconsistent'));
  return new Response(JSON.stringify({ choices: [{ message: { content: answer } }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
});

/** 本地跑客观题 → 签名上报（上报值 = 全对）→ 返回 agentId。 */
async function ingestBaseline(name: string, endpoint: string): Promise<string> {
  const suite = await runSuite({ reply: async (prompt) => correctAnswerFor(prompt) }, {
    filter: (id) => CASE_IDS.includes(id),
  });
  expect(suite.results.length).toBe(CASE_IDS.length);
  const payload = buildIngestPayload(suite, { name, endpoint }, keypair);
  const res = await app.inject({ method: 'POST', url: '/ingest/results', payload });
  expect(res.statusCode).toBe(200);
  return (res.json() as { agentId: string }).agentId;
}

/** 取该 agent 的 reverify 言行一致证据行（新→旧）。 */
async function consistencyRows(agentId: string) {
  return db.query.evidence.findMany({
    where: and(
      eq(evidence.agentId, agentId),
      eq(evidence.evidenceUri, 'a2t://reverify/consistency'),
    ),
    orderBy: [sql`created_at DESC` as never],
  });
}

beforeAll(async () => {
  vi.stubGlobal('fetch', fetchSpy);
  await migrate(TEST_URL);
  db = createDb(TEST_URL);
  app = buildApp(db);
  await db.execute(
    sql`TRUNCATE evidence, credit_scores, score_snapshots, agents, ingest_nonces CASCADE`,
  );
  keypair = ensureKeypair(mkdtempSync(join(tmpdir(), 'a2t-rv-cons-')));
});

afterAll(async () => {
  await app.close();
  vi.unstubAllGlobals();
  const client = (db as unknown as { $client?: { end: () => Promise<void> } }).$client;
  await client?.end();
});

describe('reverifyAgent × 言行一致证据', () => {
  it('1) endpoint 复算与上报一致 → verified + integrity/success 证据行', async () => {
    const id = await ingestBaseline('rv-cons-success', CONSISTENT);
    expect(await reverifyAgent(app, id)).toBe('verified');
    const rows = await consistencyRows(id);
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({
      dimension: 'integrity',
      source: 'verified',
      sourceType: 'verified',
      issuer: 'server-reverify',
      evidenceUri: 'a2t://reverify/consistency',
      result: 'success',
      value: 1,
    });
  });

  it('2) endpoint 复算与上报不一致 → basic + failure（部分匹配 → partial）证据行', async () => {
    // 两题对一题：匹配率 0.5 → partial；verificationLevel 保持 basic。
    const id = await ingestBaseline('rv-cons-partial', INCONSISTENT);
    expect(await reverifyAgent(app, id)).toBe('basic');
    const rows = await consistencyRows(id);
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({
      dimension: 'integrity',
      issuer: 'server-reverify',
      result: 'partial',
      value: 0.5,
    });
    const agent = await db.query.agents.findFirst({ where: sql`id = ${id}` as never });
    expect(agent?.verificationLevel).toBe('basic');
  });

  it('3) 连续两次 reverify 结果状态未变 → 第二次不新增行（append-only 防刷屏）', async () => {
    const id = await ingestBaseline('rv-cons-appendonly', INCONSISTENT);
    expect(await reverifyAgent(app, id)).toBe('basic');
    expect(await reverifyAgent(app, id)).toBe('basic');
    const rows = await consistencyRows(id);
    expect(rows.length).toBe(1);
  });

  it('4) endpoint 不可达 → basic 且不落行（下线是 reliability 语义）', async () => {
    const id = await ingestBaseline('rv-cons-unreachable', UNREACHABLE);
    expect(await reverifyAgent(app, id)).toBe('basic');
    expect((await consistencyRows(id)).length).toBe(0);
  });

  it('5) 无 endpoint 的 agent → basic 且不落行（既有行为不回退）', async () => {
    // 直接建一个无 endpoint 的 agent（reverify 在 endpoint 检查处就应返回 basic）。
    const res = await app.inject({
      method: 'POST',
      url: '/agents',
      payload: { name: 'rv-cons-no-endpoint' },
    });
    expect(res.statusCode).toBe(201);
    const { id: agentId } = res.json() as { id: string };
    expect(await reverifyAgent(app, agentId)).toBe('basic');
    expect((await consistencyRows(agentId)).length).toBe(0);
  });
});
