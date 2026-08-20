-- Author-built vehicles, pinned into the match that will play them.
--
-- Custom vehicles were single-player only, because a match distributes nothing
-- but a seed: only `defId` strings cross the wire, and a peer that receives an
-- id it has never seen skips the unit silently rather than erroring. One
-- player had a tank, the other had empty ground, and neither was told.
--
-- The fix is to give the match a vehicle set of its own, and the reason it is
-- a column on `matches` rather than a join table is that it is an immutable
-- snapshot: written once at creation, read back as one blob, never queried by
-- element. Snapshotting by value also means editing a vehicle afterwards
-- cannot reach into a match already using it — every peer plays the bytes that
-- existed when the lobby opened.
--
-- Empty default so every match predating this, and every match whose host has
-- authored nothing, keeps working with the built-in catalog alone.
alter table matches
  add column if not exists custom_defs jsonb not null default '[]'::jsonb;
