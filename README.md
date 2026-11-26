# Opsync

Back up, restore, and transfer MySQL and PostgreSQL databases, and back up n8n
workflows and credentials. Store backups locally or in S3-compatible storage,
with optional daily/monthly retention. Built with Bun; released under MIT.

## Install

Download the archive for your OS and CPU from this repository's GitHub Releases,
verify it against `SHA256SUMS`, and extract it. Each archive contains `opsync`,
the license, dependency notices, this README, and an example configuration.

```sh
# Linux; on macOS use: shasum -a 256 -c SHA256SUMS
sha256sum --check --ignore-missing SHA256SUMS
tar -xzf opsync-2.0.0-linux-x64.tar.gz
mkdir -p ~/.local/bin
install -m 755 opsync ~/.local/bin/opsync
opsync --version
opsync --help
```

Add `~/.local/bin` to `PATH` if needed. Binary releases target Linux (glibc) and
macOS, on x64 and arm64. Windows is not currently tested or released.

From source, install the Bun version in `.bun-version`:

```sh
bun install --frozen-lockfile --ignore-scripts
bun run check
bun run build
./dist/opsync --help
```

The binary includes Bun. Database tools remain external: `mysqldump` / `mysql`
for MySQL, `pg_dump` / `psql` for PostgreSQL. Install them locally or use a running
container containing the appropriate clients. n8n operations require Docker,
`tar` on the host, and `sh`, `mktemp`, `grep`, and the n8n CLI inside the container.
Use database clients compatible with the server version.

## Configure

```sh
cp opsync-example.toml opsync.toml
chmod 600 opsync.toml
```

Replace the example connection details. Opsync searches `.opsync.toml`, then
`opsync.toml`, in the working directory and then your home directory. Use
`--config /path/to/file.toml` to select one explicitly. Help and version work
without configuration. Real configuration files, environment files, dumps,
archives, and container overrides are ignored by Git.

```toml
[db.local]
dialect = "pg" # "mysql" is the default when omitted
host = "127.0.0.1"
port = 5432
database = "example"
user = "backup_user"
password = "replace-me"
# container = "my-postgres-container"

[backup_folder]
dir = "./backups"

[rolling]
keep_last = 15
keep_months = 12
```

S3 profiles and n8n settings are documented in
[`opsync-example.toml`](opsync-example.toml). An n8n-only configuration does
not need a `[db]` table. Never commit a real configuration or decrypted
credentials.

### Environment variables

Any string value in TOML supports `${ENV_VAR}` interpolation (escape a literal
dollar-brace as `$${LITERAL}`). Unset variables fail fast during configuration
loading without printing secret values.

```toml
[db.prod]
dialect = "pg"
host = "${PROD_DB_HOST}"
port = 5432
database = "app"
user = "backup_user"
password = "${PROD_DB_PASSWORD}"

# Omitted S3 fields automatically fall back to standard AWS environment variables
[s3.ci]
bucket = "my-backups"
```

When omitted from an `[s3.<label>]` profile, Opsync checks these environment
variables in order:

| `[s3.<label>]` field | Environment variable fallback |
| --- | --- |
| `accessKeyId` | `AWS_ACCESS_KEY_ID` |
| `secretAccessKey` | `AWS_SECRET_ACCESS_KEY` |
| `sessionToken` | `AWS_SESSION_TOKEN` (optional, e.g. STS / OIDC) |
| `region` | `AWS_REGION`, then `AWS_DEFAULT_REGION` |
| `endpoint` | `S3_ENDPOINT`, then `AWS_ENDPOINT_URL_S3`, then `AWS_ENDPOINT_URL` |

## Database commands

```sh
# Full compressed backup; add --mode schema or --mode data as needed
opsync db backup-folder local --dir ./backups
opsync db backup-folder local --dir ./backups --rolling
opsync db backup-s3 local --s3 archive --s3-prefix databases/example --rolling

# Select or exclude tables (space or comma separated)
opsync db backup-folder local --dir ./backups --tables users orders
opsync db backup-folder local --dir ./backups --ignore-tables sessions logs

# Inspect available backups before restoring
opsync db restore-folder local --dir ./backups --list
opsync db restore-folder local --file ./backups/example_timestamp.sql.gz --yes
opsync db restore-s3 local --s3 archive --latest --yes --format json

# Direct table operations
opsync db dump source users orders --output ./selected.sql --yes
opsync db import destination ./selected.sql --yes
opsync db dump-import source destination users orders --yes
```

Run any subcommand with `--help` for all options. Restore and transfer commands
prompt unless `--yes` is provided. Automated restores with `--format json`
require `--yes`. JSON results go to stdout; diagnostics go to stderr. Nonzero
exit status means the operation failed.

