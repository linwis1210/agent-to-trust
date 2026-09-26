/**
 * Agent 身份注册（考场 ingest 与 Arena register 共用）。
 *
 * 密钥即身份：agentId = ext-<slug>-<hash8(pubkey)>；同名不同钥 → name-taken (403)。
 * 保证同一实体在考场 / Arena / 榜单是唯一身份。
 */

import { createHash } from 'node:crypto';
import { and, eq, ne } from 'drizzle-orm';
import type { Database } from '../db/client';
import { agents } from '../db/schema';

/** 名字归一化：NFKC → 空白折叠 → trim → 小写。用于唯一性与同名判定。 */
export function normalizeAgentName(raw: string): string {
  return raw.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** 署名归一化：去前导 @、NFKC、trim、小写；非法返回 null。 */
export function normalizeHandle(raw: string): string | null {
  const h = raw.normalize('NFKC').trim().replace(/^@+/, '').toLowerCase();
  return /^[a-z0-9][a-z0-9_.-]{0,31}$/.test(h) ? h : null;
}

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32) || 'agent'
  );
}

export interface IdentityInput {
  name: string;
  pubkey: string;
  /** 考场 ingest 携带被测 endpoint；Arena 注册不传则保留原值。 */
  endpoint?: string;
  /** 展示用：被测 agent 的模型名（显式上报，未提供保留原值/空）。 */
  model?: string;
  /** 展示用：被测 agent 软件版本（如 claude-code 2.1.258）。 */
  version?: string;
  /** 署名（调用方已过 normalizeHandle 的归一化 handle；不带 = 匿名）。 */
  submitter?: string;
}

export interface IdentityResult {
  agentId: string;
  reused: boolean;
  error?: 'name-taken' | 'owner-taken';
}

export async function upsertAgentIdentity(
  db: Database,
  input: IdentityInput,
): Promise<IdentityResult> {
  const normalized = normalizeAgentName(input.name);
  // 唯一性判定在归一化层：先按归一化名查；未命中再按原始名兑底（兼容历史 NULL 行，R2）。
  const existing =
    (normalized
      ? await db.query.agents.findFirst({ where: eq(agents.nameNormalized, normalized) })
      : null) ?? (await db.query.agents.findFirst({ where: eq(agents.name, input.name) }));
  if (existing) {
    if (existing.pubkey && existing.pubkey !== input.pubkey) {
      return { agentId: existing.id, reused: false, error: 'name-taken' };
    }
    // 署名占用：handle 已被别的 agent 占用 → owner-taken（同一 agent 复用自己的署名不算）
    if (input.submitter) {
      const taken = await db.query.agents.findFirst({
        where: and(eq(agents.owner, input.submitter), ne(agents.id, existing.id)),
      });
      if (taken) {
        return { agentId: existing.id, reused: false, error: 'owner-taken' };
      }
    }
    await db
      .update(agents)
      .set({
        // 密钥即身份：无主名字首次绑钥（先到先得）；已有钥不可被覆盖（name-taken 已在上方拦截）
        pubkey: existing.pubkey ?? input.pubkey,
        verificationLevel: existing.pubkey ? existing.verificationLevel : 'basic',
        endpoint: input.endpoint !== undefined ? input.endpoint : existing.endpoint,
        model: input.model !== undefined ? input.model : existing.model,
        agentVersion: input.version !== undefined ? input.version : existing.agentVersion,
        // D8：owner 仅在「原为空 且 本次带署名」时写入；已有 owner 永不被后续上报改动/清除
        owner: existing.owner ?? input.submitter ?? null,
        // R2：历史 NULL 行经原始名命中 → 顺手补写归一化名（此刻归一化层无冲突，不撞索引）
        nameNormalized: existing.nameNormalized ?? (normalized || null),
        lastSeenAt: new Date(),
      })
      .where(eq(agents.id, existing.id));
    return { agentId: existing.id, reused: true };
  }

  const agentId = `ext-${slugify(input.name)}-${createHash('sha256').update(input.pubkey).digest('hex').slice(0, 8)}`;
  // 新注册：署名若已被占用 → 拒绝落库（先到先得）
  if (input.submitter) {
    const taken = await db.query.agents.findFirst({ where: eq(agents.owner, input.submitter) });
    if (taken) {
      return { agentId, reused: false, error: 'owner-taken' };
    }
  }
  await db
    .insert(agents)
    .values({
      id: agentId,
      name: input.name,
      owner: input.submitter ?? null,
      status: 'active',
      verificationLevel: 'basic',
      pubkey: input.pubkey,
      endpoint: input.endpoint ?? null,
      model: input.model ?? null,
      agentVersion: input.version ?? null,
      nameNormalized: normalized || null,
      lastSeenAt: new Date(),
    })
    .onConflictDoNothing();
  return { agentId, reused: false };
}
