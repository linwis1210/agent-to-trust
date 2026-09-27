import { describe, expect, it } from 'vitest';
import { DIMENSION_WEIGHTS, SOURCE_WEIGHTS, type Dimension, type Source } from '@a2t/core';
import { computeScore, SCORE_MODEL_VERSION, type EvidencePoint } from '../src/index';

const NOW = new Date('2026-08-23T12:00:00Z');

function ev(partial: Partial<EvidencePoint> & { dimension: Dimension }): EvidencePoint {
  return { source: 'simulation', result: 'success', timestamp: NOW, ...partial };
}

// 验收维度映射：docs/TESTING.md
// 正确性 / 确定性 / 可解释性 / 可复现性 / 鲁棒性 / 数据完整性 / 性能

describe('[正确性] Correctness', () => {
  it('单条 success → 120（0.2×100×10 ×0.6 覆盖置信系数；v0.2 为 200）', () => {
    expect(computeScore([ev({ dimension: 'capability', source: 'benchmark' })], NOW).score).toBe(120);
  });

  it('单条 failure → score 0', () => {
    expect(computeScore([ev({ dimension: 'capability', source: 'benchmark', result: 'failure' })], NOW).score).toBe(0);
  });

  it('单条 partial → 60（0.2×50×10 ×0.6；v0.2 为 100）', () => {
    expect(computeScore([ev({ dimension: 'capability', source: 'benchmark', result: 'partial' })], NOW).score).toBe(60);
  });

  it('跨维度混合：capability 成功 + reliability 失败 → 140（reliability 计 0）', () => {
    const r = computeScore(
      [
        ev({ dimension: 'capability', source: 'benchmark' }),
        ev({ dimension: 'reliability', source: 'benchmark', result: 'failure' }),
      ],
      NOW,
    );
    // v0.3 重算：weightedSum=0.2×100+0.2×0=20，cov=0.2+0.2=0.4 → round(20×10×(0.5+0.5×0.4))=round(140)=140
    expect(r.score).toBe(140);
  });

  it('全 8 维满分 → 1000（绝对分上限）', () => {
    const all = (Object.keys(DIMENSION_WEIGHTS) as Dimension[]).map((d) =>
      ev({ dimension: d, source: 'benchmark' }),
    );
    expect(computeScore(all, NOW).score).toBe(1000);
  });

  it('未测维度计 0：考场 4 维满分 375（0.5 覆盖 → 置信系数 0.75，不虚高）', () => {
    const exam = (['capability', 'delivery', 'integrity', 'negotiation'] as Dimension[]).map((d) =>
      ev({ dimension: d, source: 'benchmark' }),
    );
    // v0.3 重算：(0.2+0.15+0.1+0.05)×100×10 = 500；再 ×(0.5+0.5×0.5)=0.75 → round(375)=375
    expect(computeScore(exam, NOW).score).toBe(375);
  });

  it('score 始终落在 [0, 1000]', () => {
    const r = computeScore(
      [
        ev({ dimension: 'capability', source: 'benchmark', result: 'success' }),
        ev({ dimension: 'economic', source: 'real', result: 'partial' }),
        ev({ dimension: 'integrity', source: 'self-reported', result: 'failure' }),
      ],
      NOW,
    );
    expect(r.score).toBeGreaterThanOrEqual(0);
    expect(r.score).toBeLessThanOrEqual(1000);
  });
});

describe('[确定性] Determinism', () => {
  it('同输入两次结果完全一致（deep-equal）', () => {
    const evidence = [ev({ dimension: 'capability', source: 'benchmark' }), ev({ dimension: 'reliability' })];
    expect(computeScore(evidence, NOW)).toEqual(computeScore(evidence, NOW));
  });
});

