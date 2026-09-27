/**
 * @a2t/scoring — Baseline Credit Engine v0.3。
 *
 * 可解释、确定性的评分引擎（纯函数，无副作用，可被 API 与 Dashboard 共用）。
 * 核心原则：每个分数必须能追溯到 evidence；同样输入重复计算一致；score 带 version。
 *
 * 注意：这是实验基线（baseline-v0.3），不是行业标准。
 */

import {
  DIMENSION_WEIGHTS,
  SOURCE_WEIGHTS,
  type Dimension,
  type EvidenceResult,
  type Source,
} from '@a2t/core';
import { snapshotConsistency, type SnapshotPoint } from './consistency.js';

export const SCORE_MODEL_VERSION = 'baseline-v0.3'; // v0.3：重现性 blend + 公开题面封顶 + 覆盖置信系数

/** v0.3 重标定：公开考场题面人人可背题，单题计分封顶 0.85。
 *  酒馆保密单（real-confidential）与 arena 结算不受此限——不公开、刷不动。 */
export const PUBLIC_EXAM_VALUE_CAP = 0.85;

/** v0.3 重标定：覆盖置信系数底座。score ×(0.5 + 0.5×coverage)——
 *  档案不全=后验收缩（贝叶斯语义），8 维全测系数=1，满分语义不变。 */
export const COVERAGE_CONFIDENCE_BASE = 0.5;

const RESULT_VALUE: Record<EvidenceResult, number> = {
  success: 1.0,
  failure: 0.0,
  partial: 0.5,
};

/** 置信度：达到该证据数量即认为数量维度满信心。 */
const COUNT_FULL = 20;
/** 新鲜度半衰期（天）。 */
const FRESHNESS_HALF_LIFE_DAYS = 30.0;
/** 一期：reliability 一致性「独撑」时的封顶——纯被动快照不享全权重（别让分数太高）。 */
export const RELIABILITY_CONSISTENCY_CAP = 50;

export interface EvidencePoint {
  dimension: Dimension;
  source: Source;
  sourceType?: string;
  result: EvidenceResult;
  value?: number;
  timestamp?: Date;
}

export interface DimensionResult {
  dimension: Dimension;
  score: number | null; // 0..100，无证据为 null
  weight: number;
  evidenceCount: number;
  /** v0.3 起：reliability 条目附快照一致性分（0..100）。裸 jsonb 旧行无此键，读侧必须容忍。 */
  consistency?: number;
}

export interface ExplanationItem {
  dimension: string;
  score: number;
  weight: number;
  evidenceCount: number;
}

export interface ScoreResult {
  score: number | null; // 0..1000，无证据为 null（unverified）
  adjustedScore: number | null; // score × 新鲜度因子（v0.2）
  confidence: number; // 0..1
  freshnessDays: number | null;
  freshnessFactor: number;
  coverage: number; // 已覆盖维度权重占比 0..1
  modelVersion: string;
  evidenceCount: number;
  dimensions: DimensionResult[];
  sources: Record<string, number>;
  explanation: ExplanationItem[];
}

function outcome(point: EvidencePoint): number {
  const raw =
    point.value !== undefined && point.value !== null
      ? Math.max(0, Math.min(1, point.value))
      : RESULT_VALUE[point.result];
  return point.source === 'real-benchmark' ? Math.min(raw, PUBLIC_EXAM_VALUE_CAP) : raw;
}

function sourceWeight(source: Source): number {
  return SOURCE_WEIGHTS[source] ?? 0.3;
}

function dimensionScore(evidence: EvidencePoint[], dimension: Dimension): { score: number | null; count: number } {
  const points = evidence.filter((e) => e.dimension === dimension);
  if (points.length === 0) return { score: null, count: 0 };
  const totalWeight = points.reduce((sum, p) => sum + sourceWeight(p.source), 0);
  if (totalWeight <= 0) return { score: null, count: points.length };
  const weighted = points.reduce((sum, p) => sum + sourceWeight(p.source) * outcome(p), 0) / totalWeight;
  return { score: round2(weighted * 100), count: points.length };
}

