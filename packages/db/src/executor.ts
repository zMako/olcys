import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/** The one seam between the application and PostgreSQL. */
export interface SqlExecutor {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
  /** Runs a multi-statement script (migrations). */
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}

/**
 * postgres://…  → PostgreSQL server (production, Docker Compose).
 * pglite://dir  → embedded PostgreSQL in a local directory (no server needed).
 * pglite://memory → embedded, in memory (tests).
 */
export async function openDatabase(url: string): Promise<SqlExecutor> {
  if (url.startsWith('pglite://')) {
    const { PGlite } = await import('@electric-sql/pglite');
    const target = url.slice('pglite://'.length);
    if (target !== 'memory') mkdirSync(dirname(target), { recursive: true });
    const db = target === 'memory' ? new PGlite() : new PGlite(target);
    await db.waitReady;
    return {
      query: async (text, params) => ({ rows: (await db.query(text, params as never[])).rows as never[] }),
      exec: async (sql) => void (await db.exec(sql)),
      close: () => db.close(),
    };
  }
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: url });
  return {
    query: async (text, params) => ({ rows: (await pool.query(text, params as never[])).rows as never[] }),
    exec: async (sql) => void (await pool.query(sql)),
    close: () => pool.end(),
  };
}
