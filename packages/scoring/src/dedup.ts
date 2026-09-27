/**
 * 重考去重（Re-exam supersede）—— 读侧去重，不动原始证据（append-only 红线）。
 *
 * 背景（2026-09-27 事故）：ingest 每次考试都是 append，同号重考会叠加旧卷证据；
 * 计分侧若读全量，就会出现「旧卷 + 新卷」双重计量（覆盖率取并集、证据量翻倍），
 * 导致重考号分数虚高。修复：按**同一题（evidenceUri）只取最新一条**算分——
 * 重考自动替换旧卷，原始证据全部留库可审。
 *
 * 边界：
 * - 无 URI 的证据（旧版/模拟/迁移前数据）无法判重，**全部保留**，不误伤；
 * - 不同来源命名空间（`a2t://benchmark/…` / `a2t://arena/…` / `sim://tx/…`）天然不撞；
 * - 同一 URI 同秒并列时取后者（输入顺序），保证确定性。
 */

/** 去重所需的最小行形状。 */
export interface UriDated {
  evidenceUri?: string | null;
  createdAt: Date;
}

/**
 * 同一 evidenceUri 只保留 createdAt 最新的一条；无 URI 的全部保留。
 * 纯函数、确定性、不修改入参。
 */
export function dedupeByUriLatest<T extends UriDated>(rows: readonly T[]): T[] {
  const latest = new Map<string, T>();
  const passthrough: T[] = [];
  for (const r of rows) {
    const uri = r.evidenceUri;
    if (!uri) {
      passthrough.push(r);
      continue;
    }
    const prev = latest.get(uri);
    if (!prev || r.createdAt.getTime() >= prev.createdAt.getTime()) latest.set(uri, r);
  }
  return [...passthrough, ...latest.values()];
}
