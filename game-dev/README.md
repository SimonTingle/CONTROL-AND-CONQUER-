# game-dev — session continuity snapshot

A copy of the Claude Code context for this project, so a fresh session (or a
different machine) can pick up where this one left off without re-deriving
everything from git history.

- `claude-md/phase2-plan.md` — the full implementation plan for Phase 2
  (AI opponent teams, combat, and elimination). Marked **COMPLETE** at the
  top, with the sub-phase commit hashes and the known limitations carried
  forward (army pathfinding, AI economy pacing, permanent wreckage).
- `memory/` — this project's auto-memory files (persistent notes Claude
  keeps across sessions, e.g. model-selection guidance for planning work).

This folder is a point-in-time copy, not a live sync — the source files
(under `~/.claude/`) are what Claude actually reads each session. Re-copy
after major planning/memory changes if you want this snapshot current.

Deliberately **not** included: the user's global `~/.claude/CLAUDE.md`. It's
private, cross-project instructions rather than anything specific to this
repo, and this repo's git history is pushed to GitHub — so it's kept local
only, out of version control.