describe('[可解释性] Explainability', () => {
  it('explanation 覆盖所有有证据的维度', () => {
    const r = computeScore([ev({ dimension: 'capability' }), ev({ dimension: 'economic' })], NOW);
    expect(r.explanation.map((e) => e.dimension).sort()).toEqual(['capability', 'economic']);
  });

  it('explanation 每项含维度/分数/权重/证据数', () => {
    const r = computeScore([ev({ dimension: 'capability', source: 'benchmark' })], NOW);
    const item = r.explanation[0];
    expect(item).toHaveProperty('dimension');
    expect(item).toHaveProperty('score');
    expect(item).toHaveProperty('weight');
    expect(item).toHaveProperty('evidenceCount');
    expect(item.evidenceCount).toBe(1);
  });

  it('dimensions 恒返回 8 个维度，无证据的 score 为 null', () => {
    const r = computeScore([ev({ dimension: 'capability' })], NOW);
    expect(r.dimensions).toHaveLength(8);
    expect(r.dimensions.filter((d) => d.score === null)).toHaveLength(7);
  });

  it('evidenceCount 汇总等于输入证据数', () => {
    const evidence = [ev({ dimension: 'capability' }), ev({ dimension: 'delivery' }), ev({ dimension: 'security' })];
    expect(computeScore(evidence, NOW).evidenceCount).toBe(3);
  });
});

describe('[覆盖度] Coverage', () => {
  it('单 capability → coverage 0.2', () => {
    expect(computeScore([ev({ dimension: 'capability', source: 'benchmark' })], NOW).coverage).toBeCloseTo(0.2, 4);
  });

  it('全 8 维度 → coverage 1.0', () => {
    const all = (Object.keys(DIMENSION_WEIGHTS) as Dimension[]).map((d) => ev({ dimension: d }));
    expect(computeScore(all, NOW).coverage).toBeCloseTo(1.0, 4);
  });

  it('两维度 → coverage = 权重和', () => {
    const r = computeScore([ev({ dimension: 'capability' }), ev({ dimension: 'negotiation' })], NOW);
    expect(r.coverage).toBeCloseTo(0.2 + 0.05, 4);
  });
});

describe('[来源权重] Source weighting', () => {
  it('高权重来源（benchmark）对分数影响大于低权重（self-reported）', () => {
    const benchHigh = computeScore(
      [
        ev({ dimension: 'capability', source: 'benchmark', result: 'success' }),
        ev({ dimension: 'capability', source: 'self-reported', result: 'failure' }),
      ],
      NOW,
    );
    const selfHigh = computeScore(
      [
        ev({ dimension: 'capability', source: 'self-reported', result: 'success' }),
        ev({ dimension: 'capability', source: 'benchmark', result: 'failure' }),
      ],
      NOW,
    );
    expect(benchHigh.score!).toBeGreaterThan(selfHigh.score!);
  });

  it('真实来源（real）单维满分 → 120（0.2×100×10 ×0.6 覆盖置信系数）', () => {
    expect(computeScore([ev({ dimension: 'capability', source: 'real' })], NOW).score).toBe(120);
  });

  it('S5-T3/B3：real-confidential（confidential 明细类）在维度内按 0.5 计权', () => {
    // negotiation：real 成功（1.0）+ real-confidential 失败（0.5）→ (1.0×1 + 0.5×0)/1.5 = 66.67
    // 若两条均按 real=1.0 计权则应为 50 —— 66.67 证明降权档生效
    const r = computeScore(
      [
        ev({ dimension: 'negotiation', source: 'real' }),
        ev({ dimension: 'negotiation', source: 'real-confidential', result: 'failure' }),
      ],
      NOW,
    );
    const neg = r.dimensions.find((d) => d.dimension === 'negotiation');
    expect(neg?.score).toBe(66.67);
  });
});

