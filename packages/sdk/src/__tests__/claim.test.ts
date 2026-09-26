import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ensureKeypair, verifyPayload } from '../keys.js';
import { claim } from '../claim.js';

const apiBase = 'https://api.test';

interface CapturedCall {
  url: string;
  method?: string;
  body: Record<string, unknown>;
}

/** 注入 fetchImpl：按 URL 分发 challenge/claim 响应，并捕获全部请求体。 */
function captureFetch(challengeRes: Response, claimRes: Response) {
  const calls: CapturedCall[] = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({
      url,
      method: init?.method,
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
    });
    return url.endsWith('/verify/challenge') ? challengeRes : claimRes;
  });
  return { fetchImpl, calls };
}

describe('claim（认领两步流）', () => {
  it('happy path 带 submitter：两步请求体字段对齐契约，签名体恰好 5 字段且自校验通过', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'a2t-claim-'));
    const keypair = ensureKeypair(dir);
    const { fetchImpl, calls } = captureFetch(
      new Response(
        JSON.stringify({
          challenge: 'ch-uuid-1',
          agentId: 'ag_1',
          name: 'my-agent',
          expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
        }),
        { status: 200 },
      ),
      new Response(
        JSON.stringify({
          verified: true,
          agentId: 'ag_1',
          name: 'my-agent',
          submitterSet: true,
          submitter: 'jeremy',
        }),
        { status: 200 },
      ),
    );

    const res = await claim({ ref: 'my-agent', apiBase, submitter: 'jeremy', dir, fetchImpl });

    // 两次请求、顺序与端点正确
    expect(calls.map((c) => c.url)).toEqual([
      `${apiBase}/verify/challenge`,
      `${apiBase}/verify/claim`,
    ]);
    expect(calls[0]!.method).toBe('POST');

    // ① challenge 请求体：恰好 { ref }
    expect(Object.keys(calls[0]!.body).sort()).toEqual(['ref']);
    expect(calls[0]!.body.ref).toBe('my-agent');

    // ② claim 请求体：字段与签名体完全镜像（submitter 显式在场）
    const body = calls[1]!.body;
    expect(Object.keys(body).sort()).toEqual(['challenge', 'ref', 'signature', 'submitter', 'timestamp']);
    expect(body.ref).toBe('my-agent');
    expect(body.challenge).toBe('ch-uuid-1');
    expect(body.submitter).toBe('jeremy');

    // 时间戳在服务端 10 分钟窗口内
    expect(typeof body.timestamp).toBe('number');
    expect(Math.abs(Date.now() - (body.timestamp as number))).toBeLessThanOrEqual(10 * 60_000);

    // 签名体恰好 5 字段（agentId 用服务端返回的），测试钥自校验通过
    const signaturePayload = {
      action: 'claim',
      agentId: 'ag_1', // challenge 响应里的服务端 id
      challenge: 'ch-uuid-1',
      submitter: 'jeremy',
      timestamp: body.timestamp,
    };
    expect(Object.keys(signaturePayload).sort()).toEqual([
      'action',
      'agentId',
      'challenge',
      'submitter',
      'timestamp',
    ]);
    expect(verifyPayload(keypair.publicKeyPem, signaturePayload, body.signature as string)).toBe(true);

    // 返回值
    expect(res).toEqual({ verified: true, agentId: 'ag_1', name: 'my-agent', submitterSet: true });
  });

  it('happy path 无 submitter：发送体 submitter 为 null、签名含 null、submitterSet false', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'a2t-claim-'));
    const keypair = ensureKeypair(dir);
    const { fetchImpl, calls } = captureFetch(
      new Response(
        JSON.stringify({
          challenge: 'ch-uuid-2',
          agentId: 'ag_2',
          name: 'anon-agent',
          expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
        }),
        { status: 200 },
      ),
      new Response(
        JSON.stringify({
          verified: true,
          agentId: 'ag_2',
          name: 'anon-agent',
          submitterSet: false,
          submitter: null,
        }),
        { status: 200 },
      ),
    );

    const res = await claim({ ref: 'anon-agent', apiBase, dir, fetchImpl });

    const body = calls[0]!.url.endsWith('/verify/claim') ? calls[0]!.body : calls[1]!.body;
    // 发送体显式带 submitter: null（与签名体镜像，非省略键）
    expect(body.submitter).toBeNull();
    expect(JSON.stringify(body)).toContain('"submitter":null');

    // 签名体含 submitter: null 且验签通过
    const signaturePayload = {
      action: 'claim',
      agentId: 'ag_2',
      challenge: 'ch-uuid-2',
      submitter: null,
      timestamp: body.timestamp,
    };
    expect(verifyPayload(keypair.publicKeyPem, signaturePayload, body.signature as string)).toBe(true);

    expect(res).toEqual({ verified: true, agentId: 'ag_2', name: 'anon-agent', submitterSet: false });
  });

  it('challenge 步 404 → 抛错并带上服务端 error 消息', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'a2t-claim-'));
    const { fetchImpl } = captureFetch(
      new Response(JSON.stringify({ error: 'agent 不存在' }), { status: 404 }),
      new Response('{}', { status: 200 }),
    );
    await expect(claim({ ref: 'ghost', apiBase, dir, fetchImpl })).rejects.toThrow(/agent 不存在/);
  });

  it('claim 步 401 → 抛错（签名验证失败）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'a2t-claim-'));
    const { fetchImpl, calls } = captureFetch(
      new Response(
        JSON.stringify({
          challenge: 'ch-uuid-3',
          agentId: 'ag_3',
          name: 'x',
          expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
        }),
        { status: 200 },
      ),
      new Response(JSON.stringify({ error: '签名验证失败' }), { status: 401 }),
    );
    await expect(claim({ ref: 'x', apiBase, dir, fetchImpl })).rejects.toThrow(/签名验证失败/);
    expect(calls).toHaveLength(2); // 两步都发出后才失败
  });

  it('challenge 步失败后不发第二次请求', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'a2t-claim-'));
    const { fetchImpl, calls } = captureFetch(
      new Response(JSON.stringify({ error: '该 agent 无公钥，不可认领' }), { status: 422 }),
      new Response('{}', { status: 200 }),
    );
    await expect(claim({ ref: 'nokey', apiBase, dir, fetchImpl })).rejects.toThrow(/无公钥/);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${apiBase}/verify/challenge`);
  });
});
