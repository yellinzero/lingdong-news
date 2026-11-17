# Versions and releases

[简体中文](../releasing.md) · English

## Set the version

```sh
pnpm version:set 0.1.1
pnpm version:check
```

`VERSION` uses `X.Y.Z`. The command updates manifests and both READMEs.

## Publish

Enable GitHub Actions; publishing uses the repository's `GITHUB_TOKEN`.

| Trigger | Action |
| --- | --- |
| Only README, docs or source-adapter guides change | Check versions and documentation links; no desktop packages |
| App code, dependencies or build configuration change, or manually run Desktop CI | Full tests and three-platform builds |
| Update VERSION and merge into main, or manually run Stable release | Create `vX.Y.Z` and a stable Release after checks pass |

Assets: universal macOS `.dmg`, Windows x64 `.exe`, Linux x64 `.deb` / `.AppImage`, and `SHA256SUMS`.

Bump published versions before changing code. Rerun failed Actions workflows.
