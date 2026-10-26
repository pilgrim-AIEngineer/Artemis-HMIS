# syntax=docker/dockerfile:1
# Backup container (OPS-01, docs/31 §3): scheduled `pg_dump` + restic (encrypted) to the local
# staging disk, the rotating USB disk and an S3-compatible bucket, plus the restore tooling used by
# update.sh (rollback) and restore-drill.sh. Based on the Postgres image so pg_dump/pg_restore and
# the throwaway server used by the restore drill match the production major version.
ARG PG_IMAGE=postgres:17
FROM ${PG_IMAGE}

RUN apt-get update \
    && apt-get install -y --no-install-recommends restic jq ca-certificates tzdata util-linux \
    && rm -rf /var/lib/apt/lists/*

COPY backup-run.sh backup-loop.sh restore-db.sh drill.sh /usr/local/bin/
RUN chmod 0755 /usr/local/bin/backup-run.sh /usr/local/bin/backup-loop.sh \
    /usr/local/bin/restore-db.sh /usr/local/bin/drill.sh

ENV TZ=Asia/Kolkata \
    BACKUP_DIR=/backup \
    FILES_DIR=/data/files \
    USB_DIR=/usb
# The entrypoint of the postgres image would start a server; this container only runs the loop.
ENTRYPOINT []
CMD ["backup-loop.sh"]
