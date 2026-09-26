import { describe, it, expect } from 'vitest';
import { normalizeAgentName, normalizeHandle } from '../agentIdentity';

describe('normalizeAgentName', () => {
  it('大小写折叠 + 去首尾空白', () => {
    expect(normalizeAgentName('  Claude-Code ')).toBe('claude-code');
  });
  it('全角字母归一（NFKC）', () => {
    expect(normalizeAgentName('Ｃlaude-code')).toBe('claude-code');
  });
  it('内部空白折叠为单空格', () => {
    expect(normalizeAgentName('my   agent')).toBe('my agent');
  });
  it('西里尔同形字不与拉丁等价（不误伤，但也不串号）', () => {
    // нормализация 不把西里尔 с 变成拉丁 c；两者是不同名字（防抢名靠 ASCII 白名单另议）
    expect(normalizeAgentName('сlaude')).not.toBe(normalizeAgentName('claude'));
  });
  it('空串 → 空串（调用方据此拒绝）', () => {
    expect(normalizeAgentName('   ')).toBe('');
  });
});

describe('normalizeHandle', () => {
  it('去前导 @、小写、NFKC', () => {
    expect(normalizeHandle('@Jeremy')).toBe('jeremy');
    expect(normalizeHandle('  @ＪＥＲＥＭＹ ')).toBe('jeremy');
  });
  it('非法字符 → null', () => {
    expect(normalizeHandle('a b')).toBeNull();
    expect(normalizeHandle('@')).toBeNull();
    expect(normalizeHandle('x'.repeat(33))).toBeNull();
  });
  it('合法字符集：字母数字 . _ -', () => {
    expect(normalizeHandle('j.doe_01-x')).toBe('j.doe_01-x');
  });
});
