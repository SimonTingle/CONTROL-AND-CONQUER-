-- Accounts and sessions.
--
-- Sessions are server-side rows rather than JWTs on purpose: a JWT cannot be
-- revoked before it expires without maintaining a denylist, which is a session
-- table with extra steps. A real table also lets the match websocket answer
-- "is this connection still authorised?" with a single lookup.

create extension if not exists "uuid-ossp";
-- citext gives case-insensitive email comparison at the column level, so
-- "Player@example.com" and "player@example.com" cannot become two accounts.
create extension if not exists "citext";

create table if not exists users (
  id            uuid primary key default uuid_generate_v4(),
  email         citext not null unique,
  password_hash text not null,
  display_name  text not null,
  created_at    timestamptz not null default now()
);

create table if not exists sessions (
  token      uuid primary key default uuid_generate_v4(),
  user_id    uuid not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  -- Set instead of deleting the row, so "this token was explicitly logged out"
  -- stays distinguishable from "this token never existed" while debugging.
  revoked_at timestamptz
);

-- Every authenticated request looks a session up by token (the primary key,
-- already indexed); this second index is for the sweep that clears a user's
-- other sessions and for expiry cleanup.
create index if not exists sessions_user_id_idx on sessions (user_id);
create index if not exists sessions_expires_at_idx on sessions (expires_at);
