/**
 * /verify 三端点 — 公开验证与认领（身份归因 Task 7，设计 §5.3）。
 *
 * ① GET /verify/:ref        轻验证：badge 消费方对账（name 精确 → agentId）。
 * ② POST /verify/challenge  认领挑战：uuid4 一次性凭证，5 分钟有效（以 created_at 计）。
 * ③ POST /verify/claim      认领/自证：Ed25519 验签（agent-to-trust verifyPayload）。
 *
 * 验签安全核心（红线）：
 * - 签名一律用**库里存的 agent.pubkey** 验，绝不接受请求携带公钥
 *   （否则任何人都可伪造，证明不了任何事）。
 * - 签名体恰好为 canonical JSON（agent-to-trust 内部排序键）：
 *     { action: 'claim', agentId, challenge, submitter: submitter ?? null, timestamp }
 *   其中 agentId 是**服务端解析 ref 得到的 id**，不是客户端口说的
 *   （T8 SDK 按此字段集对齐）。
 * - challenge 一次性：验签成功才删行；验签失败不删（限频兜底，允许改错重试）。
 *
 * D8：owner（署名）不可抢——已有 owner 且与本次 submitter 不同 → 409，联系管理员。
 */
import { createHash, randomUUID } from 'node:crypto';
import { and, desc, eq, ne, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { verifyPayload } from 'agent-to-trust';
import { agents, creditScores, evidence, verifyChallenges } from '../db/schema';
import { createRateLimiter } from '../services/rateLimit';
import { normalizeHandle } from '../services/agentIdentity';

const CHALLENGE_TTL_MS = 5 * 60_000;
// 镜像 routes/ingest.ts 的 TIMESTAMP_WINDOW_MS（未导出，本地定义同值同语义）：
// 签名时间戳允许窗口 10 分钟，超窗 409 防重放。
const TIMESTAMP_WINDOW_MS = 10 * 60_000;

export async function verifyRoutes(app: FastifyInstance) {
  // 限频（设计 §5.3）：GET 60/min/IP；challenge 5/min/IP；claim 5/min/IP。
  const getLimited = createRateLimiter({ max: 60, windowMs: 60_000 });
  const challengeLimited = createRateLimiter({ max: 5, windowMs: 60_000 });
  const claimLimited = createRateLimiter({ max: 5, windowMs: 60_000 });

  /** ref 解析：先按 name 精确查（同名取最新注册），未中再按 agentId（跟随 badge.ts 习惯）。 */
  function resolveAgent(ref: string) {
    return (async () =>
      (await app.db.query.agents.findFirst({
        where: eq(agents.name, ref),
        orderBy: [desc(agents.createdAt)],
      })) ?? (await app.db.query.agents.findFirst({ where: eq(agents.id, ref) })))();
  }

  /** sha256(pubkey) 前 16 hex；无公钥为 null（设计 §5.3 指纹口径）。 */
  function fingerprint(pubkey: string | null): string | null {
    return pubkey
      ? createHash('sha256').update(pubkey).digest('hex').slice(0, 16)
      : null;
  }

  // ① 轻验证（给 badge 消费方对账）
  app.get('/verify/:ref', async (req, reply) => {
    if (getLimited(req)) {
      return reply.code(429).send({ error: '请求过于频繁，稍后再试' });
    }
    const { ref } = req.params as { ref: string };
    const agent = await resolveAgent(ref);
    if (!agent) {
      return reply.code(404).send({ error: 'agent 不存在' });
    }
    const score = await app.db.query.creditScores.findFirst({
      where: eq(creditScores.agentId, agent.id),
      orderBy: [desc(creditScores.createdAt)],
    });
    const [counts] = await app.db
      .select({ n: sql<number>`count(*)::int` })
      .from(evidence)
      .where(eq(evidence.agentId, agent.id));
    return {
      agentId: agent.id,
      name: agent.name,
      submitter: agent.owner ?? null,
      verificationLevel: agent.verificationLevel,
      pubkeyFingerprint: fingerprint(agent.pubkey),
      score: score?.score ?? null,
      evidenceCount: counts?.n ?? 0,
      createdAt: agent.createdAt,
    };
  });

  // ② 认领挑战
  app.post('/verify/challenge', async (req, reply) => {
    if (challengeLimited(req)) {
      return reply.code(429).send({ error: '请求过于频繁，稍后再试' });
    }
    const body = req.body as { ref?: unknown } | undefined;
    const ref = typeof body?.ref === 'string' ? body.ref : '';
    if (!ref) {
      return reply.code(400).send({ error: 'ref 必填' });
    }
    const agent = await resolveAgent(ref);
    if (!agent) {
      return reply.code(404).send({ error: 'agent 不存在' });
    }
    if (!agent.pubkey) {
      return reply.code(422).send({ error: '该 agent 无公钥，不可认领' });
    }
    const challenge = randomUUID();
    await app.db.insert(verifyChallenges).values({ challenge, agentId: agent.id });
    return {
      challenge,
      agentId: agent.id,
      name: agent.name,
      expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS).toISOString(),
    };
  });

  // ③ 认领 / 自证
  app.post('/verify/claim', async (req, reply) => {
    if (claimLimited(req)) {
      return reply.code(429).send({ error: '请求过于频繁，稍后再试' });
    }
    const body = req.body as Record<string, unknown> | undefined;
    if (!body || typeof body !== 'object') {
      return reply.code(400).send({ error: '缺少请求体' });
    }
    const { ref, challenge, submitter, signature, timestamp } = body as {
      ref?: unknown;
      challenge?: unknown;
      submitter?: unknown;
      signature?: unknown;
      timestamp?: unknown;
    };
    if (typeof ref !== 'string' || !ref) {
      return reply.code(400).send({ error: 'ref 必填' });
    }
    if (typeof challenge !== 'string' || typeof signature !== 'string' || typeof timestamp !== 'number') {
      return reply.code(400).send({ error: 'challenge/signature/timestamp 必填' });
    }
    // submitter：undefined/null/空串 = 不带署名（合法，走纯自证），与 ingest 同口径。
    const rawSubmitter =
      submitter !== undefined && submitter !== null && submitter !== '' && typeof submitter === 'string'
        ? submitter
        : null;

    const agent = await resolveAgent(ref);
    if (!agent) {
      return reply.code(404).send({ error: 'agent 不存在' });
    }

    // 1) challenge 行：须绑定同一 agent、未过期（5 分钟，以 created_at 计）
    const row = await app.db.query.verifyChallenges.findFirst({
      where: eq(verifyChallenges.challenge, challenge),
    });
    if (!row || row.agentId !== agent.id) {
      return reply.code(409).send({ error: 'challenge 无效或已使用' });
    }
    if (Date.now() - row.createdAt.getTime() > CHALLENGE_TTL_MS) {
      return reply.code(409).send({ error: 'challenge 已过期' });
    }

    // 2) 时间窗（镜像 ingest TIMESTAMP_WINDOW_MS：10 分钟，防重放）
    if (Math.abs(Date.now() - timestamp) > TIMESTAMP_WINDOW_MS) {
      return reply.code(409).send({ error: 'timestamp 超出允许窗口' });
    }

    // 3) 验签：用**库里公钥**（绝不接受请求带钥）；agentId 用服务端解析的 id，
    //    签名体字段集 = { action, agentId, challenge, submitter: submitter ?? null, timestamp }（T8 SDK 对齐此契约）。
    const ok = agent.pubkey
      ? verifyPayload(
          agent.pubkey,
          {
            action: 'claim',
            agentId: agent.id,
            challenge,
            submitter: rawSubmitter,
            timestamp,
          },
          signature,
        )
      : false;
    if (!ok) {
      // 验签失败不删 challenge（允许用户改错重试，限频兜底）
      return reply.code(401).send({ error: '签名验证失败' });
    }

    // 4) 验签成功才删 challenge（一次性）
    await app.db.delete(verifyChallenges).where(eq(verifyChallenges.challenge, challenge));

    // 5) submitter 分支
    if (rawSubmitter !== null) {
      const handle = normalizeHandle(rawSubmitter);
      if (!handle) {
        return reply.code(422).send({ error: '署名非法（字母/数字/._-，≤32 字符，可带 @ 前缀）' });
      }
      const taken = await app.db.query.agents.findFirst({
        where: and(eq(agents.owner, handle), ne(agents.id, agent.id)),
      });
      if (taken) {
        return reply.code(409).send({ error: '署名已被占用' });
      }
      // D8：owner 不可抢——已有 owner 且与本次不同 → 拒绝，联系管理员
      if (agent.owner && agent.owner !== handle) {
        return reply.code(409).send({ error: '署名不可变更，联系管理员' });
      }
      await app.db.update(agents).set({ owner: handle }).where(eq(agents.id, agent.id));
      return { verified: true, agentId: agent.id, name: agent.name, submitterSet: true, submitter: handle };
    }

    // 无 submitter：纯自证，不动 owner（D8）
    return {
      verified: true,
      agentId: agent.id,
      name: agent.name,
      submitterSet: false,
      submitter: agent.owner ?? null,
    };
  });
}
