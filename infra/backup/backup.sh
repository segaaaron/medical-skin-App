#!/usr/bin/env bash
# Copia lógica de la base y su comprobación de integridad.
# Uso:  BACKUP_DIR=/ruta DATABASE_URL_OWNER=postgresql://... infra/backup/backup.sh
# Deja `medskin-<UTC>.dump` (formato custom) y `medskin-<UTC>.dump.sha256`, y borra las de más de
# KEEP_DAYS días (14 por omisión). Sale con código distinto de 0 si algo falla.
# No sustituye al archivado continuo de WAL (recuperación a un instante): eso va en el servidor.
set -euo pipefail

: "${BACKUP_DIR:?falta BACKUP_DIR}"
: "${DATABASE_URL_OWNER:?falta DATABASE_URL_OWNER}"
KEEP_DAYS="${KEEP_DAYS:-14}"

mkdir -p "$BACKUP_DIR"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
out="$BACKUP_DIR/medskin-$stamp.dump"

# Se escribe a un nombre temporal y se renombra al final: una copia a medias nunca parece válida.
pg_dump --format=custom --no-owner --no-acl --dbname="$DATABASE_URL_OWNER" --file="$out.partial"
# `--list` lee el índice del archivo: falla si está truncado o corrupto.
pg_restore --list "$out.partial" > /dev/null
mv "$out.partial" "$out"
( cd "$BACKUP_DIR" && sha256sum "$(basename "$out")" > "$(basename "$out").sha256" )

find "$BACKUP_DIR" -name 'medskin-*.dump*' -mtime +"$KEEP_DAYS" -delete
echo "copia lista: $out ($(wc -c < "$out") bytes)"
