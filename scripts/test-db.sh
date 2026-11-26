#!/usr/bin/env bash
# Builds a throwaway local Postgres database with the app schema, seed data and the test-only
# Data API emulator. Used by `npm test` and local development. Never touches production.
#
# Env: TEST_SERVER_KEY (required), TEST_ADMIN_CODE (required), PGSOCK_DIR, PGDATA_DIR, PGPORT, TEST_DB
set -euo pipefail

: "${TEST_SERVER_KEY:?set TEST_SERVER_KEY}"
: "${TEST_ADMIN_CODE:?set TEST_ADMIN_CODE}"
PGBIN=${PGBIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}
SOCK=${PGSOCK_DIR:-/tmp/ts-pgsock}
DATA=${PGDATA_DIR:-/tmp/ts-pgdata}
PORT=${PGPORT:-54329}
DB=${TEST_DB:-trolleyscout_test}
ROOT=$(cd "$(dirname "$0")/.." && pwd)

as_pg() { if [ "$(id -u)" = 0 ]; then runuser -u postgres -- "$@"; else "$@"; fi; }

if ! "$PGBIN/pg_isready" -h "$SOCK" -p "$PORT" -q 2>/dev/null; then
  mkdir -p "$SOCK"
  [ "$(id -u)" = 0 ] && chown postgres "$SOCK"
  if [ ! -f "$DATA/PG_VERSION" ]; then
    mkdir -p "$DATA" && { [ "$(id -u)" = 0 ] && chown postgres "$DATA" || true; }
    as_pg "$PGBIN/initdb" -D "$DATA" -A trust -U postgres >/dev/null
  fi
  as_pg "$PGBIN/pg_ctl" -D "$DATA" -o "-k $SOCK -p $PORT -c listen_addresses=''" -l "$DATA/server.log" -w start >/dev/null
fi

PSQL=(psql -h "$SOCK" -p "$PORT" -U postgres -X -q -v ON_ERROR_STOP=1)
"${PSQL[@]}" -d postgres -c "drop database if exists $DB" -c "create database $DB" >/dev/null
"${PSQL[@]}" -d "$DB" >/dev/null <<'SQL'
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin; end if;
end $$;
SQL
"${PSQL[@]}" -d "$DB" -f "$ROOT/sql/001_schema.sql" >/dev/null
"${PSQL[@]}" -d "$DB" -f "$ROOT/sql/002_seed.sql" >/dev/null
"${PSQL[@]}" -d "$DB" -f "$ROOT/sql/003_store_locations.sql" >/dev/null
"${PSQL[@]}" -d "$DB" -f "$ROOT/sql/004_user_items.sql" >/dev/null
"${PSQL[@]}" -d "$DB" -f "$ROOT/tests/sql/postgrest_emulator.sql" >/dev/null
KEY_HASH=$(printf '%s' "$TEST_SERVER_KEY" | sha256sum | cut -d' ' -f1)
CODE_HASH=$(printf '%s' "$TEST_ADMIN_CODE" | sha256sum | cut -d' ' -f1)
"${PSQL[@]}" -d "$DB" -v kh="$KEY_HASH" -v ch="$CODE_HASH" >/dev/null <<'SQL'
insert into dl.server_keys (key_hash, label) values (:'kh', 'test');
insert into dl.admin_setup (code_hash, expires_at) values (:'ch', now() + interval '1 day');
SQL
echo "test database ready: $DB on $SOCK:$PORT"
