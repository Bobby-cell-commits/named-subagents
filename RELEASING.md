# Releasing

Releases are automated: **push a `vX.Y.Z` tag and the `Release` workflow
(`.github/workflows/release.yml`) publishes to PyPI and npm.** There is a
one-time setup per registry (below); after that, every release is a version
bump + a tag.

## Supply-chain model

| Registry | Auth | Attestation |
|---|---|---|
| **PyPI** | Trusted Publishing (OIDC) — **no stored token** | provenance via OIDC identity |
| **npm** | `NPM_TOKEN` secret (automation token) | Sigstore provenance (`--provenance`) |

Both are least-privilege: the PyPI job holds only `id-token: write`, the npm job
`id-token: write` + `contents: read`. A `verify` job re-runs the full test
matrix and asserts the pushed tag matches the declared version **before** either
publish job runs — publishing is irreversible, so a mistagged or red build fails
closed.

## One-time setup

### PyPI (Trusted Publishing — no token)

1. Log in to <https://pypi.org>. If the project name is unclaimed, use a
   **pending publisher** so the very first release can create it:
   *Account → Publishing → Add a pending publisher.*
2. Fill in:
   - **PyPI Project Name:** `named-subagents`
   - **Owner:** `Bobby-cell-commits`
   - **Repository name:** `named-subagents`
   - **Workflow name:** `release.yml`
   - **Environment name:** *(leave blank — the workflow does not use a GitHub
     environment; see "Optional hardening" below to add one)*
3. Save. Nothing else is stored on the repo side — the OIDC exchange happens at
   publish time.

### npm (token + provenance)

1. On <https://www.npmjs.com>, create a **Granular Access Token** (or classic
   *Automation* token) scoped to publish `named-subagents`.
2. Add it to the repo: *Settings → Secrets and variables → Actions → New
   repository secret*, name **`NPM_TOKEN`**.
3. `package.json`'s `repository` field already matches the GitHub repo
   (case-sensitive) — required for provenance to be accepted.

> **Token-free upgrade (optional):** npm now supports OIDC **trusted
> publishing** like PyPI. Once configured on npmjs.com for this
> package+workflow, you can drop the `NPM_TOKEN` secret and the
> `NODE_AUTH_TOKEN` env line; provenance is then generated automatically. The
> workflow keeps the token path because it is the documented, works-on-first-run
> default and needs no prior published version.

## Cutting a release

1. **Bump the version in all four source-of-truth files** (kept in lockstep;
   `doctor` and the `verify` job both enforce they agree):
   - `pyproject.toml` → `version = "X.Y.Z"`
   - `named_subagents/__init__.py` → `__version__ = "X.Y.Z"`
   - `js/package.json` → `"version": "X.Y.Z"`
   - `js/named_subagents.mjs` → `export const VERSION = "X.Y.Z"`
2. **Add a `## [X.Y.Z] — YYYY-MM-DD` section to `CHANGELOG.md`.** The
   `github-release` job publishes this section verbatim as the release notes.
3. Verify locally:
   ```bash
   python test_named_subagents.py && node js/test_named_subagents.mjs
   bash scripts/parity_check.sh
   pip install -e . && named-subagents doctor    # doctor cross-checks the 4 versions
   ```
4. Commit, tag, push:
   ```bash
   git commit -am "release: vX.Y.Z"
   git tag vX.Y.Z
   git push origin master --tags
   ```
5. Watch **Actions → Release**. Order: `verify` → (`pypi`, `npm` in parallel) →
   `github-release`.

## Verifying provenance after publish

```bash
npm audit signatures                       # verifies the Sigstore attestation
# or inspect on the web: https://www.npmjs.com/package/named-subagents  (Provenance panel)
```

## Optional hardening

- **GitHub environment gate:** add `environment: release` to the `pypi` (and
  `npm`) jobs and create a `release` environment (Settings → Environments) with
  required reviewers. Then set the PyPI trusted publisher's *Environment name*
  to `release` so a token is only mintable from that gated environment. Omitted
  by default to keep first-run setup to a single form.
- **Tag protection:** protect `v*` tags so only maintainers can trigger a
  publish.