Backups default to gzip; use `--no-gzip` for plain SQL. `--database` overrides
the profile database on backup/restore commands. `--file-prefix` gives a backup
set its own name; specify the same prefix when locating it for restore.
Keep different engines, modes, table selections, and environments in distinct
prefixes/directories. Rolling retention keeps the last N daily **files**, plus
one snapshot per UTC month. Keep scheduled writers for one prefix serialized.

## Docker without changing your service definitions

`--container <name-or-id>` executes the client inside an existing container.
A profile's optional `container` is the default; the CLI option overrides it.
Opsync does not require a fixed Compose `container_name`, a mounted Docker socket
inside application containers, or an interactive TTY.

Connection addresses are evaluated **inside the client container**. For a client
in the database container, use `127.0.0.1` and the internal port (3306 or 5432).
For another service on the same Docker network, use its service DNS name.
Host-published ports apply to clients running on the host. `host.docker.internal`
is platform-dependent; Opsync does not add that hostname to Linux containers.

```sh
opsync db backup-folder local --container project-postgres-1 --dir ./backups

# Source and destination can use different containers and internal networks
opsync db dump-import source destination users \
  --source-container source-postgres-1 \
  --target-container destination-postgres-1 --yes
```

The shared `--container` option remains available when one client container can
reach both endpoints. MySQL connections use TCP so `localhost` does not silently
select a Unix socket and ignore the configured port.

## n8n

```sh
opsync n8n backup-s3 --container project-n8n-1 --s3 archive --rolling
opsync n8n restore-s3 --s3 archive --list
opsync n8n restore-s3 --container project-n8n-1 --s3 archive --latest --yes

# Local or mounted folder backups (supports --rolling, --list, --latest, --file)
opsync n8n backup-folder --dir ./backups/n8n --rolling
opsync n8n restore-folder --dir ./backups/n8n --latest --yes
```

Discovery recognizes a unique n8n container by image, Compose service label, or
name. Multiple matches require `--container`. Execution uses the container's
configured user; `--user 1000:1000` or `[backup_n8n].user` overrides it.
No permission-check bypass or root user is imposed.

The archive contains `workflows.json`, `credentials.json`, and `manifest.json`.
Encrypted credentials require the original n8n encryption key on the destination.
Use `--decrypted` only for a deliberate migration and protect the resulting
archive as a secret. `--only workflows` or `--only credentials` limits a restore.
Empty instances produce valid empty backups; credentials are imported before
workflows, and temporary container files are removed on failure.