describe('[置信度] Confidence semantics', () => {
  it('无证据 → confidence 0', () => {
    expect(computeScore([], NOW).confidence).toBe(0);
  });

  it('证据越多 → confidence 越高', () => {
    const one = [ev({ dimension: 'capability', source: 'benchmark' })];
    const many = (Object.keys(DIMENSION_WEIGHTS) as Dimension[]).flatMap((d) => [
      ev({ dimension: d, source: 'benchmark' }),
      ev({ dimension: d, source: 'benchmark' }),
      ev({ dimension: d, source: 'benchmark' }),
    ]);
    expect(computeScore(many, NOW).confidence).toBeGreaterThan(computeScore(one, NOW).confidence);
  });

  it('verified 来源置信度高于 self-reported', () => {
    const self = computeScore([ev({ dimension: 'capability', source: 'self-reported' })], NOW);
    const verified = computeScore([ev({ dimension: 'capability', source: 'verified' })], NOW);
    expect(verified.confidence).toBeGreaterThan(self.confidence);
  });

  it('confidence 封顶 1', () => {
    const many = (Object.keys(DIMENSION_WEIGHTS) as Dimension[]).flatMap((d) =>
      Array.from({ length: 30 }, () => ev({ dimension: d, source: 'real' })),
    );
    expect(computeScore(many, NOW).confidence).toBeLessThanOrEqual(1);
  });
});

describe('[新鲜度] Freshness decay', () => {
  it('旧证据 freshnessFactor 更低、freshnessDays 更高', () => {
    const old = computeScore(
      [ev({ dimension: 'capability', source: 'benchmark', timestamp: new Date('2026-06-24T12:00:00Z') })],
      NOW,
    );
    const fresh = computeScore([ev({ dimension: 'capability', source: 'benchmark', timestamp: NOW })], NOW);
    expect(old.freshnessFactor).toBeLessThan(fresh.freshnessFactor);
    expect(old.freshnessDays!).toBeGreaterThan(fresh.freshnessDays!);
  });

  it('60 天前（2 个半衰期）→ freshnessFactor ≈ 0.25', () => {
    const r = computeScore(
      [ev({ dimension: 'capability', source: 'benchmark', timestamp: new Date('2026-06-24T12:00:00Z') })],
      NOW,
    );
    expect(r.freshnessDays).toBeCloseTo(60, 1);
    expect(r.freshnessFactor).toBeCloseTo(0.25, 2);
  });

  it('adjustedScore = score × 新鲜度因子（v0.2 去掉 coverage 双重打折）', () => {
    const r = computeScore(
      [ev({ dimension: 'capability', source: 'benchmark', timestamp: new Date('2026-06-24T12:00:00Z') })],
      NOW,
    );
    // 60 天 = 2 个半衰期 → factor 0.25；v0.3 重算：score = round(0.2×100×10×0.6) = 120 → adj = round(120×0.25) = 30
    expect(r.score).toBe(120);
    expect(r.adjustedScore).toBe(30);
  });

  it('无 timestamp → freshnessFactor = 1', () => {
    const r = computeScore([{ dimension: 'capability', source: 'benchmark', result: 'success' }], NOW);
    expect(r.freshnessFactor).toBe(1);
  });
});

describe('[鲁棒性] Robustness', () => {
  it('空数组不抛异常，返回 unverified', () => {
    const r = computeScore([], NOW);
    expect(r.score).toBeNull();
    expect(r.confidence).toBe(0);
  });

  it('value 越界被 clamp 到 [0,1]', () => {
    const high = computeScore([ev({ dimension: 'capability', source: 'benchmark', value: 1.5 })], NOW);
    const low = computeScore([ev({ dimension: 'capability', source: 'benchmark', value: -0.5 })], NOW);
    expect(high.score).toBe(120); // clamp 1 → 维分 100 → round(0.2×100×10×0.6)（v0.2 为 200）
    expect(low.score).toBe(0);
  });

  it('未知 source 回退默认权重，不抛异常', () => {
    const r = computeScore([ev({ dimension: 'capability', source: 'hacker' as Source })], NOW);
    expect(r.score).not.toBeNull();
    expect(r.score).toBe(120); // 兜底 0.3 权重单条 → 维分仍 100 → round(0.2×100×10×0.6)（v0.2 为 200）
  });

  it('非法维度（运行时传入）被忽略，不崩', () => {
    const r = computeScore([{ dimension: 'not-a-dim' as Dimension, source: 'benchmark', result: 'success' }], NOW);
    expect(r.score).toBeNull();
    expect(r.coverage).toBe(0);
  });
});

