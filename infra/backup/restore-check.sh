#!/usr/bin/env bash
# Prueba que una copia SE PUEDE RESTAURAR: la carga en una base temporal del mismo servidor,
# compara con el origen y borra la temporal. Una copia que nunca se restauró no es una copia.
# Uso:  DATABASE_URL_OWNER=postgresql://... infra/backup/restore-check.sh /ruta/medskin-XXXX.dump
# Necesita permiso CREATEDB para el usuario de la URL.
set -euo pipefail

dump="${1:?falta la ruta de la copia}"
: "${DATABASE_URL_OWNER:?falta DATABASE_URL_OWNER}"

( cd "$(dirname "$dump")" && sha256sum --check "$(basename "$dump").sha256" > /dev/null )

scratch="medskin_restorecheck_$(date -u +%Y%m%d%H%M%S)"
admin_url="${DATABASE_URL_OWNER%/*}/postgres"
scratch_url="${DATABASE_URL_OWNER%/*}/$scratch"

cleanup() { psql "$admin_url" -qc "DROP DATABASE IF EXISTS $scratch" > /dev/null 2>&1 || true; }
trap cleanup EXIT

psql "$admin_url" -qc "CREATE DATABASE $scratch" > /dev/null
pg_restore --no-owner --no-acl --exit-on-error --dbname="$scratch_url" "$dump"

count() { psql "$1" -Atc "select count(*) from $2"; }
for table in drizzle.__drizzle_migrations practice account patient photo; do
  restored="$(count "$scratch_url" "$table")"
  origin="$(count "$DATABASE_URL_OWNER" "$table")"
  # El origen puede haber crecido desde la copia, nunca haber perdido filas respecto a ella.
  if [ "$restored" -gt "$origin" ]; then
    echo "FALLO: $table tiene $restored filas restauradas y $origin en el origen" >&2
    exit 1
  fi
  echo "ok $table: restauradas $restored · origen $origin"
done
echo "restauración comprobada"
