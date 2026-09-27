import { describe, expect, it } from 'vitest';
import { dedupeByUriLatest } from '../src/dedup';

/**
 * 重考去重（2026-09-27 事故修复）：同一题（evidenceUri）只保留最新一条算分。
 * 红线：不误伤无 URI 的历史/模拟证据；不改原始证据（纯读侧）。
 */

const row = (uri: string | null, iso: string, tag: string) => ({
  evidenceUri: uri,
  createdAt: new Date(iso),
  tag,
});

describe('[正确性] dedupeByUriLatest — 重考替换旧卷', () => {
  it('同一 URI 两条 → 取较新那条', () => {
    const out = dedupeByUriLatest([
      row('a2t://benchmark/coding-fizzbuzz', '2026-09-14T11:00:00Z', 'old'),
      row('a2t://benchmark/coding-fizzbuzz', '2026-09-27T08:00:00Z', 'new'),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].tag).toBe('new');
  });

  it('顺序颠倒也取新（不依赖输入顺序）', () => {
    const out = dedupeByUriLatest([
      row('a2t://benchmark/coding-sum', '2026-09-27T08:00:00Z', 'new'),
      row('a2t://benchmark/coding-sum', '2026-09-14T11:00:00Z', 'old'),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].tag).toBe('new');
  });

  it('不同 URI 各自保留', () => {
    const out = dedupeByUriLatest([
      row('a2t://benchmark/coding-fib', '2026-09-14T11:00:00Z', 'a'),
      row('a2t://benchmark/coding-sum', '2026-09-14T11:00:00Z', 'b'),
      row('a2t://benchmark/coding-fib', '2026-09-27T08:00:00Z', 'a2'),
    ]);
    expect(out).toHaveLength(2);
    expect(out.map((r) => r.tag).sort()).toEqual(['a2', 'b']);
  });

  it('无 URI 的证据全部保留（不误伤旧数据）', () => {
    const out = dedupeByUriLatest([
      row(null, '2026-09-14T11:00:00Z', 'n1'),
      row(null, '2026-09-27T08:00:00Z', 'n2'),
      row(undefined as unknown as string, '2026-09-14T11:00:00Z', 'n3'),
      row('a2t://benchmark/coding-fib', '2026-09-14T11:00:00Z', 'u1'),
    ]);
    expect(out).toHaveLength(4);
  });

  it('空数组 → 空数组（鲁棒）', () => {
    expect(dedupeByUriLatest([])).toEqual([]);
  });

  it('单批 33 条无重复 → 原样返回（外部用户场景）', () => {
    const rows = Array.from({ length: 33 }, (_, i) =>
      row(`a2t://benchmark/case-${i}`, '2026-09-26T13:40:00Z', `c${i}`),
    );
    expect(dedupeByUriLatest(rows)).toHaveLength(33);
  });

  it('不去重不同来源命名空间（benchmark vs arena）', () => {
    const out = dedupeByUriLatest([
      row('a2t://benchmark/coding-fib', '2026-09-14T11:00:00Z', 'bench'),
      row('a2t://arena/as-1234', '2026-09-14T11:00:00Z', 'arena'),
    ]);
    expect(out).toHaveLength(2);
  });

  it('确定性：同 URI 同时间戳并列 → 结果稳定', () => {
    const mk = () =>
      dedupeByUriLatest([
        row('a2t://benchmark/x', '2026-09-27T08:00:00Z', 'first'),
        row('a2t://benchmark/x', '2026-09-27T08:00:00Z', 'second'),
      ]);
    expect(mk()).toEqual(mk());
    expect(mk()).toHaveLength(1);
  });
});
