# Migrations

Forward-only, applied in filename order by `../migrate.js` on every boot.

Naming: `NNN_short_description.sql`, zero-padded so lexical sort matches
intended order (`001_`, `002_`, … — this breaks at 1000, which is a long way
past where this project would want a real migration tool anyway).

Rules:

- **Never edit a migration that has shipped.** It has already been recorded in
  `schema_migrations` on every deployed environment and will not re-run. Add a
  new file instead.
- Each file runs inside its own transaction, so a failure rolls back cleanly
  and the ledger is never left claiming a partial success.
- Prefer `if not exists` / `if exists` guards where Postgres supports them —
  the ledger already prevents re-runs, but it costs nothing to make a file
  survive being applied twice by hand during development.
