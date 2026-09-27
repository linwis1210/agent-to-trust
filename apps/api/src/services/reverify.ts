/**
 * 抽样复算（verified 判定）。
 *
 * 对 endpoint 模式的 agent：服务端用同版本题集抽客观题重跑，
 * 与最近一次上报的分数一致 → verificationLevel=verified；
 * 不一致 / 不可达 / 无 endpoint → 保持 basic。异步执行，不阻塞 ingest。
 *
 * 红线：只升级不降级——复算不通过不扣分（波动允许），但不给 verified 徽章。
 */
import type { FastifyInstance } from 'fastify';
import { and, desc, eq } from 'drizzle-orm';
import { createHash, randomUUID } from 'node:crypto';
import { EndpointAgent, PROBE_ANCHORS, PROBES, gradeFromVerdict, loadSuite } from 'agent-to-trust';
import { agents, evidence } from '../db/schema';
import { isPublicEndpoint } from '../playground/scenario';
import { serverInjectionDetector } from './injectionDetector';

/** 复算抽题：确定性客观题（数值题，grader 无歧义）。 */
const REVERIFY_CASE_IDS = ['coding-sum', 'reasoning-sequence'];

/** 服务端复算的 security 探针（与 SDK 公开层同 id）。 */
const REVERIFY_PROBE_IDS = ['inj-exfil-forward', 'inj-override-instruction'] as const;
const FETCH_TIMEOUT_MS = 15_000;
const VALUE_TOLERANCE = 0.01;

/**
 * 服务端注入检测 provider（进程级取一次）。
 * 默认 keyword（零出网）；`INJECTION_DETECTOR=jev` 才 opt-in Jev（= 把输出发第三方）。
 * 经 `resolveInjectionDetector` 工厂拿到可插拔实现（含熔断→降级 keyword）。
 */
const injectionDetector = serverInjectionDetector(process.env);

/** 同一 agent 复算防并发：共享同一个进行中的 Promise（撞锁 = 复用结果）。 */
const inFlight = new Map<string, Promise<'verified' | 'basic'>>();

export function reverifyAgent(
  app: FastifyInstance,
  agentId: string,
): Promise<'verified' | 'basic'> {
  const existing = inFlight.get(agentId);
  if (existing) return existing;
  const p = runReverify(app, agentId).finally(() => inFlight.delete(agentId));
  inFlight.set(agentId, p);
  return p;
}

/** 一期 Integrity 第四通道：言行一致（宣称的 endpoint 能否复现宣称的成绩）。
 *  可达且一致 → success；可达但不一致 → failure/partial（按匹配率）；
 *  不可达 / 无 endpoint → 不落行（下线是 reliability 语义，不是诚信语义）。
 *  append-only 防刷屏：与该 agent 最新一行同 result → 跳过。 */
async function persistConsistencyEvidence(
  app: FastifyInstance,
  agentId: string,
  matched: number,
  compared: number,
): Promise<void> {
  if (compared <= 0) return;
  const value = Math.round((matched / compared) * 100) / 100;
  const result = value >= 1 ? 'success' : value >= 0.5 ? 'partial' : 'failure';
  const latest = await app.db.query.evidence.findFirst({
    where: and(
      eq(evidence.agentId, agentId),
      eq(evidence.evidenceUri, 'a2t://reverify/consistency'),
      eq(evidence.issuer, 'server-reverify'),
    ),
    orderBy: [desc(evidence.createdAt)],
  });
  if (latest && latest.result === result) return;
  await app.db.insert(evidence).values({
    id: randomUUID(),
    agentId,
    dimension: 'integrity',
    source: 'verified',
    sourceType: 'verified',
    issuer: 'server-reverify',
    result,
    value,
    evidenceUri: 'a2t://reverify/consistency',
    payloadHash: createHash('sha256').update(`${agentId}:${matched}/${compared}`).digest('hex'),
  });
}

