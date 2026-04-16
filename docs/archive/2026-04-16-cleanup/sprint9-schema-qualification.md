# Sprint 9: Schema Qualification (Track A — Database Infrastructure)

## Context

Production database (`segundo-db`) requires all tables in the `bedrock` schema. Current code uses unqualified table names (e.g., `CREATE TABLE project`) which default to the `public` schema where `bedrock_user` has no write access. Every SQL statement must be prefixed with `bedrock.`.

## Prerequisites

- Database access verified: `bedrock` schema exists, `bedrock_user` has CREATE + USAGE
- Connection string: `postgresql://bedrock_user:<password>@34.57.101.141:5432/segundo-db`

## Scope

### Prefix 93 SQL statements across 7 files

| File | SELECT | INSERT | UPDATE | DELETE | DDL | Total |
|---|---|---|---|---|---|---|
| `db/init.sql` | 0 | 3 | 4 | 0 | 24 | 31 |
| `db/seed.sql` | 0 | 12 | 6 | 0 | 0 | 18 |
| `routes/projects.py` | 3 | 4 | 3 | 4 | 0 | 14 |
| `routes/permissions.py` | 12 | 4 | 5 | 2 | 0 | 23 |
| `routes/sf_dependencies.py` | 2 | 1 | 0 | 1 | 0 | 4 |
| `main.py` | 3 | 0 | 0 | 0 | 0 | 3 |
| `routes/ai.py` | 1 | 0 | 0 | 0 | 0 | 1 |

DDL includes: CREATE TABLE, CREATE INDEX, ALTER TABLE, COMMENT ON TABLE, REFERENCES, triggers.

### Update DATABASE_URL

- `db.py` line 19: default changes from `postgresql://bedrock@localhost:5432/bedrock` to production connection string via env var
- No hardcoded production credentials in code

### Test against segundo-db

- Run `init.sql` against segundo-db and verify all 9 tables are created in `bedrock` schema
- Run `seed.sql` and verify seed data is inserted
- Verify existing app endpoints still work with schema-qualified queries

## Files to modify

- `financial_forecasting/db/init.sql`
- `financial_forecasting/db/seed.sql`
- `financial_forecasting/routes/projects.py`
- `financial_forecasting/routes/permissions.py`
- `financial_forecasting/routes/sf_dependencies.py`
- `financial_forecasting/main.py`
- `financial_forecasting/routes/ai.py`

## Verification

```bash
# After prefixing, run init.sql against segundo-db
psql "postgresql://bedrock_user:...@34.57.101.141:5432/segundo-db" -f financial_forecasting/db/init.sql

# Verify tables exist in bedrock schema
psql ... -c "SELECT tablename FROM pg_tables WHERE schemaname = 'bedrock';"

# Expected: project, workstream, milestone, project_task, sf_task_dependency,
#           sf_task_project, permission_profile, app_user, opportunity_lock

# Start the app with DATABASE_URL pointed at segundo-db and verify health + login
```

## Estimated effort

Small -- mechanical find-and-replace. ~1 session.