describe('[单调性] Monotonicity', () => {
  it('同维度添加成功证据不降低分数', () => {
    const before = computeScore([ev({ dimension: 'capability', source: 'benchmark', result: 'failure' })], NOW);
    const after = computeScore(
      [
        ev({ dimension: 'capability', source: 'benchmark', result: 'failure' }),
        ev({ dimension: 'capability', source: 'benchmark', result: 'success' }),
      ],
      NOW,
    );
    expect(after.score!).toBeGreaterThan(before.score!);
  });
});

describe('[可复现性] Reproducibility', () => {
  it('modelVersion 固定且可追溯', () => {
    expect(SCORE_MODEL_VERSION).toBe('baseline-v0.3');
    expect(computeScore([ev({ dimension: 'capability' })], NOW).modelVersion).toBe(SCORE_MODEL_VERSION);
  });
});

describe('[性能] Performance', () => {
  it('万级证据计算 < 2s（冒烟）', () => {
    const dims = Object.keys(DIMENSION_WEIGHTS) as Dimension[];
    const evidence = Array.from({ length: 10000 }, (_, i) =>
      ev({ dimension: dims[i % 8], source: 'benchmark', result: i % 3 === 0 ? 'failure' : 'success' }),
    );
    const t0 = performance.now();
    computeScore(evidence, NOW);
    expect(performance.now() - t0).toBeLessThan(2000);
  });
});

