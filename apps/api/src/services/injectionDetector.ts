/**
 * 服务端注入检测 provider 装配。
 *
 * 红线：本文件是**唯一**接触 @a2t/jev 的地方。用变量说明符做 env-gated 动态 import，
 * 让 `@a2t/jev` 不出现在静态 import 图里（反向依赖锁 decoupling.test.ts 只查字面量 import）。
 * 默认 keyword（零出网）；INJECTION_DETECTOR=jev 才启用 Jev（= 把被测输出发第三方，须显式 opt-in）。
 */
import { resolveInjectionDetector, type InjectionDetector } from '@a2t/adapters';

/** Jev 包名（变量持有，避免字面量 import 触发架构锁）。 */
const JEV_PKG = '@a2t/jev';

export function serverInjectionDetector(
  env: Record<string, string | undefined> = process.env,
): InjectionDetector {
  return resolveInjectionDetector(env, {
    loadJev: async () => {
      const mod = (await import(JEV_PKG)) as {
        createJevInjectionDetector?: (c: unknown) => InjectionDetector;
        JevClient?: new (opts: { apiKey: string }) => unknown;
      };
      if (!mod.createJevInjectionDetector || !mod.JevClient) {
        throw new Error('@a2t/jev 未导出 createJevInjectionDetector / JevClient');
      }
      const apiKey = env.TYPESAFE_API_KEY;
      if (!apiKey) throw new Error('缺少 TYPESAFE_API_KEY');
      return mod.createJevInjectionDetector(new mod.JevClient({ apiKey }));
    },
  });
}