function freshness(evidence: EvidencePoint[], now: Date): { days: number | null; factor: number } {
  const timestamps = evidence.map((e) => e.timestamp).filter((t): t is Date => t != null);
  if (timestamps.length === 0) return { days: null, factor: 1.0 };
  const newest = timestamps.reduce((a, b) => (a > b ? a : b));
  const days = Math.max(0, (now.getTime() - newest.getTime()) / 86_400_000);
  const factor = Math.pow(0.5, days / FRESHNESS_HALF_LIFE_DAYS);
  return { days: round2(days), factor: round4(factor) };
}

function confidence(evidence: EvidencePoint[], coverage: number): number {
  if (evidence.length === 0) return 0;
  const countFactor = Math.min(1, evidence.length / COUNT_FULL);
  const sourceFactor = evidence.reduce((sum, e) => sum + sourceWeight(e.source), 0) / evidence.length;
  return round4(coverage * (0.5 * countFactor + 0.5 * sourceFactor));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

export function computeScore(
  evidence: EvidencePoint[],
  now: Date = new Date(),
  snapshots?: readonly SnapshotPoint[], // 一期新增：可选，向后兼容
): ScoreResult {
  const cons = snapshots ? snapshotConsistency(snapshots) : null;
  const dimensions: DimensionResult[] = (Object.keys(DIMENSION_WEIGHTS) as Dimension[]).map((dim) => {
    const { score, count } = dimensionScore(evidence, dim);
    if (dim === 'reliability' && cons !== null) {
      // 一期激活口径：证据分与总分重现性各半；一致性独撑时封顶 50。
      const blended =
        score !== null ? round2(0.5 * score + 0.5 * cons) : Math.min(cons, RELIABILITY_CONSISTENCY_CAP);
      return {
        dimension: dim,
        score: blended,
        weight: DIMENSION_WEIGHTS[dim],
        evidenceCount: count,
        consistency: cons,
      };
    }
    return { dimension: dim, score, weight: DIMENSION_WEIGHTS[dim], evidenceCount: count };
  });

  const available = dimensions.filter((d) => d.score !== null);
  const coverage = round4(available.reduce((sum, d) => sum + d.weight, 0));

  let score: number | null = null;
  let adjustedScore: number | null = null;
  if (available.length > 0) {
    // v0.3 绝对分：分母恒 = 全 8 维权重和（= 1.0，未测维度记 0），
    // 再乘覆盖置信系数 (0.5 + 0.5×coverage)：半覆盖档案的分数天花板被压向低端，
    // 洗掉「少量公开题满分 → 高分」的 v1 虚高（老大要求：别让分数太高）。
    const weightedSum = dimensions.reduce((sum, d) => sum + d.weight * (d.score ?? 0), 0);
    score = Math.round(weightedSum * 10 * (COVERAGE_CONFIDENCE_BASE + (1 - COVERAGE_CONFIDENCE_BASE) * coverage));
    // v0.2：adjustedScore 只保留时效衰减（coverage 已进 score，不再二次打折）。
    adjustedScore = Math.round(score * freshness(evidence, now).factor);
  }

  const { days, factor } = freshness(evidence, now);
  const conf = available.length > 0 ? confidence(evidence, coverage) : 0;

  const sources: Record<string, number> = {};
  for (const e of evidence) {
    sources[e.source] = (sources[e.source] ?? 0) + 1;
  }

  const explanation: ExplanationItem[] = available
    .filter((d) => d.score !== null)
    .map((d) => ({
      dimension: d.dimension,
      score: d.score as number,
      weight: d.weight,
      evidenceCount: d.evidenceCount,
    }));

  return {
    score,
    adjustedScore,
    confidence: conf,
    freshnessDays: days,
    freshnessFactor: factor,
    coverage,
    modelVersion: SCORE_MODEL_VERSION,
    evidenceCount: evidence.length,
    dimensions,
    sources,
    explanation,
  };
}

export * from './badges.js';
export * from './consistency.js';
