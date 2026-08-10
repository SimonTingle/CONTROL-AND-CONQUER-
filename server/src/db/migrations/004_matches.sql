-- Online multiplayer lobbies.
--
-- The server relays inputs and keeps time; it never simulates. So there is no
-- world state here — only who is playing what, and the seed every client needs
-- to generate an identical world. A match's actual progress lives in the
-- clients' own simulations (and, on a desync, in a snapshot the host supplies).

create table if not exists matches (
  id            uuid primary key default gen_random_uuid(),
  host_user_id  uuid not null references users(id) on delete cascade,
  name          text not null,
  -- The world seed. Every client regenerates terrain from this rather than
  -- downloading it — the same reason snapshots store params, not heightfields.
  seed          bigint not null,
  status        text not null default 'open'
                  check (status in ('open', 'running', 'finished', 'abandoned')),
  max_players   int  not null default 2 check (max_players between 2 and 4),
  ai_count      int  not null default 0 check (ai_count between 0 and 3),
  difficulty_id text not null default 'normal',
  created_at    timestamptz not null default now(),
  started_at    timestamptz
);

create table if not exists match_players (
  match_id  uuid not null references matches(id) on delete cascade,
  user_id   uuid not null references users(id) on delete cascade,
  -- Which team this player drives. Assigned on join, and the ordering that
  -- makes lockstep input application deterministic across clients.
  team_id   int  not null,
  joined_at timestamptz not null default now(),
  primary key (match_id, user_id),
  -- Two players cannot share a team, and a team cannot be claimed twice.
  unique (match_id, team_id)
);

-- The lobby list: open matches, newest first.
create index if not exists matches_open_idx
  on matches (status, created_at desc)
  where status = 'open';

create index if not exists match_players_user_idx
  on match_players (user_id);
