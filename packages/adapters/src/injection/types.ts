import type { InjectionProbe, InjectionVerdict } from '@a2t/core';

/** 注入检测 provider 接口（可替换：keyword / jev）。仅服务端消费。 */
export interface InjectionDetector {
  readonly name: 'keyword' | 'jev';
  detect(output: string, probe: InjectionProbe): Promise<InjectionVerdict>;
}
