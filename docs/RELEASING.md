# Releasing Opsync

`package.json` supplies the CLI version, archive names, and tag validation.

## Local validation and packaging

```sh
bun install --frozen-lockfile --ignore-scripts
bun run check
bun run test:integration
bun run release:build bun-darwin-arm64
```

Supported package targets are `bun-linux-x64`, `bun-linux-arm64`,
`bun-darwin-x64`, and `bun-darwin-arm64`. Cross-compilation may download Bun's
target runtime. Archives and `.sha256` checksums are written to `dist/release/`.
Each archive contains the executable, license, dependency notices, README, and
example configuration.

## GitHub releases, once a repository is set up

The workflow definitions in `.github/workflows/` are ready for a future repository.
They run checks and isolated Docker integration tests, build each target on its
native architecture, verify checksums, and create a draft release.

1. Update `package.json` and `CHANGELOG.md`. Use semantic versioning and describe
   breaking changes explicitly.
2. Merge after CI passes, then create a tag matching the package version:

   ```sh
   git tag -a v2.0.0 -m "Opsync 2.0.0"
   git push origin v2.0.0
   ```

3. Review the resulting draft's assets and release notes, then publish it.

A mismatched tag/version fails before publication. Do not move published tags;
release a new version for fixes. If a draft already exists, inspect it before
replacing its assets. The workflow uses the repository's `GITHUB_TOKEN`; no npm
account or publishing token is needed.