This is an export of workflows and credentials, **not a complete n8n instance
snapshot**: users, projects/sharing, execution history, binary data, and the
instance encryption key need their own backup plan. Imported items retain their
IDs; collisions can overwrite existing items. Refer to the
[n8n server CLI documentation](https://docs.n8n.io/hosting/cli-commands/).

The optional `docker-compose.n8n.yml` is a local example with a loopback-only
port and a persistent volume. n8n generates its encryption key in that volume.
Keep the volume/key if you need to restore encrypted exports.

## Restore and size limitations

Restores are destructive. Test in an isolated destination first. PostgreSQL
uses native plain SQL and preserves COPY data, functions, and psql markers;
exports omit source ownership, grants, and tablespaces. Schema/full dumps replace
objects included in the dump. Data-only imports require an existing schema and
do not truncate it. Partial table exports may depend on other existing objects.

Commands stop on SQL errors, but previous statements may already have committed.
Transfers require matching dialects and do not convert between database engines.
Database backups, S3 multipart uploads, folder rolling copies, restores, and
direct transfers stream end-to-end so large databases do not buffer full SQL
payloads in RAM. MySQL DEFINER cleanup operates on raw bytes and preserves
non-UTF-8 binary literals. MariaDB-specific clients and flags are not currently
supported/tested.

## Project layout

- `src/`: CLI entry point (`cli.ts`), configuration, storage, rolling, reporting, and domain subfolders (`db/`, `n8n/`, `commands/`).
- `tests/`: unit tests and optional Docker integration tests.
- `tooling/`: build and integration-test runners.
- `docs/`: release instructions.

## Testing

Run commands from the project root after installing dependencies with
`bun install --frozen-lockfile --ignore-scripts`.

```sh
bun run test                 # self-contained tests; Docker suites normally skip
bun run typecheck            # TypeScript checks only
bun run check                # typecheck + self-contained tests
bun run test:integration     # real PostgreSQL, MySQL, n8n, and Garage S3 containers
```

### Self-contained tests

These tests need Bun and the host's `sh`/`tar` utilities, but no database server,
Docker daemon, cloud account, or real credentials. Some use real temporary files,
child processes, or a loopback HTTP server, so they are more than pure unit tests.

| Area | What is exercised |
| --- | --- |
| Configuration and CLI | TOML validation/defaults, missing configuration, help/version without configuration, error messages, JSON output, and invalid restore options. CLI tests launch a separate process with temporary configuration. |
| Database commands | Native/Docker arguments, password handling and redaction, mixed-engine rejection, gzip preparation, and preserving literal data during MySQL DEFINER cleanup. |
| Files and retention | Real filesystem writes, mode 0600, atomic replacement on failure, daily pruning, one monthly snapshot, custom folders, and isolation between filename prefixes. |
| n8n and Docker helpers | Container selection and ambiguity, user overrides, temporary-file cleanup through a stub n8n command, archive round trips, and rejection of links/unexpected archive entries. |
| Reporting | Markdown/JSON formatting and success/error output. |
| S3 listing | A local HTTP fixture exercises the real S3 adapter and Bun S3 client across two listing pages; details below. |

Tests clean up their fixture files afterward. Some use reserved `test-*` paths
in the project root; do not put your own data there or run multiple copies of the
suite concurrently in the same directory.

### How S3 is tested

The integration suite runs a real **Garage S3 container** (`dxflrs/garage:v2.3.0`).
The harness generates fresh access credentials for each run, creates a single-node
cluster and the `opsync-fixture` bucket automatically, and waits until the bucket
accepts S3 requests. No AWS account or application configuration is needed.

[`tests/s3.integration.test.ts`](tests/s3.integration.test.ts) uses Opsync's real
`S3Storage` adapter and Bun S3 client to verify:

- Byte-for-byte upload/download of gzip data, object names containing spaces,
  plus signs and Unicode, storage-prefix normalization, deletion and missing objects.
- An 11 MiB multipart upload, checking the multipart ETag and downloaded bytes.
- Pagination over 1,001 real objects. The test confirms Garage truncates the first
  page and Opsync finds the newest backup on the next page.
- Daily and monthly retention deletion, preservation of other profiles' backups,
  and preservation of the first monthly snapshot.
- Rejection of requests signed with an invalid secret, with errors propagated by
  backup discovery.

The PostgreSQL suite also dumps a fixture database with gzip, uploads it to Garage,
downloads it, and restores it into another database. Assertions check the restored
rows, JSON values, function behavior, and identity sequence state.

Run all of these with Docker Compose v2 available:

```sh
bun run test:integration
```

The fast suite still keeps [`tests/storage.test.ts`](tests/storage.test.ts): a small
loopback HTTP server supplies two deterministic XML listing pages, and a separate
test injects a listing error. These are regression tests for pagination and error
propagation; the HTTP fixture does not validate signatures. To run just these
Docker-free checks:

```sh
bun test tests/storage.test.ts
```

Both approaches require local network access. The integration fixture covers
single-node Garage over HTTP; TLS/reverse-proxy configuration, cluster failures,
fine-grained bucket permissions, and other S3 providers are not covered.

### Docker integration tests

`bun run test:integration` uses [`tooling/integration.ts`](tooling/integration.ts)
and [`compose.test.yml`](compose.test.yml) to create a randomly named Compose
project, start services, wait for health checks, run the integration suites, and
remove the containers/volumes in a `finally` block. Data lives in container tmpfs
mounts. Garage binds an automatically assigned port on `127.0.0.1` so the host's
Bun client can reach it; the other services publish no ports. The only host bind
mount is the read-only [`tests/fixtures/garage.toml`](tests/fixtures/garage.toml)
test configuration. No application data directories are mounted. Docker Compose
v2 is required, and images may be downloaded on the first run.

These tests invoke application functions, native clients and the S3 adapter;
they do not exercise every CLI option or the S3 CLI command handlers.

| Service | Fixture | What the round trips check |
| --- | --- | --- |
| PostgreSQL | `postgres:18` | Schema/full/data dumps, gzip, tables/views/functions, identity sequence state, constraints, table inclusion/exclusion, streaming transfers, and export/import failures. SQL-error tests also check the documented partial-restore behavior. |
| MySQL | `mysql:8.0.46` | Compressed dump/restore with tables and views, preservation of literal DEFINER text in a row, and transfers using per-profile container settings. |
| n8n | `docker.n8n.io/n8nio/n8n:2.34.6` | Empty-instance exports, workflow/credential import and export, decrypted credential contents, archive extraction, and re-import using the container's configured user. |
| S3 | `dxflrs/garage:v2.3.0` | Upload/download/delete, multipart uploads, pagination, retention, invalid signatures, and a PostgreSQL dump/restore through S3. |

The harness supplies `OPSYNC_PG_TEST_CONTAINER`, `OPSYNC_MYSQL_TEST_CONTAINER`,
`OPSYNC_N8N_TEST_CONTAINER`, and `OPSYNC_S3_TEST_CONFIG` (JSON containing the disposable
endpoint, bucket, region and credentials). Without those variables the corresponding
suites skip, which is expected during `bun run test` or `bun run check`. Bun may also count
skipped setup/teardown hooks in its skip total. Use the harness for disposable
fixtures rather than pointing these tests at application containers.

## Building and releases

```sh
bun run build
bun run release:build bun-darwin-arm64
```

See [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), and
[the release guide](docs/RELEASING.md). Opsync is MIT licensed.
