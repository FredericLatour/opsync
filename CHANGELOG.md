# Changelog

## 2.0.0

Initial open-source release under MIT.

- MySQL and PostgreSQL dumps, restores and same-engine transfers.
- End-to-end streaming backups, S3 multipart uploads, folder rolling copies, restores, and transfers.
- Folder/S3 backups, gzip and daily/monthly retention for both databases and n8n.
- `${ENV_VAR}` interpolation in TOML configuration and standard `AWS_*` / `S3_ENDPOINT` environment fallbacks.
- Native clients, per-profile containers and independent transfer containers.
- Safer n8n container discovery, configurable execution user and isolated temporary files.
- Correct S3 pagination, prefix-isolated retention/restore selection and transfer failure reporting.
- Atomic private backup files and byte-level streaming MySQL DEFINER cleanup that preserves binary and literal row values.
- Plain text (`--format text`), Markdown, and JSON reporting with non-TTY confirmation guards.
- Reproducible CI (typecheck, Biome lint, unit tests, Docker round trips), release archives and checksums.
