-- Store session and password-reset tokens hashed, not in plaintext.
--
-- Until now the token WAS the row's primary key (see 001_accounts.sql,
-- 003_password_resets.sql), so a database read — a leaked backup, a
-- misconfigured read replica, an unrelated SQL injection elsewhere — handed
-- over directly usable bearer tokens for every active session. This closes
-- that: the app now generates the token, hashes it (SHA-256; the token is
-- already 256 bits of real entropy, so a slow KDF like argon2 would defend
-- against nothing a fast hash doesn't already defend against) and stores only
-- the hash. The raw token exists only in the cookie and briefly in memory on
-- each request; the database never sees it.
--
-- There is no way to backfill a hash for a token this migration cannot read,
-- so this is a hard cut: every existing session and pending reset link is
-- invalidated. Deliberate and one-time — anyone signed in is signed back out
-- and has to log in again; anyone with a reset email in flight has to request
-- a new one.
truncate table sessions, password_resets;

alter table sessions
  drop constraint sessions_pkey,
  add column id bigserial primary key,
  add column token_hash bytea not null;

alter table sessions alter column token drop default;
alter table sessions drop column token;

create unique index sessions_token_hash_idx on sessions (token_hash);

alter table password_resets
  drop constraint password_resets_pkey,
  add column id bigserial primary key,
  add column token_hash bytea not null;

alter table password_resets alter column token drop default;
alter table password_resets drop column token;

create unique index password_resets_token_hash_idx on password_resets (token_hash);
