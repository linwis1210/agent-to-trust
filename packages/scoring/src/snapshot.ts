/**
 * 快照写入闸门（2026-09-27 重考收口修复）。
 *
 * 背景：score_snapshots 是 reliability（重现性）的输入——`snapshotConsistency`
 * 比较同一 modelVersion 相邻快照的相对漂移。若「纯重算」（换口径 / 手动刷分 /
 * dashboard 刷新）也写快照，就会把「代码/口径造成的分数跳变」误当成「agent 行为
 * 漂移」，污染可靠性（实测：一次批量重算把 crush 记了一次 556→522 的假漂移）。
 *
 * 口径：**只有「有新证据落库」才算一次新观测**。新证据时间戳晚于上一条快照 →
 * 写快照；否则（纯重算）不写。首次计算（无历史快照）恒写。
 *
 * 纯函数、确定性、零副作用（与 @a2t/scoring 全包约定一致）。
 */
export function shouldRecordSnapshot(
  lastSnapshotAt: Date | string | null | undefined,
  newestEvidenceAt: Date | string | null | undefined,
): boolean {
  if (lastSnapshotAt == null) return true; // 首算：建立基线快照
  if (newestEvidenceAt == null) return false; // 无证据可用 → 不是新观测
  return new Date(newestEvidenceAt).getTime() > new Date(lastSnapshotAt).getTime();
}
