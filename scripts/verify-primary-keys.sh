#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
PG_BIN=${PG_BIN:-/opt/homebrew/opt/postgresql@17/bin}
PROBE_DIR=$(mktemp -d "${TMPDIR:-/tmp}/db-studio-pk.XXXXXX")
PROBE_PORT=${DB_STUDIO_TEST_PGPORT:-39537}
cleanup() {
  "$PG_BIN/pg_ctl" -D "$PROBE_DIR" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "$PROBE_DIR"
}
trap cleanup EXIT INT TERM
"$PG_BIN/initdb" -D "$PROBE_DIR" --no-locale --encoding=UTF8 -U dbstudio_test -A trust >/dev/null
"$PG_BIN/pg_ctl" -D "$PROBE_DIR" -o "-h 127.0.0.1 -p $PROBE_PORT" -w start >/dev/null
export DB_STUDIO_TEST_PGHOST=127.0.0.1 DB_STUDIO_TEST_PGPORT=$PROBE_PORT DB_STUDIO_TEST_PGUSER=dbstudio_test DB_STUDIO_TEST_PGDATABASE=postgres
cd "$ROOT"
cargo test --locked --manifest-path src-tauri/Cargo.toml --bin db-studio postgres_primary_key_values_runtime_contract -- --ignored --nocapture
