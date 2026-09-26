/**
 * /verify 三端点（身份归因 Task 7）：
 * ① GET /verify/:ref 轻验证（badge 消费方对账）
 * ② POST /verify/challenge 认领挑战（5 分钟一次性）
 * ③ POST /verify/claim 密钥验签认领（签名用**库里公钥**，绝不接受请求带钥）
 *
 * 测试库只用 TEST_DATABASE_URL（acl_test），生产库零接触。
 * 每个用例单独 buildApp：createRateLimiter 桶挂在插件实例上，claim 5/min/IP
 * 限流下多用例共享一个 app 会互相吃额度。
 */
import { mkdtempSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { ensureKeypair, signPayload } from 'agent-to-trust';
import { buildApp } from '../../app';
import { createDb, type Database } from '../../db/client';
import { migrate } from '../../db/migrate';
import { agents, creditScores, evidence, verifyChallenges } from '../../db/schema';

const TEST_URL = process.env.TEST_DATABASE_URL;
if (!TEST_URL) throw new Error('TEST_DATABASE_URL 未设置');

let db: Database;

/** 每用例独立 app 实例 → 独立限流桶，互不串额度。 */
function newApp(): FastifyInstance {
  return buildApp(db);
}

let keypair: { publicKeyPem: string; privateKeyPem: string };

/** 直插一个带公钥的 agent（绕过 ingest，聚焦 /verify 自身逻辑）。 */
async function seedAgent(opts: {
  id: string;
  name: string;
  pubkey?: string | null;
  owner?: string | null;
  verificationLevel?: string;
}) {
  await db.insert(agents).values({
    id: opts.id,
    name: opts.name,
    owner: opts.owner ?? null,
    status: 'active',
    verificationLevel: opts.verificationLevel ?? 'basic',
    pubkey: opts.pubkey ?? null,
  });
  return opts;
}

/** 直插一条评分（createdAt 可指定，验证「取最新一条」）。 */
async function seedScore(agentId: string, score: number, createdAt?: Date) {
  await db.insert(creditScores).values({
    id: `cs-${agentId}-${score}-${createdAt?.getTime() ?? 'now'}`,
    agentId,
    score,
    confidence: 1,
    coverage: 1,
    modelVersion: 'test',
    ...(createdAt ? { createdAt } : {}),
  });
}

async function seedEvidence(agentId: string, n: number) {
  for (let i = 0; i < n; i++) {
    await db.insert(evidence).values({
      id: `ev-${agentId}-${i}`,
      agentId,
      dimension: 'capability',
      result: 'success',
      value: 0.5,
    });
  }
}

function makeChallenge(app: FastifyInstance, ref: string) {
  return app.inject({ method: 'POST', url: '/verify/challenge', payload: { ref } });
}

/** 按契约签名体（canonical JSON 由 signPayload 内部排序处理）。 */
/** 用契约签名体签名（agentId 由调用方给服务端解析出的 id）。 */
function signClaim(
  privateKeyPem: string,
  agentId: string,
  challenge: string,
  submitter: string | null,
  timestamp: number,
): string {
  return signPayload(privateKeyPem, { action: 'claim', agentId, challenge, submitter, timestamp });
}

function postClaim(
  app: FastifyInstance,
  ref: string,
  agentId: string,
  challenge: string,
  opts: { submitter?: string; timestamp?: number; key?: { privateKeyPem: string } } = {},
) {
  const timestamp = opts.timestamp ?? Date.now();
  const signature = signClaim(
    opts.key?.privateKeyPem ?? keypair.privateKeyPem,
    agentId,
    challenge,
    opts.submitter ?? null,
    timestamp,
  );
  return app.inject({
    method: 'POST',
    url: '/verify/claim',
    payload: {
      ref,
      challenge,
      ...(opts.submitter !== undefined ? { submitter: opts.submitter } : {}),
      signature,
      timestamp,
    },
  });
}

beforeAll(async () => {
  await migrate(TEST_URL);
  db = createDb(TEST_URL);
  await db.execute(
    sql`TRUNCATE evidence, credit_scores, score_snapshots, agents, verify_challenges, ingest_nonces CASCADE`,
  );
  keypair = ensureKeypair(mkdtempSync(join(tmpdir(), 'a2t-api-verify-')));
});

afterAll(async () => {
  const client = (db as unknown as { $client?: { end: () => Promise<void> } }).$client;
  await client?.end();
});

describe('GET /verify/:ref', () => {
  it('按 name 命中：字段齐全、指纹 16 hex、score 取最新、evidenceCount 正确', async () => {
    const app = newApp();
    const a = await seedAgent({
      id: 'ag-verify-get',
      name: 'VerifyGet',
      pubkey: keypair.publicKeyPem,
      owner: 'getowner',
    });
    await seedEvidence(a.id, 2);
    await seedScore(a.id, 60, new Date(Date.now() - 60_000));
    await seedScore(a.id, 88);

    const res = await app.inject({ method: 'GET', url: '/verify/VerifyGet' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body.agentId).toBe('ag-verify-get');
    expect(body.name).toBe('VerifyGet');
    expect(body.submitter).toBe('getowner');
    expect(body.verificationLevel).toBe('basic');
    expect(body.pubkeyFingerprint).toBe(
      createHash('sha256').update(keypair.publicKeyPem).digest('hex').slice(0, 16),
    );
    expect(body.pubkeyFingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(body.score).toBe(88); // 最新一条，不是最高也不是第一条
    expect(body.evidenceCount).toBe(2);
    expect(typeof body.createdAt).toBe('string');
    await app.close();
  });

  it('按 agentId 也能命中；无公钥 agent 指纹为 null；未知 ref 404', async () => {
    const app = newApp();
    await seedAgent({ id: 'ag-verify-nokey', name: 'VerifyNoKey', pubkey: null });

    const byId = await app.inject({ method: 'GET', url: '/verify/ag-verify-nokey' });
    expect(byId.statusCode).toBe(200);
    expect((byId.json() as Record<string, unknown>).pubkeyFingerprint).toBeNull();
    expect((byId.json() as Record<string, unknown>).submitter).toBeNull();
    expect((byId.json() as Record<string, unknown>).score).toBeNull();
    expect((byId.json() as Record<string, unknown>).evidenceCount).toBe(0);

    const missing = await app.inject({ method: 'GET', url: '/verify/nobody-here' });
    expect(missing.statusCode).toBe(404);
    await app.close();
  });
});

describe('POST /verify/challenge', () => {
  it('200：challenge 入库（5 分钟有效）、返回形态正确', async () => {
    const app = newApp();
    const a = await seedAgent({
      id: 'ag-verify-chal',
      name: 'VerifyChal',
      pubkey: keypair.publicKeyPem,
    });
    const res = await makeChallenge(app, 'VerifyChal');
    expect(res.statusCode).toBe(200);
    const body = res.json() as { challenge: string; agentId: string; name: string; expiresAt: string };
    expect(body.challenge).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(body.agentId).toBe(a.id);
    expect(body.name).toBe('VerifyChal');
    const row = await db.query.verifyChallenges.findFirst({
      where: eq(verifyChallenges.challenge, body.challenge),
    });
    expect(row?.agentId).toBe(a.id);
    const expiresAt = new Date(body.expiresAt).getTime();
    expect(expiresAt - Date.now()).toBeGreaterThan(4 * 60_000);
    expect(expiresAt - Date.now()).toBeLessThanOrEqual(5 * 60_000);
    await app.close();
  });

  it('无公钥 422（不可认领）；未知 ref 404', async () => {
    const app = newApp();
    await seedAgent({ id: 'ag-verify-chal-nokey', name: 'VerifyChalNoKey', pubkey: null });
    const nokey = await makeChallenge(app, 'VerifyChalNoKey');
    expect(nokey.statusCode).toBe(422);

    const missing = await makeChallenge(app, 'ghost-agent');
    expect(missing.statusCode).toBe(404);
    await app.close();
  });
});

describe('POST /verify/claim', () => {
  it('带 submitter 成功：owner 落库、submitterSet true、challenge 一次性删除', async () => {
    const app = newApp();
    const a = await seedAgent({
      id: 'ag-verify-claim',
      name: 'VerifyClaim',
      pubkey: keypair.publicKeyPem,
    });
    const ch = await makeChallenge(app, 'ag-verify-claim');
    const { challenge } = ch.json() as { challenge: string };

    const res = await postClaim(app, 'VerifyClaim', a.id, challenge, { submitter: 'Alice' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { verified: boolean; agentId: string; name: string; submitterSet: boolean; submitter: string | null };
    expect(body.verified).toBe(true);
    expect(body.agentId).toBe(a.id);
    expect(body.name).toBe('VerifyClaim');
    expect(body.submitterSet).toBe(true);
    expect(body.submitter).toBe('alice'); // normalizeHandle 去大写
    const agent = await db.query.agents.findFirst({ where: eq(agents.id, a.id) });
    expect(agent?.owner).toBe('alice');

    const left = await db.query.verifyChallenges.findFirst({
      where: eq(verifyChallenges.challenge, challenge),
    });
    expect(left).toBeUndefined(); // 一次性
    await app.close();
  });

  it('无 submitter 纯自证：verified true、submitterSet false、owner 不动', async () => {
    const app = newApp();
    const a = await seedAgent({
      id: 'ag-verify-self',
      name: 'VerifySelf',
      pubkey: keypair.publicKeyPem,
      owner: 'original-owner',
    });
    const ch = await makeChallenge(app, 'ag-verify-self');
    const { challenge } = ch.json() as { challenge: string };

    const res = await postClaim(app, 'VerifySelf', a.id, challenge);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { verified: boolean; submitterSet: boolean };
    expect(body.verified).toBe(true);
    expect(body.submitterSet).toBe(false);
    const agent = await db.query.agents.findFirst({ where: eq(agents.id, a.id) });
    expect(agent?.owner).toBe('original-owner'); // D8：不动 owner
    await app.close();
  });

  it('错签 401，challenge 保留（允许改错重试）', async () => {
    const app = newApp();
    const a = await seedAgent({
      id: 'ag-verify-badsig',
      name: 'VerifyBadSig',
      pubkey: keypair.publicKeyPem,
    });
    const ch = await makeChallenge(app, 'ag-verify-badsig');
    const { challenge } = ch.json() as { challenge: string };

    const other = ensureKeypair(mkdtempSync(join(tmpdir(), 'a2t-api-verify-other-')));
    const res = await postClaim(app, 'VerifyBadSig', a.id, challenge, { key: other });
    expect(res.statusCode).toBe(401);
    const left = await db.query.verifyChallenges.findFirst({
      where: eq(verifyChallenges.challenge, challenge),
    });
    expect(left).toBeDefined(); // 验签失败不删，限频兜底
    await app.close();
  });

  it('过期 challenge（created_at 6 分钟前）→ 409', async () => {
    const app = newApp();
    const a = await seedAgent({
      id: 'ag-verify-expired',
      name: 'VerifyExpired',
      pubkey: keypair.publicKeyPem,
    });
    const ch = await makeChallenge(app, 'ag-verify-expired');
    const { challenge } = ch.json() as { challenge: string };
    await db.execute(
      sql`UPDATE verify_challenges SET created_at = now() - interval '6 minutes' WHERE challenge = ${challenge}`,
    );

    const res = await postClaim(app, 'VerifyExpired', a.id, challenge);
    expect(res.statusCode).toBe(409);
    await app.close();
  });

  it('challenge 复用（首次成功后再用）→ 409', async () => {
    const app = newApp();
    const a = await seedAgent({
      id: 'ag-verify-reuse',
      name: 'VerifyReuse',
      pubkey: keypair.publicKeyPem,
    });
    const ch = await makeChallenge(app, 'ag-verify-reuse');
    const { challenge } = ch.json() as { challenge: string };

    const first = await postClaim(app, 'VerifyReuse', a.id, challenge, { submitter: 'reuseowner' });
    expect(first.statusCode).toBe(200);
    const second = await postClaim(app, 'VerifyReuse', a.id, challenge, { submitter: 'reuseowner' });
    expect(second.statusCode).toBe(409);
    await app.close();
  });

  it('submitter 被别的 agent 占用 → 409', async () => {
    const app = newApp();
    await seedAgent({
      id: 'ag-verify-squatter',
      name: 'VerifySquatter',
      pubkey: keypair.publicKeyPem,
      owner: 'takenhandle',
    });
    const a = await seedAgent({
      id: 'ag-verify-taken',
      name: 'VerifyTaken',
      pubkey: keypair.publicKeyPem,
    });
    const ch = await makeChallenge(app, 'ag-verify-taken');
    const { challenge } = ch.json() as { challenge: string };

    const res = await postClaim(app, 'VerifyTaken', a.id, challenge, { submitter: 'takenhandle' });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: string }).error).toContain('占用');
    await app.close();
  });

  it('owner 冲突（已有 owner 且不同）→ 409（D8：owner 不可抢）', async () => {
    const app = newApp();
    const a = await seedAgent({
      id: 'ag-verify-conflict',
      name: 'VerifyConflict',
      pubkey: keypair.publicKeyPem,
      owner: 'first-owner',
    });
    const ch = await makeChallenge(app, 'ag-verify-conflict');
    const { challenge } = ch.json() as { challenge: string };

    const res = await postClaim(app, 'VerifyConflict', a.id, challenge, {
      submitter: 'second-owner',
    });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: string }).error).toContain('不可变更');
    const agent = await db.query.agents.findFirst({ where: eq(agents.id, a.id) });
    expect(agent?.owner).toBe('first-owner');
    await app.close();
  });

  it('非法 submitter（带空格）→ 422', async () => {
    const app = newApp();
    const a = await seedAgent({
      id: 'ag-verify-badhandle',
      name: 'VerifyBadHandle',
      pubkey: keypair.publicKeyPem,
    });
    const ch = await makeChallenge(app, 'ag-verify-badhandle');
    const { challenge } = ch.json() as { challenge: string };

    const res = await postClaim(app, 'VerifyBadHandle', a.id, challenge, {
      submitter: 'bad handle',
    });
    expect(res.statusCode).toBe(422);
    expect((res.json() as { error: string }).error).toContain('署名');
    await app.close();
  });
});
