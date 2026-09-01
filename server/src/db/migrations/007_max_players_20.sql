-- Raise the online-match player cap from 4 to 20.
--
-- Requested directly: bigger matches, with equal separation between spawn
-- points. The simulation side already scaled to any team count —
-- `findTeamSpawnPoints` (src/core/pick.js) splits a full circle into
-- `count` equal slices regardless of `count`, and `beginMatch`/`createTeams`
-- build however many teams `game.aiMatch.teamCount` says — so this is purely
-- a matchmaking-limit change, not a simulation one.

alter table matches drop constraint matches_max_players_check;
alter table matches add constraint matches_max_players_check
  check (max_players between 2 and 20);
