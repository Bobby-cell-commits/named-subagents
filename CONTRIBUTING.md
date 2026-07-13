# Contributing

Thanks for your interest! This is a deliberately small, zero-dependency library.
The bar for adding a dependency (either port) is effectively "no".

## Dev setup

None. Clone and run:

```bash
python3 tests/test_named_subagents.py   # Python suite (stdlib only, no pytest)
node js/test_named_subagents.mjs        # JS mirror suite (Node ≥ 16)
scripts/parity_check.sh                 # cross-language parity (needs both runtimes)
python3 -m named_subagents.cli doctor   # self-checks
```

## The parity discipline (load-bearing)

Python (`named_subagents/`) and JS (`js/`) are **twin ports of one design**:
same registry, same md5-seeded ordering, same ledger JSON shape, same preamble
text — byte-identical outputs for identical inputs.

1. **Every behavioral change lands in BOTH ports + tests, in the same PR.**
   A PR that changes allocation/ledger/preamble behavior in one port only will
   not be merged.
2. **The registry is edited in exactly one place:** `named_subagents/registry.json`
   (the canonical copy, shipped inside the Python package). `js/registry.json`
   is generated at npm publish time by `prepack` and is gitignored — never
   commit or hand-edit it.
3. **New names** must be globally unique across all categories and pass the
   sanitization pattern (`Registry.validate()` will tell you). Please keep
   pools culturally diverse — that is both policy and pool-size pragmatism.
4. **Ledger schema changes** must be backward-compatible (old files load with
   defaults) and forward-compatible (`update()` must preserve keys it doesn't
   know). Add a round-trip test in both suites.
5. **Determinism is a feature.** No `random`, no `Math.random`, no time-based
   inputs in allocation paths. If output can differ between two runs with the
   same inputs, it's a bug.

## Release process

1. Bump the version in all three places: `named_subagents/__init__.py`
   (`__version__`), `pyproject.toml`, `js/package.json` — `doctor` verifies the
   triple matches.
2. Update `CHANGELOG.md`.
3. Both test suites + parity green, `doctor` green.
4. Tag `vX.Y.Z`. Publishing: `npm publish` from `js/` (its `prepack` copies the
   canonical registry in), `python -m build` at the root for PyPI.
