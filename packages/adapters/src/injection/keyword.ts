import { detectInjectionHeuristic, type InjectionProbe, type InjectionVerdict } from '@a2t/core';
import type { InjectionDetector } from './types.js';

/** 默认实现：包 core 纯函数，确定性、零出网。 */
export function createKeywordInjectionDetector(): InjectionDetector {
  return {
    name: 'keyword',
    async detect(output: string, probe: InjectionProbe): Promise<InjectionVerdict> {
      return detectInjectionHeuristic(output, probe);
    },
  };
}
