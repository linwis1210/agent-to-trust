import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { buildApp } from '../src/app';
import { createDb } from '../src/db/client';
import { setupTestDatabase, testDatabaseUrl, truncateAll } from './helpers';

let app: ReturnType<typeof buildApp>;

beforeAll(async () => {
  await setupTestDatabase();
  app = buildApp(createDb(testDatabaseUrl()));
  await app.ready();
});
beforeEach(async () => {
  await truncateAll();
});

describe('score_snapshots.dimensions_snapshot（一期加列，append-only 不回填）', () => {
  it('新快照写入 8 维数组', async () => {
    const agent = await app
      .inject({ method: 'POST', url: '/agents', payload: { name: 'snap-dims' } })
      .then((r) => r.json());
    await app.inject({
      method: 'POST',
      url: `/agents/${agent.id}/evidence`,
      payload: { dimension: 'reliability', source: 'simulation', result: 'success' },
    });
    const res = await app.inject({ method: 'POST', url: `/agents/${agent.id}/score` });
    expect(res.statusCode).toBe(200);

    const pool = new Pool({ connectionString: testDatabaseUrl() });
    const row = (
      await pool.query('SELECT dimensions_snapshot FROM score_snapshots ORDER BY snapshot_at DESC LIMIT 1')
    ).rows[0];
    expect(Array.isArray(row.dimensions_snapshot)).toBe(true);
    expect(row.dimensions_snapshot).toHaveLength(8);
    expect(row.dimensions_snapshot[0]).toHaveProperty('dimension');
    expect(row.dimensions_snapshot[0]).toHaveProperty('score');
    await pool.end();
  });

  it('旧行容忍：dimensions_snapshot 置 null 模拟历史行，读端点不炸', async () => {
    const agent = await app
      .inject({ method: 'POST', url: '/agents', payload: { name: 'snap-old' } })
      .then((r) => r.json());
    await app.inject({ method: 'POST', url: `/agents/${agent.id}/score` });
    const pool = new Pool({ connectionString: testDatabaseUrl() });
    await pool.query('UPDATE score_snapshots SET dimensions_snapshot = NULL');
    // 注意：此 UPDATE 仅作用于测试库（acl_test），生产 append-only 不受影响。
    const res = await app.inject({ method: 'GET', url: `/agents/${agent.id}/score` });
    expect(res.statusCode).toBe(200);
    expect(res.json().dimensions ?? []).toHaveLength(8); // credit_scores.dimensions 不受影响
    await pool.end();
  });
});
