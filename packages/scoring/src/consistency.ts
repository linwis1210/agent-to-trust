/**
 * 总分重现性（Reliability 激活一期口径）。
 *
 * 哲学锚点：休谟归纳问题——「未来像不像过去」只能靠重复观测回答。
 * 输入 = 某 agent 的 score_snapshots（可含历史跨口径版本）；
 * 输出 = 0..100 一致性分；null = 无法评估（同口径相邻快照不足一对）。
 *
 * 口径红线：
 * - 只计「同 modelVersion 相邻对」的相对漂移——评分口径切换造成的跳变
 *   是换尺子，不是 agent 行为变化，不计入（生产库现有 10 个 agent 的
 *   v0.1→v0.2 分差 400+ 分即属此类）。
 * - 平均相对漂移 d̄ 对 DRIFT_CAP=0.15 线性映射：d̄≥15% → 0 分。
 * - 纯函数、确定性、零副作用（与 @a2t/scoring 全包约定一致）。
 */
export const DRIFT_CAP = 0.15;

export interface SnapshotPoint {
  score: number | null;
  modelVersion: string;
  snapshotAt: string | Date;
}

export function snapshotConsistency(snaps: readonly SnapshotPoint[]): number | null {
  const sorted = [...snaps].sort(
    (a, b) => new Date(a.snapshotAt).getTime() - new Date(b.snapshotAt).getTime(),
  );
  const drifts: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]!;
    const cur = sorted[i]!;
    if (prev.modelVersion !== cur.modelVersion) continue; // 口径切换跳变不计
    if (prev.score == null || cur.score == null) continue; // 缺分对不计
    const base = Math.max(Math.abs(prev.score), 1); // 0 分基线保护
    drifts.push(Math.abs(cur.score - prev.score) / base);
  }
  if (drifts.length === 0) return null;
  const mean = drifts.reduce((a, b) => a + b, 0) / drifts.length;
  const consistency = 100 * Math.max(0, 1 - mean / DRIFT_CAP);
  return Math.round(consistency * 100) / 100;
}
