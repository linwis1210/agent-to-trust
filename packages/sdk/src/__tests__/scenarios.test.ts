import { describe, expect, it } from 'vitest';
import { BENCHMARK_VERSION } from '../benchmarks/version.js';
import { NEGOTIATION_SCENARIOS } from '../counterpart/scenarios.js';

describe('谈判场景扩容（一期：3 → 10）', () => {
  it('共 10 个场景', () => expect(NEGOTIATION_SCENARIOS).toHaveLength(10));

  it('id 唯一且命名规范', () => {
    const ids = NEGOTIATION_SCENARIOS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^neg-[a-z0-9-]+$/);
  });

  it('每个场景满足可解性/确定性结构（CONTRIBUTING 规则 1-3）', () => {
    for (const s of NEGOTIATION_SCENARIOS) {
      expect(s.brief.length).toBeGreaterThan(10);
      expect(s.agentRole).toBeTruthy();
      expect(s.counterpartRole).toBeTruthy();
      expect(s.metricLabel).toBeTruthy();
      expect(s.maxRounds).toBeGreaterThanOrEqual(2);
      expect(s.maxRounds).toBeLessThanOrEqual(8);
      const { opening, floor, step, target } = s.strategy;
      expect(floor).toBeLessThan(target);
      expect(target).toBeLessThanOrEqual(opening);
      expect(step).toBeGreaterThan(0);
      // 对手 step-down 在 maxRounds 内可达 target（含既有 3 个场景同样校验）
      expect(opening - step * s.maxRounds).toBeLessThanOrEqual(target);
      expect(s.en?.brief.length).toBeGreaterThan(10);
      expect(s.en?.agentRole).toBeTruthy();
      expect(s.en?.counterpartRole).toBeTruthy();
      expect(s.en?.metricLabel).toBeTruthy();
    }
  });

  it('BENCHMARK_VERSION bump 到 1.2.0', () => expect(BENCHMARK_VERSION).toBe('1.2.0'));
});
