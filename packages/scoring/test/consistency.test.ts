import { describe, expect, it } from 'vitest';
import { DRIFT_CAP, snapshotConsistency } from '../src/consistency.js';

describe('snapshotConsistency 总分重现性', () => {
  it('同版本两条微漂移 → 接近满分（997→998，drift≈0.1%）', () => {
    const s = [
      { score: 997, modelVersion: 'baseline-v0.1', snapshotAt: '2026-09-01T00:00:00Z' },
      { score: 998, modelVersion: 'baseline-v0.1', snapshotAt: '2026-09-02T00:00:00Z' },
    ];
    // 1/997=0.001003 → 100×(1−0.001003/0.15)=99.33
    expect(snapshotConsistency(s)).toBe(99.33);
  });

  it('无序输入按时间排序后计算（结果与顺序无关）', () => {
    const s = [
      { score: 998, modelVersion: 'v', snapshotAt: '2026-09-02T00:00:00Z' },
      { score: 997, modelVersion: 'v', snapshotAt: '2026-09-01T00:00:00Z' },
    ];
    expect(snapshotConsistency(s)).toBe(99.33);
  });

  it('跨版本跳变不计（口径切换不是 agent 行为变化）', () => {
    const s = [
      { score: 998, modelVersion: 'baseline-v0.1', snapshotAt: '2026-09-01T00:00:00Z' },
      { score: 499, modelVersion: 'baseline-v0.2', snapshotAt: '2026-09-02T00:00:00Z' },
    ];
    expect(snapshotConsistency(s)).toBeNull();
  });

  it('版本切换前后各自内部成对计算', () => {
    const s = [
      { score: 800, modelVersion: 'v0.1', snapshotAt: '2026-09-01T00:00:00Z' },
      { score: 880, modelVersion: 'v0.1', snapshotAt: '2026-09-02T00:00:00Z' }, // 10%
      { score: 300, modelVersion: 'v0.2', snapshotAt: '2026-09-03T00:00:00Z' }, // 切换不计
      { score: 309, modelVersion: 'v0.2', snapshotAt: '2026-09-04T00:00:00Z' }, // 3%
    ];
    // mean=(0.10+0.03)/2=0.065 → 100×(1−0.065/0.15)=56.67
    expect(snapshotConsistency(s)).toBe(56.67);
  });

  it('null 分快照跳过；有效对不足 → null', () => {
    expect(
      snapshotConsistency([
        { score: null, modelVersion: 'v', snapshotAt: '2026-09-01T00:00:00Z' },
        { score: 500, modelVersion: 'v', snapshotAt: '2026-09-02T00:00:00Z' },
      ]),
    ).toBeNull();
  });

  it('0 分基线保护：prev=0 时 drift 巨大 → 一致性 0，不抛错不爆分', () => {
    expect(
      snapshotConsistency([
        { score: 0, modelVersion: 'v', snapshotAt: '2026-09-01T00:00:00Z' },
        { score: 600, modelVersion: 'v', snapshotAt: '2026-09-02T00:00:00Z' },
      ]),
    ).toBe(0);
  });

  it('DRIFT_CAP = 0.15', () => expect(DRIFT_CAP).toBe(0.15));
});
