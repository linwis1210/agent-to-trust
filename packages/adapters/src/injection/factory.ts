import type { InjectionProbe, InjectionVerdict } from '@a2t/core';
import type { InjectionDetector } from './types.js';
import { createKeywordInjectionDetector } from './keyword.js';

/** 连续失败阈值 → 熔断。 */
const FAIL_THRESHOLD = 3;
/** 熔断时长。 */
const COOLDOWN_MS = 5 * 60_000;

let failures = 0;
let disabledUntil = 0;

/** 测试隔离：重置熔断状态。 */
export function resetInjectionBreakerForTests(): void {
  failures = 0;
  disabledUntil = 0;
}

function breakerOpen(): boolean {
  return Date.now() < disabledUntil;
}

function recordFailure(): void {
  failures += 1;
  if (failures >= FAIL_THRESHOLD) {
    disabledUntil = Date.now() + COOLDOWN_MS;
    failures = 0;
  }
}

function recordSuccess(): void {
  failures = 0;
}

/** 把任意 provider 包一层熔断 + 降级到 keyword。 */
function withBreaker(primary: InjectionDetector): InjectionDetector {
  const fallback = createKeywordInjectionDetector();
  return {
    name: primary.name,
    async detect(output: string, probe: InjectionProbe): Promise<InjectionVerdict> {
      if (breakerOpen()) return fallback.detect(output, probe);
      try {
        const v = await primary.detect(output, probe);
        recordSuccess();
        return v;
      } catch {
        recordFailure();
        return fallback.detect(output, probe);
      }
    },
  };
}

/**
 * 工厂：读 env 决定 provider。
 * - `INJECTION_DETECTOR=off` → keyword（调用方自行跳过判定）
 * - `INJECTION_DETECTOR=keyword`（默认）→ keyword
 * - `INJECTION_DETECTOR=jev` → 调 opts.loadJev()（由调用方 env-gated 动态 import，
 *   保反向依赖红线：本包**永不**静态/字面量 import @a2t/jev）
 */
export function resolveInjectionDetector(
  env: Record<string, string | undefined>,
  opts: { loadJev?: () => Promise<InjectionDetector> } = {},
): InjectionDetector {
  const kind = (env.INJECTION_DETECTOR ?? 'keyword').toLowerCase();
  if (kind !== 'jev' || !opts.loadJev) return createKeywordInjectionDetector();
  const lazy: InjectionDetector = {
    name: 'jev',
    async detect(output: string, probe: InjectionProbe): Promise<InjectionVerdict> {
      const impl = await opts.loadJev!();
      return impl.detect(output, probe);
    },
  };
  return withBreaker(lazy);
}
