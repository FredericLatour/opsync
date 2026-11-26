# Contributing

Use the Bun version in `.bun-version` and install with
`bun install --frozen-lockfile --ignore-scripts`. Run `bun run check` before opening
a pull request. Changes to database commands, S3 storage, or n8n execution should also pass
`bun run test:integration` against the disposable fixtures.

Include a regression test for a corrected behavior. Keep real credentials,
configuration files, SQL dumps and exported workflows out of issues and commits.
Use placeholders and isolated fixtures when reporting failures. Describe the
client/server versions and whether the client runs natively or in Docker.

Update the README for changed public options. Keep `package.json` as the single
source of the CLI version. Dependency changes must include `bun.lock` and pass a
frozen install. Contributions are provided under MIT.
