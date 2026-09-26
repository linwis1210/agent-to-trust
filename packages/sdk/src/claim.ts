/**
 * a2t claim — 事后认领/自证身份（身份归因 Task 8）。
 *
 * 场景：先用某把钥上了榜，事后想补署名或证明「这个榜上的 agent 是我的」。
 * 两步流（对接服务端 /verify 三端点，Task 7 契约逐字段对齐）：
 *   ① POST /verify/challenge { ref } → { challenge, agentId, name, expiresAt }
 *   ② POST /verify/claim { ref, challenge, submitter, signature, timestamp }
 * 签名体恰好为 canonical JSON：
 *   { action: 'claim', agentId, challenge, submitter: submitter ?? null, timestamp }
 * 其中 agentId 用 **challenge 响应里服务端返回的那个**（不信客户端口说的 ref 解析结果）；
 * 发送体字段与签名体完全镜像（无 submitter 时也显式带 submitter: null）。
 * 一次性动作语义：不重试（网络错误直接抛）。
 */
import { ensureKeypair, signPayload } from './keys.js';

export interface ClaimResponse {
  verified: boolean;
  agentId: string;
  name: string;
  submitterSet: boolean;
}

/** 服务端 /verify/claim 原始响应（含 submitter 回显，T7 契约字段）。 */
interface ClaimServerResponse extends ClaimResponse {
  submitter?: string | null;
}

export interface ClaimOptions {
  /** 榜上的 agent 名或 agentId。 */
  ref: string;
  /** 平台 API 地址（如 https://sealit.cc/api）。 */
  apiBase: string;
  /** 署名 handle（可选；不设则纯自证，不动 owner）。 */
  submitter?: string;
  /** 密钥目录（默认 ~/.a2t；与上传同钥同目录）。 */
  dir?: string;
  /** 注入（测试用）。 */
  fetchImpl?: typeof fetch;
}

/** 提取服务端错误消息（{ error } JSON 或原文），供抛错带上。 */
async function serverError(res: Response): Promise<string> {
  const text = await res.text();
  try {
    const parsed = JSON.parse(text) as { error?: unknown };
    if (typeof parsed.error === 'string') return parsed.error;
  } catch {
    // 非 JSON 响应体，原样返回
  }
  return text;
}

async function postJson(
  doFetch: typeof fetch,
  url: string,
  body: unknown,
): Promise<Response> {
  return doFetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/**
 * 认领/自证：challenge → 本地私钥签名 → claim。
 * 抛错时消息带服务端 error（如「agent 不存在」「签名验证失败」「署名已被占用」）。
 */
export async function claim(opts: ClaimOptions): Promise<ClaimResponse> {
  const keypair = ensureKeypair(opts.dir);
  const doFetch = opts.fetchImpl ?? fetch;
  const base = opts.apiBase.replace(/\/+$/, '');

  // ① 认领挑战
  const challengeRes = await postJson(doFetch, `${base}/verify/challenge`, { ref: opts.ref });
  if (!challengeRes.ok) {
    throw new Error(`获取挑战失败（${challengeRes.status}）：${await serverError(challengeRes)}`);
  }
  const challenge = (await challengeRes.json()) as {
    challenge: string;
    agentId: string;
    name: string;
  };

  // ② 签名 + 认领。签名体与发送体字段完全镜像；agentId 用服务端返回值。
  const timestamp = Date.now();
  const submitter = opts.submitter ?? null;
  const signaturePayload = {
    action: 'claim',
    agentId: challenge.agentId,
    challenge: challenge.challenge,
    submitter,
    timestamp,
  };
  const signature = signPayload(keypair.privateKeyPem, signaturePayload);

  const claimRes = await postJson(doFetch, `${base}/verify/claim`, {
    ref: opts.ref,
    challenge: challenge.challenge,
    submitter,
    signature,
    timestamp,
  });
  if (!claimRes.ok) {
    throw new Error(`认领失败（${claimRes.status}）：${await serverError(claimRes)}`);
  }
  const result = (await claimRes.json()) as ClaimServerResponse;
  // 返回值按 T8 契约只露 4 字段（服务端 submitter 回显不透出，署名展示由 CLI 自持解析链负责）。
  return {
    verified: result.verified,
    agentId: result.agentId,
    name: result.name,
    submitterSet: result.submitterSet,
  };
}