async function runReverify(
  app: FastifyInstance,
  agentId: string,
): Promise<'verified' | 'basic'> {
  try {
    const agent = await app.db.query.agents.findFirst({ where: eq(agents.id, agentId) });
    if (!agent?.endpoint || !agent.pubkey) return 'basic';
    // 审计 A4【P1·安全】：ingest 已卡口新写入，但库里可能已有历史脏 endpoint。
    // 服务端 fetch 前再校验一次：非法（环回/私网/非 http(s)）直接放弃，不发请求。
    if (!isPublicEndpoint(agent.endpoint)) return 'basic';

    // 最近一次上报的 real-benchmark 证据（按 caseId 取最新 value）
    const allReal = await app.db.query.evidence.findMany({
      where: and(eq(evidence.agentId, agentId), eq(evidence.source, 'real-benchmark')),
      orderBy: [desc(evidence.createdAt)],
    });
    const latestByCase = new Map<string, number>();
    for (const e of allReal) {
      const caseId = e.evidenceUri?.replace('a2t://benchmark/', '');
      if (caseId && !latestByCase.has(caseId)) latestByCase.set(caseId, e.value ?? -1);
    }
    const toVerify = REVERIFY_CASE_IDS.flatMap((id) => {
      const c = loadSuite().find((x) => x.id === id);
      const expected = latestByCase.get(id);
      return c && expected !== undefined ? [{ case: c, expected }] : [];
    });
    if (toVerify.length === 0) return 'basic'; // 无可复算的客观题

    const fetchImpl: typeof fetch = (input, init) =>
      fetch(input, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    const endpointAgent = new EndpointAgent(agent.endpoint, fetchImpl);

    // 言行一致累计：compared=重放题数，matched=与服务端复算一致的题数；
    // allMatch=全部一致（verified 的必要条件）；allReachable=全程未遇不可达。
    let compared = 0;
    let matched = 0;
    let allMatch = true;
    let allReachable = true;

    for (const { case: c, expected } of toVerify) {
      let value: number;
      try {
        const output = await endpointAgent.reply(c.prompt);
        value = c.grade(output).value;
      } catch {
        allReachable = false;
        allMatch = false;
        break; // 不可达 / 超时：不落行，直接保守 basic
      }
      compared++;
      if (Math.abs(value - expected) <= VALUE_TOLERANCE) {
        matched++;
      } else {
        allMatch = false; // 不一致
      }
    }

    // ── security 探针复算 ──
    // 服务端从 endpoint 取回输出，经 provider 缝（`serverInjectionDetector`，默认 keyword）拿 verdict，
    // 再用与 SDK **同源**的 value 实现 `gradeFromVerdict` + 同锚点重算 value，
    // 与最近一次上报的 security 探针 value 比对。不一致 → 保守保持 basic（只升级不降级）。
    // R7/R9：判定值算法只有一份实现（SDK `gradeFromVerdict`），此处绝不内联副本。
    const probeExpected: Array<{
      prompt: string;
      expected: number;
      anchors: (typeof PROBE_ANCHORS)[string];
    }> = [];
    for (const pid of REVERIFY_PROBE_IDS) {
      const expected = latestByCase.get(pid);
      const probeCase = PROBES.find((p) => p.id === pid);
      const anchors = PROBE_ANCHORS[pid];
      if (expected !== undefined && probeCase && anchors) {
        probeExpected.push({ prompt: probeCase.prompt, expected, anchors });
      }
    }
    for (const { prompt, expected, anchors } of probeExpected) {
      let value: number;
      try {
        const output = await endpointAgent.reply(prompt);
        const verdict = await injectionDetector.detect(output, anchors);
        value = gradeFromVerdict(verdict, output, anchors).value;
      } catch {
        allReachable = false;
        allMatch = false;
        break; // 不可达 / 超时：不落行，保守 basic
      }
      compared++;
      if (Math.abs(value - expected) <= VALUE_TOLERANCE) {
        matched++;
      } else {
        allMatch = false; // 与服务端重算不一致
      }
    }

    // 言行一致证据落库（第四通道）：可达且有可比题才落；同 result 幂等跳过。
    if (allReachable && compared > 0) {
      await persistConsistencyEvidence(app, agentId, matched, compared);
    }

    // 只升级不降级：任一不一致 / 不可达 → 保持 basic。
    if (!allMatch) return 'basic';

    await app.db
      .update(agents)
      .set({ verificationLevel: 'verified' })
      .where(eq(agents.id, agentId));
    return 'verified';
  } finally {
    inFlight.delete(agentId);
  }
}
