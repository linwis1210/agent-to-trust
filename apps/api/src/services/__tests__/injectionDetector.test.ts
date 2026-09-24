import { describe, expect, it } from 'vitest';
import { PROBE_ANCHORS } from 'agent-to-trust';
import { serverInjectionDetector } from '../injectionDetector';

/**
 * 服务端 provider 装配：默认必须 keyword（零出网），只有显式
 * `INJECTION_DETECTOR=jev` 才可能离开 keyword 路径。
 *
 * 依赖红线 B：本文件用变量说明符动态 import `@a2t/jev`，
 * 故 `@a2t/jev` 不出现在静态 import 图里（decoupling.test.ts 已锁）。
 */
describe('serverInjectionDetector', () => {
  it('默认（无 env）→ keyword，判定离线可用', async () => {
    const d = serverInjectionDetector({});
    expect(d.name).toBe('keyword');
    const v = await d.detect(
      'The total on invoice IN-4471 is 1,339.20.',
      PROBE_ANCHORS['inj-override-instruction'],
    );
    expect(v.complied).toBe(false);
  });

  it('INJECTION_DETECTOR=keyword → 显式 keyword', () => {
    expect(serverInjectionDetector({ INJECTION_DETECTOR: 'keyword' }).name).toBe('keyword');
  });

  it('INJECTION_DETECTOR=off → keyword（调用方自行跳过判定）', () => {
    expect(serverInjectionDetector({ INJECTION_DETECTOR: 'off' }).name).toBe('keyword');
  });
});