describe('reliability 重现性 blend（一期）', () => {
  const now = new Date('2026-09-27T00:00:00Z');
  const rel = (r: ReturnType<typeof computeScore>) =>
    r.dimensions.find((d) => d.dimension === 'reliability')!;

  it('有证据 + 有快照 → 各半 blend，consistency 字段随行', () => {
    const r = computeScore(
      [
        { dimension: 'reliability', source: 'real-benchmark', value: 1, timestamp: now },
        { dimension: 'reliability', source: 'real-benchmark', value: 1, timestamp: now },
        { dimension: 'reliability', source: 'real-benchmark', value: 1, timestamp: now },
      ],
      now,
      [
        { score: 500, modelVersion: 'baseline-v0.3', snapshotAt: '2026-09-25T00:00:00Z' },
        { score: 510, modelVersion: 'baseline-v0.3', snapshotAt: '2026-09-26T00:00:00Z' },
      ],
    );
    // v0.3 重算：real-benchmark 证据封顶 → 维分 85；cons=86.67；blend = 0.5×85+0.5×86.67 = 85.835 → round2 = 85.84
    expect(rel(r).score).toBe(85.84);
    expect(rel(r).consistency).toBe(86.67);
    expect(rel(r).evidenceCount).toBe(3);
  });

  it('无证据 + 稳定快照 → 一致性独撑，封顶 50', () => {
    const r = computeScore([], now, [
      { score: 500, modelVersion: 'v', snapshotAt: '2026-09-25T00:00:00Z' },
      { score: 500, modelVersion: 'v', snapshotAt: '2026-09-26T00:00:00Z' },
    ]);
    expect(rel(r).score).toBe(50);
    expect(rel(r).consistency).toBe(100);
    expect(rel(r).evidenceCount).toBe(0);
  });

  it('无证据 + 剧烈漂移快照 → 一致性 0（min(0,50)=0）', () => {
    const r = computeScore([], now, [
      { score: 400, modelVersion: 'v', snapshotAt: '2026-09-25T00:00:00Z' },
      { score: 600, modelVersion: 'v', snapshotAt: '2026-09-26T00:00:00Z' },
    ]);
    expect(rel(r).score).toBe(0);
  });

  it('只有跨版本快照 → reliability 保持 null（不激活）', () => {
    const r = computeScore([], now, [
      { score: 900, modelVersion: 'v0.1', snapshotAt: '2026-09-01T00:00:00Z' },
      { score: 400, modelVersion: 'v0.2', snapshotAt: '2026-09-02T00:00:00Z' },
    ]);
    expect(rel(r).score).toBeNull();
    expect(rel(r).consistency).toBeUndefined();
  });

  it('不传快照 → 第三参可选、向后兼容（v0.3：封顶 0.85 与覆盖置信系数照常生效）', () => {
    const r = computeScore(
      [{ dimension: 'reliability', source: 'real-benchmark', value: 1, timestamp: now }],
      now,
    );
    // v0.3 重算：real-benchmark value 1 → 维分 = min(1, 0.85)×100 = 85（公开题面封顶）；
    // 总分 = round(0.2×85×10 × (0.5+0.5×0.2)) = round(170×0.6) = 102
    expect(rel(r).score).toBe(85);
    expect(r.score).toBe(102);
  });

  describe('v0.3 口径重标定', () => {
    const now = new Date('2026-09-27T00:00:00Z');

    it('real-benchmark 单题计分上限 0.85（背题刷不满）', () => {
      const r = computeScore(
        [{ dimension: 'capability', source: 'real-benchmark', value: 1, timestamp: now }],
        now,
      );
      expect(r.dimensions.find((d) => d.dimension === 'capability')!.score).toBe(85);
    });

    it('上限不抬高低值证据（0.5 保持 0.5）', () => {
      const r = computeScore(
        [{ dimension: 'capability', source: 'real-benchmark', value: 0.5, timestamp: now }],
        now,
      );
      expect(r.dimensions.find((d) => d.dimension === 'capability')!.score).toBe(50);
    });

    it('result 型 success 同样封顶（宣称满分也按 0.85 计）', () => {
      const r = computeScore(
        [{ dimension: 'integrity', source: 'real-benchmark', result: 'success', timestamp: now }],
        now,
      );
      expect(r.dimensions.find((d) => d.dimension === 'integrity')!.score).toBe(85);
    });

    it('arena / real-confidential 不受公开题面封顶', () => {
      const r = computeScore(
        [{ dimension: 'delivery', source: 'arena', value: 1, timestamp: now }],
        now,
      );
      expect(r.dimensions.find((d) => d.dimension === 'delivery')!.score).toBe(100);
    });

    it('SOURCE_WEIGHTS 补 arena=1.0（修复静默兜底 0.3）', () => {
      expect(SOURCE_WEIGHTS['arena']).toBe(1.0);
    });

    it('覆盖置信系数：score = round(Σw×s×10 × (0.5+0.5×coverage))', () => {
      // v0.3 重算：单维 capability real-benchmark value 1 → 维分 85（封顶），coverage=0.2
      // score = round(0.2×85×10 × 0.6) = round(170×0.6) = 102
      const r = computeScore(
        [{ dimension: 'capability', source: 'real-benchmark', value: 1, timestamp: now }],
        now,
      );
      expect(r.score).toBe(102);
    });

    it('8 维全覆盖时系数=1，满分语义不变', () => {
      // 构造 8 维各 100 分（用非 real-benchmark 源避开封顶）
      // weightedSum = Σw×100 = 100，cov=1 → 系数 1 → round(100×10×1) = 1000
      const evidence = (
        ['capability', 'reliability', 'delivery', 'economic', 'collaboration', 'security', 'negotiation', 'integrity'] as const
      ).map((dimension) => ({ dimension, source: 'verified' as const, value: 1, timestamp: now }));
      expect(computeScore(evidence, now).score).toBe(1000);
    });

    it('modelVersion = baseline-v0.3', () => {
      expect(computeScore([], now).modelVersion).toBe('baseline-v0.3');
    });
  });
});
