# Roadmap

Candidate improvements for a future release, grouped by leverage. Nothing here
is committed work — it's a backlog to pull from. Each item notes whether it's
**grounded** (a real, verified gap) or **speculative** (optimizes for a case we
haven't confirmed occurs — validate the premise before building it).

## Context

v0.2 shipped every originally-deferred feature (see `CHANGELOG.md`). The honest
next constraint isn't features — it's **reach**: the package earns its keep only
once it's installable and someone sees named agents in their runner. So adoption
artifacts come before feature depth.

## Tier 1 — Highest leverage

1. **Adoption artifacts** *(grounded)* — a short asciicast/GIF of named parallel
   agents, and publish to npm + PyPI (both names are free). The demo is the most
   convincing thing the project can ship; everything else assumes an audience.
2. **Release automation with provenance** *(grounded, on-brand)* — publish-on-tag
   GitHub Action: `npm publish --provenance` + PyPI Trusted Publishing (OIDC, no
   stored tokens). Supply-chain attestation fits a security-forward tool.
3. **Opt-out of cwd config auto-load** *(grounded, on-brand)* — a project-local
   `./.named-subagents.json` is the one untrusted-input surface. Add
   `NAMED_SUBAGENTS_NO_CWD_CONFIG` / `--no-cwd-config`, and consider making
   cwd-config opt-in by default. Lets a careful user eliminate the residual
   documented in `SECURITY.md`.
4. **Type-surface verification** *(grounded)* — the hand-written `.d.ts` is
   unchecked against the `.mjs` (drift risk); add `@ts-check`/JSDoc or a tsc test
   that exercises the typed surface. Ship a `py.typed` marker so the Python hints
   reach downstream type-checkers.

## Tier 2 — Real depth

5. **Hook-based auto-namer** *(high ceiling, feasibility UNVERIFIED — validate
   first)* — the gap between "a CLI you call" and "infrastructure you install
   once" is whether nicknames appear automatically on every fan-out. If the
   runner exposes a dispatch hook that can relabel a spawned agent, an
   install-once auto-namer is the killer integration. Confirm the harness
   actually supports mutating dispatch labels **before** building the machinery.
6. **Robust attribution** *(grounded)* — the persona preamble only *asks* an
   agent to self-tag `[Nickname]`; nothing verifies it. (a) Document loudly that
   the display label is deterministic — the nickname is in the dispatch metadata
   regardless of agent compliance, so attribution never depended on it. (b) Add
   an `attribute(nickname, report)` helper that verifies/repairs the prefix for
   the text-parsing path.
7. **Ledger concurrency + sessions** *(grounded)* — opt-in `flock` (stdlib) for
   genuine multi-process fan-out (closes the documented single-writer race for
   those who need it), and a `with ledger.session():` context manager that
   auto-releases short-lived names on exit (that recycle path is manual today).
8. **Measure resolution quality** *(grounded)* — category resolution is a keyword
   heuristic with unmeasured accuracy. Add a small labeled task→category set + a
   reported accuracy number, and `resolve --explain` to show which keywords fired.
9. **Static-analysis + coverage in CI** *(grounded)* — add a linter (ruff / a JS
   linter), a type-checker (mypy/pyright), and coverage reporting alongside the
   existing suites.

## Tier 3 — Nice-to-have / polish

10. **DX polish** — an `init` command to scaffold a config, shell completion, a
    human-readable `assign` table output.
11. **Ecosystem proof** — worked, *tested* integration examples with
    orchestrators (claude-swarm / metaswarm / a runner Workflow). The adapters
    exist but are unproven end-to-end; a test that the emitted snippet parses
    would back the composability claim.
12. **Project salt / seed** *(SPECULATIVE — premise unconfirmed)* — a per-project
    seed so different projects don't all start with the same first name. No
    evidence cross-project name-sameness bothers anyone; do **not** build until
    the case actually appears.

## Suggested order

Tier 1 in sequence (demo → publish-with-provenance → cwd-config opt-out → type
verification) is the shortest path from finished code to a trusted, installable,
adopted package. Then validate the hook-auto-namer premise (#5) before investing
in it — highest ceiling, least certain.
