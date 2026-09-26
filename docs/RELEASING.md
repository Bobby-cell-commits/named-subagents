# Releasing

Releases are automated: **push a `vX.Y.Z` tag and the `Release` workflow
(`.github/workflows/release.yml`) publishes to PyPI and creates a GitHub
release.** The plugin needs no publish step: `claude plugin update` reads the
version from `.claude-plugin/plugin.json` on `master`.

The npm package was retired in 0.7.1; nothing publishes to npm any more.

## Supply-chain model

PyPI uses **Trusted Publishing (OIDC)**: no API token is stored anywhere. The
`pypi` job holds only `id-token: write` + `contents: read`. A `verify` job runs
every test suite, runs `doctor`, and asserts the pushed tag matches the declared
version **before** the publish job runs — publishing is irreversible, so a
mistagged or red build fails closed.

## One-time setup (already done for this repo)

1. Log in to <https://pypi.org>. For an unclaimed name, add a **pending
   publisher** (*Account → Publishing*) so the first release can create it.
2. Fill in: project `named-subagents`, owner `Bobby-cell-commits`, repository
   `named-subagents`, workflow `release.yml`, environment blank.

## Cutting a release

1. **Bump the version in all three files** (`doctor` checks they agree; the
   `verify` job checks the tag against `pyproject.toml`):
   - `pyproject.toml` → `version = "X.Y.Z"`
   - `named_subagents/__init__.py` → `__version__ = "X.Y.Z"`
   - `.claude-plugin/plugin.json` → `"version": "X.Y.Z"` (plugin users only get
     an update when this changes)
2. **Add a `## [X.Y.Z] — YYYY-MM-DD` section to `CHANGELOG.md`.** The
   `github-release` job publishes this section verbatim as the release notes.
3. Verify locally:
   ```bash
   for t in tests/test_*.py; do python3 "$t" || break; done
   pip install -e . && named-subagents doctor
   ```
4. Commit, push `master`, wait for CI to go green, then tag and push the tag:
   ```bash
   git tag -a vX.Y.Z -m vX.Y.Z && git push origin vX.Y.Z
   ```
5. Watch **Actions → Release**: `verify` → `pypi` → `github-release`. Then run
   `claude plugin marketplace update named-subagents` and
   `claude plugin update named-subagents@named-subagents` to pick it up locally.

## Optional hardening

- **GitHub environment gate:** add `environment: release` to the `pypi` job,
  create a `release` environment with required reviewers, and set the PyPI
  trusted publisher's *Environment name* to `release`.
- **Tag protection:** protect `v*` tags so only maintainers can trigger a publish.
