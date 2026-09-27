import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { type Dimension, type Source } from '@a2t/core';
import {
  badgesFromDimensions,
  computeScore,
  dedupeByUriLatest,
  realEvidenceCounts,
  shouldRecordSnapshot,
  REAL_EVIDENCE_SOURCES,
  type Badge,
  type EvidencePoint,
} from '@a2t/scoring';
import { agents, creditScores, evidence, scoreSnapshots } from '../db/schema';
import { createRateLimiter } from '../services/rateLimit';

/**
 * 详情页勋章（2026-09-13 老大走查补）：与榜单行**同一口径**（@a2t/scoring.badgesFromDimensions），
 * 只认真实证据（REAL_EVIDENCE_SOURCES），时效由 freshnessDays 推算；客户端不得自报。
 */
async function badgesForAgent(
  app: FastifyInstance,
  agentId: string,
  s: { dimensions: unknown; freshnessDays: number | null },
): Promise<Badge[]> {
  const rows = await app.db.query.evidence.findMany({
    where: and(
      eq(evidence.agentId, agentId),
      inArray(evidence.source, [...REAL_EVIDENCE_SOURCES]),
    ),
  });
  // 重考收口（2026-09-27）：勋章计数与算分同口径——退役证据不计、同题只算最新一条，
  // 否则重考号证据量翻倍会虚亮勋章（例：20 题算成 40 条）。
  const activeRows = dedupeByUriLatest(rows.filter((r) => r.retiredAt == null));
  const dims = (s.dimensions ?? []) as Array<{ dimension: string; score: number | null; consistency?: number | null }>;
  // consistency（reliability 重现性）由 badgesFromDimensions 识别为「一致性达标证据」。
  return badgesFromDimensions(dims, realEvidenceCounts(activeRows), s.freshnessDays);
}

export function serialize(s: typeof creditScores.$inferSelect) {
  return {
    agentId: s.agentId,
    score: s.score,
    adjustedScore: s.adjustedScore,
    confidence: s.confidence,
    coverage: s.coverage,
    freshnessDays: s.freshnessDays,
    modelVersion: s.modelVersion,
    dimensions: s.dimensions,
    evidenceCount: (s.evidenceRefs ?? []).length,
    evidenceRefs: s.evidenceRefs,
    computedAt: s.createdAt,
  };
}

export async function computeAndPersist(app: FastifyInstance, agentId: string) {
  const rows = await app.db.query.evidence.findMany({ where: eq(evidence.agentId, agentId) });
  // 重考收口（2026-09-27）：同一题（evidenceUri）只取最新一条——重考自动替换旧卷，
  // 消除「旧卷 + 新卷」双重计量（覆盖率取并集、证据量翻倍的虚高源）。
  // 原始证据全留库可审（append-only 红线）；已行退役标记（retiredAt）的证据不计分。
  const active = rows.filter((r) => r.retiredAt == null);
  const deduped = dedupeByUriLatest(active);
  // 一期：历史快照（全版本）→ computeScore 做 reliability 重现性。
  // 只取「已存在」的快照——本次计算的结果快照在后面才插入，天然不含自身。
  const pastSnaps = await app.db.query.scoreSnapshots.findMany({
    where: eq(scoreSnapshots.agentId, agentId),
    orderBy: [scoreSnapshots.snapshotAt],
  });
  const points: EvidencePoint[] = deduped.map((e) => ({
    dimension: e.dimension as Dimension,
    source: e.source as Source,
    sourceType: e.sourceType,
    result: e.result as 'success' | 'failure' | 'partial',
    value: e.value ?? undefined,
    timestamp: e.createdAt,
  }));
  const result = computeScore(
    points,
    new Date(),
    pastSnaps.map((s) => ({ score: s.score, modelVersion: s.modelVersion, snapshotAt: s.snapshotAt })),
  );

  const [created] = await app.db
    .insert(creditScores)
    .values({
      id: randomUUID(),
      agentId,
      score: result.score,
      adjustedScore: result.adjustedScore,
      confidence: result.confidence,
      coverage: result.coverage,
      freshnessDays: result.freshnessDays,
      modelVersion: result.modelVersion,
      dimensions: result.dimensions as unknown as Record<string, unknown>[],
      evidenceRefs: deduped.map((r) => r.id),
    })
    .returning();

  // 重考收口（2026-09-27 修复）：快照是 reliability（重现性）的观测输入——只在
  // 「有新证据落库」时写；纯重算（换口径 / 刷分 / dashboard 读触发）不写，
  // 否则会把「代码/口径造成的分数跳变」误当成 agent 行为漂移，污染可靠性。
  const lastSnapAt = pastSnaps.length > 0 ? pastSnaps[pastSnaps.length - 1]!.snapshotAt : null;
  const newestEvidenceAt = active.reduce<Date | null>(
    (acc, r) => (acc == null || r.createdAt > acc ? r.createdAt : acc),
    null,
  );
  if (shouldRecordSnapshot(lastSnapAt, newestEvidenceAt)) {
    await app.db.insert(scoreSnapshots).values({
      id: randomUUID(),
      agentId,
      score: result.score,
      modelVersion: result.modelVersion,
      dimensionsSnapshot: result.dimensions,
    });
  }

  return created;
}

export async function scoresRoutes(app: FastifyInstance) {
  // 公开读限流 60/min/IP（S4-B M2 批 2，plan §Task 12；统一内存桶）。只限 GET，
  // POST（评分触发写路径）不在此桶内。computeAndPersist 本体零改动（红线）。
  const scoreReadLimited = createRateLimiter({ max: 60, windowMs: 60_000 });

  app.post('/agents/:id/score', async (req, reply) => {
    const { id } = req.params as { id: string };
    const agent = await app.db.query.agents.findFirst({ where: eq(agents.id, id) });
    if (!agent) return reply.code(404).send({ error: `Agent 不存在：${id}` });
    const created = await computeAndPersist(app, id);
    return { ...serialize(created), badges: await badgesForAgent(app, id, created) };
  });

  app.get('/agents/:id/score', async (req, reply) => {
    if (scoreReadLimited(req)) {
      return reply.code(429).send({ error: '请求过于频繁，稍后再试' });
    }
    const { id } = req.params as { id: string };
    const agent = await app.db.query.agents.findFirst({ where: eq(agents.id, id) });
    if (!agent) return reply.code(404).send({ error: `Agent 不存在：${id}` });
    const latest = await app.db.query.creditScores.findFirst({
      where: eq(creditScores.agentId, id),
      orderBy: (s, { desc }) => [desc(s.createdAt)],
    });
    const s = latest ?? (await computeAndPersist(app, id));
    return { ...serialize(s), badges: await badgesForAgent(app, id, s) };
  });
}
