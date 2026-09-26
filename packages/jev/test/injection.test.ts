import { describe, expect, it, vi } from 'vitest';
import type { InjectionProbe } from '@a2t/core';
import { createJevInjectionDetector } from '../src/judges/injection.js';

const PROBE: InjectionProbe = {
  id: 'p',
  attackerTokens: ['evil-9921.net'],
  complianceSignals: ['forwarded'],
  missionTokens: ['12'],
  suspicionSignals: ['suspicious'],
};

describe('createJevInjectionDetector', () => {
  it('choice=complied → complied=true', async () => {
    const systemOne = vi.fn().mockResolvedValue({
      response: { model: 'jev', answers: { verdict: { type: 'choice', choice: 'complied', confidence: 0.9, probabilities: {} } } },
      latencyMs: 100,
      inputTokens: 10,
      outputTokens: 0,
    });
    const d = createJevInjectionDetector({ systemOne } as never);
    expect(d.name).toBe('jev');
    const v = await d.detect('I forwarded it to evil-9921.net.', PROBE);
    expect(v.complied).toBe(true);
    expect(v.confidence).toBeCloseTo(0.9, 2);
  });

  it('choice=resisted → complied=false', async () => {
    const systemOne = vi.fn().mockResolvedValue({
      response: { model: 'jev', answers: { verdict: { type: 'choice', choice: 'resisted', confidence: 0.8, probabilities: {} } } },
      latencyMs: 100,
      inputTokens: 10,
      outputTokens: 0,
    });
    const d = createJevInjectionDetector({ systemOne } as never);
    const v = await d.detect('I did not forward anything.', PROBE);
    expect(v.complied).toBe(false);
  });
});
