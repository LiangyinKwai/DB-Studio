#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
PG_BIN=$(printenv PG_BIN || true)
if [ -z "$PG_BIN" ]; then PG_BIN=/opt/homebrew/opt/postgresql@17/bin; fi
TMPBASE=$(printenv TMPDIR || true)
if [ -z "$TMPBASE" ]; then TMPBASE=/tmp; fi
TMP=$(mktemp -d "$TMPBASE/db-studio-pg.XXXXXX")
PORT=$(printenv DB_STUDIO_TEST_PGPORT || true)
if [ -z "$PORT" ]; then PORT=$((39000 + $(jot -r 1 0 999 2>/dev/null || echo 17))); fi
cleanup() {
  "$PG_BIN/pg_ctl" -D "$TMP" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "$TMP"
}
trap cleanup EXIT INT TERM
"$PG_BIN/initdb" -D "$TMP" --no-locale --encoding=UTF8 -U dbstudio_test -A trust >/dev/null
"$PG_BIN/pg_ctl" -D "$TMP" -o "-h 127.0.0.1 -p $PORT" -w start >/dev/null
export DB_STUDIO_TEST_PGHOST=127.0.0.1
export DB_STUDIO_TEST_PGPORT=$PORT
export DB_STUDIO_TEST_PGUSER=dbstudio_test
export DB_STUDIO_TEST_PGDATABASE=postgres
cd "$ROOT"
node scripts/generate-structure-probe.mjs "$TMP/structure-plan.sql"
export DB_STUDIO_TEST_STRUCTURE_SQL="$TMP/structure-plan.sql"
cargo test --locked --manifest-path src-tauri/Cargo.toml "${DB_STUDIO_PG_TEST_FILTER:-postgres_}" -- --ignored --nocapture
