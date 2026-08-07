-- Password reset tokens.
--
-- Same shape as sessions (001_accounts.sql) and the same reasoning: an opaque
-- uuid primary key rather than a signed/JWT-style token, so validity lives in
-- one place (this table) and can be revoked/consumed by just updating a row,
-- with no separate denylist to keep in sync.

create table if not exists password_resets (
  token      uuid primary key default uuid_generate_v4(),
  user_id    uuid not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  -- Set instead of deleting the row, so a reused/expired link can tell the
  -- difference between "never existed" and "already used" while debugging —
  -- same reasoning sessions.revoked_at already uses.
  used_at    timestamptz
);

create index if not exists password_resets_user_id_idx on password_resets (user_id);
create index if not exists password_resets_expires_at_idx on password_resets (expires_at);
