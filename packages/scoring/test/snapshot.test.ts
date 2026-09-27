import { describe, expect, it } from 'vitest';
import { shouldRecordSnapshot } from '../src/snapshot.js';

describe('shouldRecordSnapshot（快照写入闸门｜重考收口修复）', () => {
  const T1 = '2026-09-27T03:00:00Z';
  const T2 = '2026-09-27T08:00:00Z';

  it('首算：无历史快照 → 必须写（建立基线）', () => {
    expect(shouldRecordSnapshot(null, T1)).toBe(true);
    expect(shouldRecordSnapshot(undefined, T1)).toBe(true);
    expect(shouldRecordSnapshot(null, null)).toBe(true);
  });

  it('有新证据（晚于上一条快照）→ 写', () => {
    expect(shouldRecordSnapshot(T1, T2)).toBe(true);
  });

  it('纯重算（无新证据，最新证据早于上一条快照）→ 不写', () => {
    expect(shouldRecordSnapshot(T2, T1)).toBe(false);
  });

  it('最新证据时间 == 上一条快照 → 不写（非严格更新，防同刻重复）', () => {
    expect(shouldRecordSnapshot(T2, T2)).toBe(false);
  });

  it('有历史快照但当前无证据 → 不写（不是新观测）', () => {
    expect(shouldRecordSnapshot(T1, null)).toBe(false);
    expect(shouldRecordSnapshot(T1, undefined)).toBe(false);
  });

  it('Date 与 ISO 字符串混用同样判定', () => {
    expect(shouldRecordSnapshot(new Date(T1), new Date(T2))).toBe(true);
    expect(shouldRecordSnapshot(new Date(T2), new Date(T1))).toBe(false);
    expect(shouldRecordSnapshot(new Date(T1), T2)).toBe(true);
    expect(shouldRecordSnapshot(T2, new Date(T1))).toBe(false);
  });

  it('确定性：同输入多次调用结果一致', () => {
    const r1 = shouldRecordSnapshot(T1, T2);
    const r2 = shouldRecordSnapshot(T1, T2);
    expect(r1).toBe(r2);
    expect(r1).toBe(true);
  });
});
