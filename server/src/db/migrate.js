/**
 * Minimal forward-only migration runner.
 *
 * No ORM and no migration framework: the schema here is small and hand-written
 * SQL keeps the dependency surface honest. What this does need to be is
 * *idempotent* and *safe to run from more than one process at once*, because
 * it runs on every boot and the backend is meant to be able to scale past a
 * single replica.
 *
 * Both properties come from the same two mechanisms:
 *   - a `schema_migrations` ledger, so an already-applied file is skipped;
 *   - a Postgres advisory lock, so two replicas booting simultaneously take
 *     turns instead of both trying to create the same table.
 */

import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from './pool.js';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

// Any constant works as long as every replica uses the same one; this is just
// a recognisable arbitrary number for "the migration lock".
const ADVISORY_LOCK_KEY = 4_071_205;

export async function migrate({ log = console } = {}) {
  // Fastify's logger exposes `.info`, bare console exposes `.log`. Resolve it
  // once rather than at each call site: `log.info?.(m) ?? log.log(m)` looks
  // like it works but double-prints, because console.info returns undefined
  // and so the ?? branch fires as well.
  const info = (msg) => (typeof log.info === 'function' ? log.info(msg) : log.log(msg));

  const client = await pool.connect();
  try {
    // Blocks until whichever replica got here first has finished. Session-level
    // (not transaction-level) so it spans every migration in this run.
    await client.query('select pg_advisory_lock($1)', [ADVISORY_LOCK_KEY]);

    await client.query(`
      create table if not exists schema_migrations (
        name text primary key,
        applied_at timestamptz not null default now()
      )
    `);

    const applied = new Set(
      (await client.query('select name from schema_migrations')).rows.map((r) => r.name)
    );

    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();

    let ran = 0;
    for (const name of files) {
      if (applied.has(name)) continue;

      const sql = await readFile(join(MIGRATIONS_DIR, name), 'utf8');
      // Each migration and its ledger entry commit together, so a failure
      // half-way through can never leave the ledger claiming success.
      try {
        await client.query('begin');
        await client.query(sql);
        await client.query('insert into schema_migrations (name) values ($1)', [name]);
        await client.query('commit');
      } catch (err) {
        await client.query('rollback');
        throw new Error(`Migration ${name} failed: ${err.message}`, { cause: err });
      }

      info(`[migrate] applied ${name}`);
      ran++;
    }

    info(`[migrate] up to date (${files.length} total, ${ran} newly applied)`);
    return { total: files.length, applied: ran };
  } finally {
    await client.query('select pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]).catch(() => {});
    client.release();
  }
}

// Allow `npm run migrate` as a standalone command, not only as a boot step.
if (import.meta.url === `file://${process.argv[1]}`) {
  migrate()
    .then(() => pool.end())
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
