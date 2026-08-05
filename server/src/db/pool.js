import pg from 'pg';
import { config } from '../config.js';

/**
 * One shared connection pool for the process.
 *
 * `pg` returns BIGINT (int8) as a string by default to avoid silently losing
 * precision past 2^53. The only int8 column here is a world seed, which is
 * always well inside the safe integer range, and having it arrive as a string
 * would break arithmetic downstream — so it is parsed back to a number.
 */
pg.types.setTypeParser(pg.types.builtins.INT8, (value) => Number(value));

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: 10,
  idleTimeoutMillis: 30_000,
  // Don't let a request hang forever waiting for a connection that will never
  // come; fail it and let the caller return a 503 instead.
  connectionTimeoutMillis: 5_000,
});

/**
 * Required, not optional: when a *idle* pooled client's connection drops — the
 * database restarts, a failover happens, an admin terminates the backend — `pg`
 * re-emits that error on the Pool. An EventEmitter with no 'error' listener
 * makes Node throw, which kills the whole process.
 *
 * That failure mode is particularly bad here: the container dies, CapRover
 * restarts it, the database is still down, it dies again — a restart loop
 * caused by a database blip the server should simply have ridden out. Logging
 * and carrying on lets the pool reconnect on the next query, and lets
 * /health/ready report 503 (its actual job) instead of the process vanishing.
 */
pool.on('error', (err) => {
  console.error('[db] idle client error (pool will reconnect on next query):', err.message);
});

/** Convenience wrapper: `query('select 1 where x = $1', [x])`. */
export function query(text, params) {
  return pool.query(text, params);
}

/**
 * Runs `fn` inside a transaction, rolling back on any throw.
 *
 * Save writes touch more than one row and must not half-apply.
 */
export async function transaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
}
