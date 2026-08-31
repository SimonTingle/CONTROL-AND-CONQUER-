/**
 * Cloud saves.
 *
 * Every route here is scoped to `req.user.id` in the SQL itself, not merely
 * checked in JS first — so there is no path where a query could return, or
 * modify, a row belonging to somebody else even if a caller supplies another
 * user's save id.
 */

import { z } from 'zod';
import { query } from '../db/pool.js';

// A world snapshot is a few hundred KB (mostly the base64 fog masks). This cap
// is a sanity bound against a client uploading something enormous, not a
// tuned limit — raise it if real saves ever approach it.
const MAX_PAYLOAD_BYTES = 8 * 1024 * 1024;

const saveBody = z.object({
  name: z.string().trim().min(1).max(64),
  mode: z.string().max(32).nullish(),
  schemaVersion: z.number().int().nonnegative(),
  payload: z.object({}).passthrough(),
});

const uuid = z.string().uuid();

export async function saveRoutes(app) {
  const auth = { onRequest: app.requireAuth };
  // State-changing routes also need the CSRF check — a cookie-authenticated
  // POST/DELETE is exactly what CSRF forges, a GET is not.
  const authWrite = { onRequest: [app.requireAuth, app.csrfUnlessBearer] };

  /** Slot list, without payloads — a save browser doesn't need megabytes to draw a list. */
  app.get('/saves', auth, async (req) => {
    const { rows } = await query(
      `select id, name, mode, schema_version, created_at, updated_at,
              pg_column_size(payload) as size_bytes
         from saves
        where user_id = $1
        order by updated_at desc`,
      [req.user.id]
    );
    return {
      saves: rows.map((r) => ({
        id: r.id,
        name: r.name,
        mode: r.mode,
        schemaVersion: r.schema_version,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        sizeBytes: Number(r.size_bytes),
      })),
    };
  });

  /** One save, with its payload. */
  app.get('/saves/:id', auth, async (req, reply) => {
    if (!uuid.safeParse(req.params.id).success) {
      return reply.code(404).send({ error: 'not_found' });
    }
    const { rows } = await query(
      'select id, name, mode, schema_version, payload, updated_at from saves where id = $1 and user_id = $2',
      [req.params.id, req.user.id]
    );
    const row = rows[0];
    // Deliberately 404 rather than 403 for a save owned by someone else: a 403
    // would confirm the id exists.
    if (!row) return reply.code(404).send({ error: 'not_found' });

    return {
      save: {
        id: row.id,
        name: row.name,
        mode: row.mode,
        schemaVersion: row.schema_version,
        payload: row.payload,
        updatedAt: row.updated_at,
      },
    };
  });

  /**
   * Create or overwrite the named slot.
   *
   * An upsert on (user_id, name) rather than a read-then-insert, so two
   * concurrent saves to the same slot cannot race into a duplicate.
   */
  app.post('/saves', authWrite, async (req, reply) => {
    const parsed = saveBody.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: 'invalid_input', details: parsed.error.flatten().fieldErrors });
    }
    const { name, mode, schemaVersion, payload } = parsed.data;

    const serialized = JSON.stringify(payload);
    if (serialized.length > MAX_PAYLOAD_BYTES) {
      return reply.code(413).send({ error: 'payload_too_large' });
    }

    const { rows } = await query(
      `insert into saves (user_id, name, mode, schema_version, payload)
       values ($1, $2, $3, $4, $5)
       on conflict (user_id, name) do update
         set payload = excluded.payload,
             mode = excluded.mode,
             schema_version = excluded.schema_version,
             updated_at = now()
       returning id, name, mode, schema_version, created_at, updated_at`,
      [req.user.id, name, mode ?? null, schemaVersion, serialized]
    );
    const row = rows[0];
    return reply.code(201).send({
      save: {
        id: row.id,
        name: row.name,
        mode: row.mode,
        schemaVersion: row.schema_version,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      },
    });
  });

  app.delete('/saves/:id', authWrite, async (req, reply) => {
    if (!uuid.safeParse(req.params.id).success) {
      return reply.code(404).send({ error: 'not_found' });
    }
    const { rowCount } = await query('delete from saves where id = $1 and user_id = $2', [
      req.params.id,
      req.user.id,
    ]);
    if (!rowCount) return reply.code(404).send({ error: 'not_found' });
    return { ok: true };
  });
}
