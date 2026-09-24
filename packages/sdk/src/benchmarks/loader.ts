import { SUITE } from './suite.js';
import { PROBES } from './probes.js';
import type { BenchmarkCase, BenchmarkDimension } from './types.js';

export { BENCHMARK_VERSION } from './version.js';
export type { BenchmarkCase, BenchmarkDimension, Grading, EvidenceResult } from './types.js';
export { DIMENSION_MAP } from './types.js';
export { PROBES, PROBE_ANCHORS, gradeInjectionProbe, gradeFromVerdict } from './probes.js';

/** 全部单轮题 = v1 suite（30）+ 公开层探针（4）。顺序固定，确定性。 */
const SINGLE_TURN: readonly BenchmarkCase[] = [...SUITE, ...PROBES];

/** 加载题集；可按维度过滤。确定性：返回顺序固定。 */
export function loadSuite(dimension?: BenchmarkDimension): readonly BenchmarkCase[] {
  return dimension ? SINGLE_TURN.filter((c) => c.dimension === dimension) : SINGLE_TURN;
}
