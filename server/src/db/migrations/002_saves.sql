-- Cloud saves. One row per save slot per user.
--
-- The snapshot lives in a jsonb column rather than a blob: it is genuinely
-- structured data, and jsonb lets a future migration reach inside a payload
-- (say, to bump schema_version) without reading and rewriting every row from
-- the application.

create table if not exists saves (
  id             uuid primary key default uuid_generate_v4(),
  user_id        uuid not null references users(id) on delete cascade,
  name           text not null,
  mode           text,
  -- Mirrors the snapshot's own schemaVersion so old saves can be found and
  -- migrated with a query instead of a full scan of the payloads.
  schema_version int not null,
  payload        jsonb not null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- Every listing is "this user's saves, newest first".
create index if not exists saves_user_id_updated_at_idx
  on saves (user_id, updated_at desc);

-- Saving to the same slot name overwrites rather than accumulating; this is
-- what makes that an upsert instead of a read-then-insert race.
create unique index if not exists saves_user_id_name_key
  on saves (user_id, name);
