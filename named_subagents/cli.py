#!/usr/bin/env python3
"""named-subagents CLI — allocate themed, non-repeating subagent nicknames.

Examples
--------
  python -m named_subagents.cli categories
  python -m named_subagents.cli resolve --role Explore
  python -m named_subagents.cli resolve --task "audit auth for injection vulnerabilities"
  python -m named_subagents.cli allocate --category reflect --count 3
  python -m named_subagents.cli assign --role Explore --task "map the router" --count 4 --ledger .ledger.json
  python -m named_subagents.cli assign --task "audit auth" --format workflow --pin security=Argus
  python -m named_subagents.cli release --category explore --name Magellan --ledger .ledger.json
  python -m named_subagents.cli stats --ledger .ledger.json
  python -m named_subagents.cli doctor --ledger .ledger.json --json
  python -m named_subagents.cli bio Magellan
"""

from __future__ import annotations

import argparse
import contextlib
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time

import named_subagents as ns
from named_subagents import (
    Ledger,
    LEDGER_VERSION,
    PoolExhaustedError,
    Registry,
    __version__,
    allocate,
    installed_agent_names,
    ledger_record_issue,
    ledger_stats,
    load_with_config,
    persona_preamble,
    plan_fanout,
    resolve_category,
    resolve_for_hook,
    to_labels,
    to_swarm,
    to_table,
    to_workflow,
    _strip_gen,
    _valid_name,
)

_PKG_DIR = os.path.dirname(os.path.abspath(ns.__file__ or "."))
_REPO_ROOT = os.path.dirname(_PKG_DIR)


def _cwd_override(args):
    """--no-cwd-config (False, wins) / --cwd-config (True) -> allow_cwd, else None."""
    if getattr(args, "no_cwd_config", False):
        return False
    if getattr(args, "cwd_config", False):
        return True
    return None


def _reg_cfg(args):
    """(Registry, config) honoring --registry, --config, and the cwd-config
    opt-in flags (--cwd-config / --no-cwd-config; cwd config is off by default)."""
    return load_with_config(
        getattr(args, "registry", None),
        getattr(args, "config", None),
        allow_cwd=_cwd_override(args),
    )


def _ledger(args):
    return Ledger(args.ledger) if getattr(args, "ledger", None) else Ledger(None)


def _pins(args, cfg):
    """Config pins merged under repeatable --pin cat=Name flags (flags win)."""
    pins = dict(cfg.get("pins") or {})
    for item in getattr(args, "pin", None) or []:
        if "=" not in item:
            raise SystemExit(f"--pin expects CATEGORY=Name, got {item!r}")
        cat, name = item.split("=", 1)
        pins[cat.strip()] = name.strip()
    return pins


def cmd_categories(args):
    reg, _ = _reg_cfg(args)
    print(f"{reg.total_names()} names across {len(reg.categories)} categories:\n")
    for c in reg.categories:
        spec = reg.categories[c]
        print(f"  {reg.emoji(c):<2} {c:<12} {len(reg.names(c)):>3}  {reg.theme(c)}")
        print(f"      {spec.get('blurb','')}")


def cmd_resolve(args):
    reg, _ = _reg_cfg(args)
    cat = resolve_category(reg, role=args.role, task=args.task, category=args.category)
    out = {"category": cat, "theme": reg.theme(cat), "emoji": reg.emoji(cat)}
    if getattr(args, "explain", False):
        role, task = args.role, args.task
        if args.category and args.category in reg.categories:
            reason = "category"
        elif role and reg.by_subagent_type(role):
            reason = "role"
        elif task and reg.by_keyword(task):
            reason = "keyword"
        else:
            reason = "default"
        out["explain"] = {
            "reason": reason,
            "role": role,
            "role_match": reg.by_subagent_type(role) if role else None,
            "keyword_matches": reg.keyword_matches(task) if task else {},
            "keyword_scores": reg.keyword_scores(task) if task else {},
        }
    print(json.dumps(out, ensure_ascii=False))


def cmd_allocate(args):
    reg, cfg = _reg_cfg(args)
    cat = resolve_category(reg, role=args.role, task=args.task, category=args.category)
    avoid = installed_agent_names() if args.avoid_installed else None
    names = allocate(cat, args.count, reg, ledger=_ledger(args),
                     pins=_pins(args, cfg), avoid=avoid)
    if args.json:
        print(json.dumps({"category": cat, "nicknames": names}, ensure_ascii=False))
    else:
        for n in names:
            print(n)


def cmd_assign(args):
    reg, cfg = _reg_cfg(args)
    tasks = args.task if isinstance(args.task, list) else [args.task]
    if args.count and args.count > len(tasks):
        # replicate the single task N times (N parallel workers on the same job)
        tasks = tasks * args.count if len(tasks) == 1 else tasks
    plan = plan_fanout(tasks, reg, ledger=_ledger(args), role=args.role,
                       category=args.category, subagent_type=args.subagent_type,
                       pins=_pins(args, cfg), avoid_installed=args.avoid_installed,
                       with_bio=args.bio_in_prompt)
    if args.format == "labels":
        print(json.dumps(to_labels(plan), ensure_ascii=False, indent=2))
    elif args.format == "workflow":
        print(to_workflow(plan))
    elif args.format == "swarm":
        print(to_swarm(plan))
    elif args.format == "table":
        print(to_table(plan))
    else:  # agent (default) — full Assignment JSON
        print(json.dumps([dict(a._asdict()) for a in plan], ensure_ascii=False, indent=2))


def _require_name_in_pool(args):
    """CLI guard: the ledger verbs are permissive at the library level, but a
    typo'd --name that isn't in the category's registry pool is almost always a
    mistake. Reject it here (exit 1) with a clear message. Honors --registry /
    --config so custom-added names are recognized."""
    reg, _ = _reg_cfg(args)
    if args.category not in reg.categories:
        print("error: unknown category %r" % args.category, file=sys.stderr)
        return False
    if _strip_gen(args.name) not in reg.categories[args.category].get("names", []):
        print("error: name %r is not in the %r pool" % (args.name, args.category),
              file=sys.stderr)
        return False
    return True


def cmd_release(args):
    if not _require_name_in_pool(args):
        return 1
    led = Ledger(args.ledger)
    ok = led.release(args.category, args.name)
    print(json.dumps({"released": ok, "category": args.category, "name": args.name}))
    return 0


def cmd_retire(args):
    if not _require_name_in_pool(args):
        return 1
    led = Ledger(args.ledger)
    ok = led.retire(args.category, args.name)
    print(json.dumps({"retired": ok, "category": args.category, "name": args.name}))
    return 0


def cmd_unretire(args):
    if not _require_name_in_pool(args):
        return 1
    led = Ledger(args.ledger)
    ok = led.unretire(args.category, args.name)
    print(json.dumps({"unretired": ok, "category": args.category, "name": args.name}))
    return 0


def cmd_stats(args):
    reg, _ = _reg_cfg(args)
    stats = ledger_stats(reg, Ledger(args.ledger))
    if args.json:
        print(json.dumps(stats, ensure_ascii=False, indent=2))
        return
    hdr = f"{'category':<14}{'pool':>6}{'used':>6}{'%used':>7}{'gen':>5}{'retired':>9}{'lifetime':>10}{'remaining':>11}"
    print(hdr)
    print("-" * len(hdr))
    for cat, row in stats["categories"].items():
        flag = " (unknown)" if row.get("unknown") else ""
        print(f"{cat:<14}{row['pool']:>6}{row['used']:>6}{row['pct_used']:>7}"
              f"{row['generation']:>5}{row['retired']:>9}{row['total_allocated']:>10}"
              f"{row['remaining']:>11}{flag}")
    t = stats["totals"]
    print("-" * len(hdr))
    print(f"{'TOTAL':<14}{t['pool']:>6}{t['used']:>6}{t['pct_used']:>7}{'':>5}"
          f"{t['retired']:>9}{t['total_allocated']:>10}{t['remaining']:>11}")


def cmd_bio(args):
    reg, _ = _reg_cfg(args)
    base = _strip_gen(args.name)
    for cat in reg.categories:
        if base in reg.categories[cat].get("names", []):
            print(reg.bio(cat, base))
            return 0
    print(f"name {args.name!r} not found in any category", file=sys.stderr)
    return 1


# --------------------------------------------------------------------------- #
# doctor (D12)
# --------------------------------------------------------------------------- #
def _doctor_checks(args):
    checks = []

    def add(status, name, detail=""):
        checks.append({"status": status, "check": name, "detail": detail})

    # 1. registry loads + valid (uniqueness, sanitization, bios ⊆ names)
    reg, cfg = None, {}
    try:
        reg, cfg = _reg_cfg(args)
        add("PASS", "registry",
            f"{reg.total_names()} names / {len(reg.categories)} categories, all valid")
    except Exception as e:  # noqa: BLE001 — doctor reports, never crashes
        add("FAIL", "registry", f"{type(e).__name__}: {e}")

    # 2. bios ⊆ names (validate() enforces it; recompute so the line is explicit)
    if reg is None:
        add("SKIP", "bios", "registry failed to load")
    else:
        strays = [f"{c}:{b}" for c in reg.categories
                  for b in (reg.categories[c].get("bios") or {})
                  if b not in set(reg.categories[c].get("names", []))]
        if strays:
            add("FAIL", "bios", "bios for unknown names: " + ", ".join(strays))
        else:
            n_bios = sum(len(reg.categories[c].get("bios") or {}) for c in reg.categories)
            add("PASS", "bios", f"{n_bios} bios, all keys ⊆ names")

    # 3. js/registry.json byte-equal to the canonical copy (repo layout only)
    js_reg = os.path.join(_REPO_ROOT, "js", "registry.json")
    canonical = os.path.join(_PKG_DIR, "registry.json")
    if not os.path.isdir(os.path.join(_REPO_ROOT, "js")):
        add("SKIP", "js-registry-sync", "no js/ sibling (installed layout)")
    elif not os.path.isfile(js_reg):
        add("SKIP", "js-registry-sync", "js/registry.json absent (placed by npm prepack)")
    else:
        with open(js_reg, "rb") as a, open(canonical, "rb") as b:
            same = a.read() == b.read()
        if same:
            add("PASS", "js-registry-sync", "byte-equal to named_subagents/registry.json")
        else:
            add("FAIL", "js-registry-sync",
                "js/registry.json differs from canonical (stale prepack artifact)")

    # 4. ledger
    if not getattr(args, "ledger", None):
        add("SKIP", "ledger", "no --ledger given")
    else:
        lp = args.ledger
        try:
            if os.path.exists(lp):
                with open(lp, "r", encoding="utf-8") as fh:
                    raw = fh.read()
                try:
                    # reject NaN/Infinity so this matches the reader + JS port
                    loaded = json.loads(raw, parse_constant=ns._reject_constant)
                except ValueError:
                    loaded = None
                if not isinstance(loaded, dict):
                    add("INFO", "ledger-readable",
                        "file exists but is corrupt — will be reset to fresh on next write")
                    loaded = {}
                else:
                    add("PASS", "ledger-readable", f"{len(raw)} bytes")
                v = loaded.get("_v")
                if v is None:
                    add("PASS", "ledger-version", "v1 (no _v marker; upgraded on first write)")
                elif v == LEDGER_VERSION:
                    add("PASS", "ledger-version", f"_v={v}")
                else:
                    add("FAIL", "ledger-version", f"unknown ledger version _v={v!r}")
                overlaps = []
                for cat, rec in loaded.items():
                    if cat.startswith("_"):
                        continue
                    # A wrong-typed record must FAIL-report, never crash the doctor.
                    issue = ledger_record_issue(rec)
                    if issue is not None:
                        add("FAIL", "ledger-record-malformed",
                            f"record '{cat}' malformed: {issue}")
                        continue
                    both = set(rec.get("used", [])) & set(rec.get("retired", []))
                    if both:
                        overlaps.append(f"{cat}: {sorted(both)}")
                if overlaps:
                    add("INFO", "ledger-used-retired-overlap",
                        "transient + harmless (never re-drawn; next generation skips): "
                        + "; ".join(overlaps))
            else:
                add("PASS", "ledger-readable", "no file yet (fresh ledger will be created)")
            # writable probe: save to a temp sibling, then remove it
            probe = lp + ".doctor-probe.tmp"
            try:
                probe_led = Ledger(None)
                probe_led.path = probe
                probe_led.save()
                os.remove(probe)
                add("PASS", "ledger-writable", "temp-save probe succeeded")
            except OSError as e:
                add("FAIL", "ledger-writable", f"{type(e).__name__}: {e}")
        except OSError as e:
            add("FAIL", "ledger-readable", f"{type(e).__name__}: {e}")

    # 5. pins (from config)
    pins = dict(cfg.get("pins") or {})
    if not pins:
        add("SKIP", "pins", "no pins in config")
    else:
        bad = {c: n for c, n in pins.items() if not _valid_name(n)}
        if bad:
            add("FAIL", "pins", f"pins failing name sanitization: {bad}")
        else:
            add("PASS", "pins", f"{len(pins)} pin(s), all sanitization-valid")

    # 6. pool ∩ installed-agents overlap
    installed = installed_agent_names()
    add("INFO", "installed-agents",
        f"{len(installed)} installed agent name(s): {sorted(installed)}" if installed
        else "no installed agent definitions found")
    if reg is not None:
        # Our own roster callsign files are pool names by construction, not collisions.
        own = {n.lower() for n in ((_load_roster() or {}).get("files") or {})}
        installed_l = {n.lower() for n in installed} - own
        clash = sorted(n for c in reg.categories for n in reg.names(c)
                       if n.lower() in installed_l)
        if clash:
            add("FAIL", "pool-agent-collision",
                "pool names case-fold-equal to installed agents: " + ", ".join(clash))
        else:
            add("PASS", "pool-agent-collision", "no pool name collides with an installed agent")

    # 7. version triple-check (repo layout only)
    pyproject = os.path.join(_REPO_ROOT, "pyproject.toml")
    if not os.path.isfile(pyproject):
        add("SKIP", "version", "no pyproject.toml sibling (installed layout)")
    else:
        import re as _re
        with open(pyproject, "r", encoding="utf-8") as fh:
            m = _re.search(r'^version\s*=\s*"([^"]+)"', fh.read(), _re.MULTILINE)
        py_ver = m.group(1) if m else None
        versions = {"__version__": __version__, "pyproject.toml": py_ver}
        pkg_json = os.path.join(_REPO_ROOT, "js", "package.json")
        js_note = ""
        if os.path.isfile(pkg_json):
            try:
                with open(pkg_json, "r", encoding="utf-8") as fh:
                    versions["js/package.json"] = json.load(fh).get("version")
            except (ValueError, OSError):
                versions["js/package.json"] = None
        else:
            js_note = " (js/package.json absent — skipped)"
        if len({v for v in versions.values()}) == 1:
            add("PASS", "version", f"all at {__version__}{js_note}")
        else:
            add("FAIL", "version", f"mismatch: {versions}")

    # 8. Python/JS parity probe
    node = shutil.which("node")
    js_cli = os.path.join(_REPO_ROOT, "js", "cli.mjs")
    js_mod = os.path.join(_REPO_ROOT, "js", "named_subagents.mjs")
    if not (node and os.path.isfile(js_cli) and os.path.isfile(js_mod)):
        add("SKIP", "parity", "node and/or js port not present")
    else:
        try:
            out = subprocess.run(
                [node, js_cli, "allocate", "--category", "default", "--count", "3", "--json"],
                capture_output=True, text=True, timeout=30)
            if out.returncode != 0:
                add("SKIP", "parity",
                    f"js cli exited {out.returncode} (interface mismatch or missing --json)")
            else:
                js_names = json.loads(out.stdout).get("nicknames")
                py_names = allocate("default", 3, Registry.load())  # bundled, no ledger
                if js_names == py_names:
                    add("PASS", "parity", f"both ports allocate {py_names}")
                else:
                    add("FAIL", "parity", f"python={py_names} js={js_names}")
        except Exception as e:  # noqa: BLE001 — only a clean-run mismatch may FAIL
            add("SKIP", "parity", f"probe not comparable ({type(e).__name__}: {e})")

    # 9. auto-namer hook — install status (informational) + a live self-test
    sp = _settings_path(args)
    sdata, _serr = _read_settings(sp)
    _sh = sdata.get("hooks")
    _sh = _sh if isinstance(_sh, dict) else {}
    hooked = next(_iter_our_hooks(_sh.get("SubagentStart") or []), None)
    legacy, capture, retype = False, False, False
    for _m, h in _iter_our_hooks(_sh.get("PreToolUse") or []):
        if _is_capture_hook(h):
            capture = True              # the v0.4.3 task-capture entry, NOT legacy
        elif _is_retype_hook(h):
            retype = True               # the v0.5.0 roster-mode entry, NOT legacy
        else:
            legacy = True
    if retype:
        ros = _load_roster()
        add("INFO", "hook-install",
            f"roster mode (PreToolUse retype) in {sp}"
            + ("" if ros else "  ⚠ no roster manifest — run `named-subagents roster install`")
            + ("  ⚠ auto-namer entries also present — re-run `hook install --roster`"
               if (hooked or capture) else ""))
    elif hooked:
        add("INFO", "hook-install",
            f"registered (SubagentStart{' + task capture' if capture else ''}) in {sp}"
            + ("" if capture else "  ⚠ task capture not registered — re-run `hook install` for task theming")
            + ("  ⚠ legacy PreToolUse entry also present — re-run `hook install` to migrate" if legacy else ""))
    elif legacy:
        add("INFO", "hook-install",
            f"⚠ only a legacy PreToolUse entry in {sp} (clobber-prone) — re-run `hook install` to migrate to SubagentStart")
    else:
        add("INFO", "hook-install",
            "not installed (run `named-subagents hook install` to enable auto-naming)")
    if os.environ.get("NAMED_SUBAGENTS_HOOK_DISABLE"):
        # Kill switch is a documented, legitimate state — don't FAIL (or flip the exit code).
        add("INFO", "hook-selftest", "skipped — disabled via NAMED_SUBAGENTS_HOOK_DISABLE")
    else:
        try:
            # Self-test against a THROWAWAY ledger so doctor never writes real state.
            # This exercises the hook's OUTPUT shape, NOT Claude Code's application of
            # it — end-to-end additionalContext delivery is verified live in the suite.
            with tempfile.TemporaryDirectory() as _hd:
                out = _hook_subagent_start(
                    {"hook_event_name": "SubagentStart", "agent_type": "Explore"},
                    ledger_path=os.path.join(_hd, "led.json"),
                    queue_dir=os.path.join(_hd, "q"))
                # v0.4.3: the capture -> pop -> task-theming chain (a generic role
                # with a security task must theme by TASK, not fall to the role pool)
                _hook_pre_capture(
                    {"hook_event_name": "PreToolUse", "tool_name": "Agent",
                     "session_id": "doctor-selftest",
                     "tool_input": {"description": "security audit",
                                    "prompt": "Audit auth for injection vulnerabilities.",
                                    "subagent_type": "general-purpose"}},
                    queue_dir=os.path.join(_hd, "q"))
                out2 = _hook_subagent_start(
                    {"hook_event_name": "SubagentStart", "session_id": "doctor-selftest",
                     "agent_type": "general-purpose"},
                    ledger_path=os.path.join(_hd, "led.json"),
                    queue_dir=os.path.join(_hd, "q"))
            ac = (out or {}).get("additionalContext", "")
            ok = bool(out) and out.get("hookEventName") == "SubagentStart" and _PERSONA_SIG in ac
            ac2 = (out2 or {}).get("additionalContext", "")
            ok2 = "guardians" in ac2      # task-themed, not the role's programmer pool
            add("PASS" if ok and ok2 else "FAIL", "hook-selftest",
                "`hook run` emits a valid SubagentStart nickname context (incl. task-themed capture)"
                if ok and ok2 else f"unexpected output: {out if not ok else out2}")
        except Exception as e:  # noqa: BLE001 — doctor reports, never crashes
            add("FAIL", "hook-selftest", f"{type(e).__name__}: {e}")

    return checks


def cmd_doctor(args):
    checks = _doctor_checks(args)
    fail_count = sum(1 for c in checks if c["status"] == "FAIL")
    if args.json:
        print(json.dumps({"checks": checks, "fail_count": fail_count,
                          "version": __version__}, ensure_ascii=False, indent=2))
    else:
        for c in checks:
            detail = f"  {c['detail']}" if c["detail"] else ""
            print(f"[{c['status']}] {c['check']}{detail}")
        print(f"\n{len(checks)} checks, {fail_count} failed")
    return 1 if fail_count else 0


# --------------------------------------------------------------------------- #
# init — scaffold a starter config
# --------------------------------------------------------------------------- #
_INIT_TEMPLATE = {
    "pins": {"security": "Argus"},
    "extend": {"explore": {"names": ["Kupe"]}},
    "categories": {
        "starships": {
            "theme": "Star systems",
            "emoji": "🚀",
            "keywords": ["fleet", "deploy", "orchestrate"],
            "names": ["Enterprise", "Rocinante", "Serenity", "Nostromo"],
        }
    },
}


def _init_path(args):
    if getattr(args, "path", None):
        return args.path
    if getattr(args, "cwd", False):
        return os.path.join(os.getcwd(), ".named-subagents.json")
    base = os.environ.get("XDG_CONFIG_HOME") or os.path.join(os.path.expanduser("~"), ".config")
    return os.path.join(base, "named-subagents", "config.json")


def cmd_init(args):
    path = _init_path(args)
    if os.path.exists(path) and not getattr(args, "force", False):
        print(f"error: {path} already exists — pass --force to overwrite.", file=sys.stderr)
        return 1
    # Validate the template loads cleanly before writing it (guards against an edit
    # that trips the config validator — e.g. a name that collides with the bundled
    # registry's global-uniqueness invariant).
    fd, probe = tempfile.mkstemp(suffix=".json")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(_INIT_TEMPLATE, fh)
        load_with_config(None, probe, allow_cwd=False)
    finally:
        try:
            os.unlink(probe)
        except OSError:
            pass
    os.makedirs(os.path.dirname(os.path.abspath(path)) or ".", exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(json.dumps(_INIT_TEMPLATE, ensure_ascii=False, indent=2) + "\n")
    if getattr(args, "path", None):
        hint = f"load it with `--config {path}`."
    elif getattr(args, "cwd", False):
        hint = "enable it per-project with `--cwd-config`."
    else:
        hint = "the home config is picked up automatically."
    print(f"wrote a starter config to {path}\n"
          f"  It pins a security nickname (Argus), extends the explore pool, and adds a\n"
          f"  custom 'starships' category. Edit it to taste — {hint}")
    return 0


# --------------------------------------------------------------------------- #
# Auto-namer hook — install once; nickname every subagent dispatch
# (feasibility validated 2026-07-12: a PreToolUse hook on the `Agent` tool can
#  rewrite the dispatch's `description`/`prompt` via hookSpecificOutput.updatedInput.)
# --------------------------------------------------------------------------- #
_HOOK_MARKER = "named-subagents-autonamer"        # sentinel in the registered command
_PERSONA_SIG = "parallel agents in this run."     # idempotency probe (from persona_preamble)
_DISPATCH_TOOLS = ("Agent", "Task")               # Task -> Agent rename (CC 2.1.63; alias kept)


def _hook_ledger_path() -> str:
    """Where the non-repeat ledger lives. NAMED_SUBAGENTS_LEDGER overrides; default
    is a per-user state file so names never repeat across sessions/projects."""
    env = os.environ.get("NAMED_SUBAGENTS_LEDGER")
    if env:
        return env
    base = os.environ.get("XDG_STATE_HOME") or os.path.join(
        os.path.expanduser("~"), ".local", "state")
    return os.path.join(base, "named-subagents", "hook-ledger.json")


def _hook_registry():
    """Load the registry for the hook. Never auto-loads ./.named-subagents.json:
    the hook runs in arbitrary (possibly cloned/untrusted) project dirs and its
    output lands inside agent prompts, so the one untrusted-input surface stays
    off (allow_cwd=False) regardless of environment."""
    return load_with_config(None, None, allow_cwd=False)


# ---- task hand-off queue (v0.4.3) ------------------------------------------ #
# SubagentStart carries only `agent_type` — no task (and there is NO cross-event
# correlation key; probe 2026-07-13). An output-free PreToolUse hook captures each
# dispatch's task into a per-session FIFO; the SubagentStart hook pops the oldest
# ROLE-MATCHING entry. Returning nothing from the PRE hook keeps it immune to the
# multi-hook updatedInput clobber (claude-code#15897/#39814).
_QUEUE_TTL_SECONDS = 30.0     # entries older than this are orphans (dispatch never started)


def _hook_queue_dir() -> str:
    env = os.environ.get("NAMED_SUBAGENTS_QUEUE_DIR")
    if env:
        return env
    base = os.environ.get("XDG_STATE_HOME") or os.path.join(
        os.path.expanduser("~"), ".local", "state")
    return os.path.join(base, "named-subagents", "queue")


def _queue_path(session_id, queue_dir=None) -> str:
    sid = session_id if isinstance(session_id, str) else ""
    sid = re.sub(r"[^A-Za-z0-9_.-]", "_", sid)[:80] or "nosession"
    return os.path.join(queue_dir or _hook_queue_dir(), f"q-{sid}.jsonl")


class _queue_lock:
    """Bounded cross-process exclusion for queue read-modify-write, via flock on a
    `<queue>.lock` sidecar (same idiom as Ledger.lock). Platforms without fcntl
    degrade to lockless (matches the JS port's documented behavior)."""

    def __init__(self, qpath: str):
        self._lock_path = qpath + ".lock"
        self._fd = None

    def __enter__(self):
        try:
            import fcntl
        except ImportError:
            return self
        deadline = time.monotonic() + 5.0
        self._fd = os.open(self._lock_path, os.O_CREAT | os.O_RDWR, 0o600)
        while True:
            try:
                fcntl.flock(self._fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                return self
            except OSError:
                if time.monotonic() > deadline:
                    raise TimeoutError("queue lock timeout")
                time.sleep(0.005)

    def __exit__(self, *exc):
        if self._fd is not None:
            os.close(self._fd)
            self._fd = None
        return False


def _hook_pre_capture(event, queue_dir=None):
    """Push {role, task, skip, ts} for an Agent/Task dispatch onto the per-session
    FIFO. ALWAYS returns None — this hook must stay output-free. A dispatch that is
    already named (CLI `assign`, or a re-fire) pushes a TOMBSTONE (skip=true), never
    nothing: SubagentStart fires unconditionally per dispatch, so a push-skip would
    desync every sibling after it by one."""
    if os.environ.get("NAMED_SUBAGENTS_HOOK_DISABLE"):
        return None
    if not isinstance(event, dict) or event.get("tool_name") not in _DISPATCH_TOOLS:
        return None
    ti = event.get("tool_input")
    if not isinstance(ti, dict):
        return None

    def _str(v) -> str:
        return v if isinstance(v, str) else ""

    prompt = _str(ti.get("prompt"))
    description = _str(ti.get("description"))
    skip = _PERSONA_SIG in prompt
    if not skip and not prompt and description:
        reg, _cfg = _hook_registry()
        skip = any(description.startswith(reg.emoji(c)) for c in reg.categories)
    entry = {
        "role": _str(ti.get("subagent_type")),
        "task": (description + "\n" + prompt).strip(),
        "skip": skip,
        "ts": time.time(),
    }
    qpath = _queue_path(event.get("session_id"), queue_dir)
    os.makedirs(os.path.dirname(qpath) or ".", exist_ok=True)
    with _queue_lock(qpath):
        with open(qpath, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(entry, ensure_ascii=False) + "\n")
    return None


def _queue_pop(session_id, agent_type, queue_dir=None):
    """Pop the oldest entry whose role matches `agent_type`, pruning stale orphans
    in passing. A mismatched entry is NEVER stolen (it belongs to a sibling with a
    different role); no match -> None (caller falls back to role theming). The file
    is removed once drained so the state dir doesn't accumulate per-session files."""
    qpath = _queue_path(session_id, queue_dir)
    if not os.path.exists(qpath):
        return None
    popped = None
    with _queue_lock(qpath):
        try:
            with open(qpath, "r", encoding="utf-8") as fh:
                lines = fh.read().splitlines()
        except OSError:
            return None
        now = time.time()
        entries = []
        for line in lines:
            try:
                e = json.loads(line)
            except ValueError:
                continue
            if isinstance(e, dict) and now - float(e.get("ts") or 0) <= _QUEUE_TTL_SECONDS:
                entries.append(e)
        keep = []
        for e in entries:
            if popped is None and e.get("role") == agent_type:
                popped = e
            else:
                keep.append(e)
        if keep:
            fd, tmp = tempfile.mkstemp(dir=os.path.dirname(qpath) or ".",
                                       prefix=os.path.basename(qpath) + ".", suffix=".tmp")
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                for e in keep:
                    fh.write(json.dumps(e, ensure_ascii=False) + "\n")
            os.replace(tmp, qpath)
        else:
            try:
                os.unlink(qpath)
            except OSError:
                pass
    return popped


def _hook_mutate(event, ledger_path=None, avoid=None):
    """Map a PreToolUse event dict -> the hookSpecificOutput dict to emit, or None
    to pass the dispatch through unchanged. `ledger_path` overrides the default ledger
    (the doctor self-test passes a temp path so it never touches real state). `avoid`
    excludes base names from the draw (the roster fallback passes its callsigns so the
    two naming mechanisms can never surface the same name side by side). May raise
    on internal error; the caller (cmd_hook_run) fails open so a raise never breaks a
    dispatch."""
    if os.environ.get("NAMED_SUBAGENTS_HOOK_DISABLE"):
        return None
    if not isinstance(event, dict) or event.get("tool_name") not in _DISPATCH_TOOLS:
        return None
    ti = event.get("tool_input")
    if not isinstance(ti, dict):
        return None

    def _str(v) -> str:
        return v if isinstance(v, str) else ""

    prompt = _str(ti.get("prompt"))
    description = _str(ti.get("description"))
    subagent_type = _str(ti.get("subagent_type"))

    reg, _cfg = _hook_registry()
    # Idempotency: skip an already-named dispatch (a re-fire, or a caller that ran
    # `assign` first). Two signals so an empty-prompt dispatch can't double-prefix:
    # the persona preamble in the prompt, OR a description already led by one of our
    # category emojis.
    if _PERSONA_SIG in prompt:
        return None
    # Fall back to a description-emoji probe ONLY when there's no prompt (a rare
    # empty-prompt re-fire). A prompted dispatch is governed by the SIG above, so a
    # legit description like "📊 Q3 chart" isn't wrongly treated as already-named.
    if not prompt and description and any(
            description.startswith(reg.emoji(c)) for c in reg.categories):
        return None

    cat = resolve_category(reg, role=subagent_type or None, task=description or None)

    led = Ledger(ledger_path if ledger_path is not None else _hook_ledger_path())
    if led.path:
        os.makedirs(os.path.dirname(os.path.abspath(led.path)) or ".", exist_ok=True)
    with led.lock(timeout=10):             # flock (bounded): concurrent fan-out can't
        nickname = allocate(cat, 1, reg, ledger=led,      # collide; a wedged peer
                            avoid=avoid)[0]               # degrades to fail-open, not a hang
        led.save()

    emoji, theme = reg.emoji(cat), reg.theme(cat)
    bio = reg.bio(cat, _strip_gen(nickname)) if os.environ.get("NAMED_SUBAGENTS_HOOK_BIO") else None
    updated = dict(ti)
    updated["description"] = (f"{emoji} {nickname} · {description}".strip()
                              if description else f"{emoji} {nickname}")
    if prompt:
        updated["prompt"] = persona_preamble(nickname, theme, bio=bio) + prompt
    return {"hookEventName": "PreToolUse", "updatedInput": updated}


def _hook_subagent_start(event, ledger_path=None, queue_dir=None):
    """Map a SubagentStart event -> the hookSpecificOutput dict to emit, or None to
    pass through. This is the PRIMARY auto-namer path (v0.4.2): it delivers the
    nickname via `additionalContext`, which is ADDITIVE and reaches the subagent's
    own context — so it is immune to the multi-hook `updatedInput` clobber that
    silently drops the Agent-tool PreToolUse path (claude-code#15897 / #39814).

    v0.4.3: theming is TASK-first when the PreToolUse capture hook queued this
    dispatch's task (see _hook_pre_capture); a tombstone (CLI-named dispatch) emits
    nothing; queue empty / role mismatch / stale falls back to the v0.4.2 ROLE
    theming. `ledger_path`/`queue_dir` override defaults (doctor passes temps)."""
    if os.environ.get("NAMED_SUBAGENTS_HOOK_DISABLE"):
        return None
    if not isinstance(event, dict):
        return None
    agent_type = event.get("agent_type")
    agent_type = agent_type if isinstance(agent_type, str) else ""

    entry = _queue_pop(event.get("session_id"), agent_type, queue_dir)
    if entry and entry.get("skip"):
        return None                       # CLI already named this dispatch

    reg, _cfg = _hook_registry()
    task = entry.get("task") if entry else None
    if isinstance(task, str) and task:
        cat = resolve_for_hook(reg, role=agent_type or None, task=task)
    else:
        cat = resolve_category(reg, role=agent_type or None)

    led = Ledger(ledger_path if ledger_path is not None else _hook_ledger_path())
    if led.path:
        os.makedirs(os.path.dirname(os.path.abspath(led.path)) or ".", exist_ok=True)
    with led.lock(timeout=10):
        nickname = allocate(cat, 1, reg, ledger=led)[0]
        led.save()

    theme = reg.theme(cat)
    bio = reg.bio(cat, _strip_gen(nickname)) if os.environ.get("NAMED_SUBAGENTS_HOOK_BIO") else None
    context = persona_preamble(nickname, theme, bio=bio, task_follows=False)
    return {"hookEventName": "SubagentStart", "additionalContext": context}


# ---- roster mode (v0.5.0): visible names in the live task tree ------------- #
# Claude Code's task-tree label is the agent-definition NAME (hardcoded — no
# per-instance field exists; claude-code#9206 closed unplanned). Roster mode makes
# the name the definition: `roster install` generates persona agent files (clones
# of a base agent + persona preamble), and a PreToolUse hook rewrites
# `subagent_type` -> a free roster callsign via `updatedInput`, so the tree shows
# "Durga" where it showed "general-purpose". Viable since the Agent-tool
# updatedInput multi-hook clobber (claude-code#15897/#39814) was fixed upstream
# (verified live on CC 2.1.245, 2026-08-26 probe).
_ROSTER_MARKER = "named-subagents-roster v1"       # sentinel inside generated files
_ROSTER_USED_TTL = 48 * 3600.0                     # per-session used-files GC horizon
_ROSTER_GENERIC_BODY = (
    "You are a capable general agent. Complete the dispatched task thoroughly "
    "and return a clear, complete report of what you did and found.\n")


def _roster_state_path() -> str:
    """Where the roster manifest lives. NAMED_SUBAGENTS_ROSTER overrides; default
    is per-user state (user-written only — the hook never reads project-local
    roster state, same trust posture as _hook_registry)."""
    env = os.environ.get("NAMED_SUBAGENTS_ROSTER")
    if env:
        return env
    base = os.environ.get("XDG_STATE_HOME") or os.path.join(
        os.path.expanduser("~"), ".local", "state")
    return os.path.join(base, "named-subagents", "roster.json")


def _load_roster(path=None):
    """Manifest dict or None. Defensive: malformed/missing -> None (hook falls
    back to the mutate path), never a crash."""
    p = path or _roster_state_path()
    if not os.path.exists(p):
        return None
    try:
        with open(p, "r", encoding="utf-8") as fh:
            data = json.load(fh)
    except (ValueError, OSError):
        return None
    if not isinstance(data, dict) or not isinstance(data.get("agents"), dict):
        return None
    if not isinstance(data.get("files"), dict):
        data["files"] = {}
    return data


def _save_roster(data, path=None):
    p = path or _roster_state_path()
    d = os.path.dirname(os.path.abspath(p)) or "."
    os.makedirs(d, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=d, prefix=os.path.basename(p) + ".", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(json.dumps(data, ensure_ascii=False, indent=2) + "\n")
        os.replace(tmp, p)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _roster_used_path(session_id, queue_dir=None) -> str:
    sid = session_id if isinstance(session_id, str) else ""
    sid = re.sub(r"[^A-Za-z0-9_.-]", "_", sid)[:80] or "nosession"
    return os.path.join(queue_dir or _hook_queue_dir(), f"u-{sid}.json")


def _roster_unloaded_path(session_id, queue_dir=None) -> str:
    sid = re.sub(r"[^A-Za-z0-9_.-]", "_", session_id if isinstance(session_id, str) else "")[:80]
    return os.path.join(queue_dir or _hook_queue_dir(), f"n-{sid or 'nosession'}.json")


def _roster_mark_unloaded(session_id, queue_dir=None) -> None:
    """Record that this session started before its roster files existed."""
    p = _roster_unloaded_path(session_id, queue_dir)
    os.makedirs(os.path.dirname(p) or ".", exist_ok=True)
    with open(p, "w", encoding="utf-8") as fh:
        json.dump({"ts": time.time()}, fh)


def _roster_prune_used(queue_dir=None) -> None:
    """Best-effort GC of stale per-session used-files (sessions end silently), plus
    their `.lock` sidecars and any other stale queue lock — nothing else deletes
    those, so without this they accumulate one per session forever."""
    qd = queue_dir or _hook_queue_dir()
    try:
        now = time.time()
        for fn in os.listdir(qd):
            if (fn.startswith(("u-", "n-")) and fn.endswith(".json")) or fn.endswith(".lock"):
                p = os.path.join(qd, fn)
                try:
                    if now - os.path.getmtime(p) > _ROSTER_USED_TTL:
                        os.unlink(p)
                except OSError:
                    pass
    except OSError:
        pass


def _roster_pick(roster, base_type, category, session_id, queue_dir=None):
    """Pick a free roster callsign for `base_type`, preferring `category`, and
    record it in the per-session used-file so concurrent siblings never share a
    name. Names deliberately RECYCLE across sessions (a stable crew, not a
    one-shot pool — unlike the global hook ledger). Returns (name, category) or
    (None, None) when every roster name for this base is already live."""
    per_base = (roster.get("agents") or {}).get(base_type)
    if not isinstance(per_base, dict):
        return None, None
    cats = ([category] if category in per_base else []) + sorted(
        c for c in per_base if c != category)
    _roster_prune_used(queue_dir)
    upath = _roster_used_path(session_id, queue_dir)
    os.makedirs(os.path.dirname(upath) or ".", exist_ok=True)
    with _queue_lock(upath):
        used = set()
        try:
            with open(upath, "r", encoding="utf-8") as fh:
                data = json.load(fh)
            if isinstance(data, dict):
                used = {n for n in data.get("used") or [] if isinstance(n, str)}
        except (ValueError, OSError):
            pass
        for c in cats:
            names = per_base.get(c)
            for n in names if isinstance(names, list) else []:
                if isinstance(n, str) and n and n not in used:
                    used.add(n)
                    fd, tmp = tempfile.mkstemp(
                        dir=os.path.dirname(upath) or ".",
                        prefix=os.path.basename(upath) + ".", suffix=".tmp")
                    with os.fdopen(fd, "w", encoding="utf-8") as fh:
                        json.dump({"used": sorted(used), "ts": time.time()}, fh)
                    os.replace(tmp, upath)
                    return n, c
    return None, None


def _roster_release(roster, agent_type, session_id, queue_dir=None):
    """Return a finished callsign to this session's free pool. Without it a
    session could name only one crew's worth of dispatches per base — every later
    dispatch fell back to the description-prefix namer even with the whole crew
    idle. Returns the released name, or None when `agent_type` is not one of our
    callsigns or was not held."""
    if not isinstance(roster, dict) or not isinstance(agent_type, str):
        return None
    if agent_type not in (roster.get("files") or {}):
        return None
    upath = _roster_used_path(session_id, queue_dir)
    if not os.path.exists(upath):
        return None
    with _queue_lock(upath):
        try:
            with open(upath, "r", encoding="utf-8") as fh:
                data = json.load(fh)
        except (ValueError, OSError):
            return None
        used = [n for n in (data.get("used") or []) if isinstance(n, str)] \
            if isinstance(data, dict) else []
        if agent_type not in used:
            return None
        used.remove(agent_type)
        fd, tmp = tempfile.mkstemp(dir=os.path.dirname(upath) or ".",
                                   prefix=os.path.basename(upath) + ".", suffix=".tmp")
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump({"used": sorted(used), "ts": time.time()}, fh)
        os.replace(tmp, upath)
    return agent_type


def _hook_subagent_stop(event, roster=None, queue_dir=None):
    """SubagentStop handler for roster mode: release the finished agent's callsign.
    Output-free (a SubagentStop output can block the subagent from stopping), so
    it always returns None; the release itself is the side effect."""
    if os.environ.get("NAMED_SUBAGENTS_HOOK_DISABLE"):
        return None
    if not isinstance(event, dict):
        return None
    ros = roster if roster is not None else _load_roster()
    _roster_release(ros, event.get("agent_type"), event.get("session_id"), queue_dir)
    return None


def _hook_retype(event, roster=None, queue_dir=None, ledger_path=None):
    """PreToolUse handler for roster mode: rewrite `subagent_type` to a free
    roster callsign so the live task tree shows the NAME. Persona delivery is the
    roster agent file itself (no SubagentStart queue involved). Falls back to
    `_hook_mutate` (description+prompt naming) when no roster covers the dispatch,
    and passes through (None) anything already named."""
    if os.environ.get("NAMED_SUBAGENTS_HOOK_DISABLE"):
        return None
    if not isinstance(event, dict) or event.get("tool_name") not in _DISPATCH_TOOLS:
        return None
    ti = event.get("tool_input")
    if not isinstance(ti, dict):
        return None

    def _str(v) -> str:
        return v if isinstance(v, str) else ""

    prompt = _str(ti.get("prompt"))
    description = _str(ti.get("description"))
    subagent_type = _str(ti.get("subagent_type"))
    if _PERSONA_SIG in prompt:
        return None                       # CLI `assign` already named this dispatch
    ros = roster if roster is not None else _load_roster()
    if ros and subagent_type in (ros.get("files") or {}):
        return None                       # already retyped (a re-fire), or caller
                                          # dispatched a roster persona directly
    roster_names = sorted((ros or {}).get("files") or {})
    if (not ros or subagent_type not in (ros.get("agents") or {})
            or os.path.exists(_roster_unloaded_path(event.get("session_id"), queue_dir))):
        return _hook_mutate(event, ledger_path,   # unrostered -> legacy visible naming
                            avoid=roster_names or None)

    reg, _cfg = _hook_registry()
    task = (description + "\n" + prompt).strip()
    cat = resolve_for_hook(reg, role=subagent_type or None, task=task or None)
    name, used_cat = _roster_pick(ros, subagent_type, cat, event.get("session_id"), queue_dir)
    if not name:
        return _hook_mutate(event, ledger_path,   # roster fully live this session
                            avoid=roster_names or None)
    emoji = reg.emoji(used_cat if used_cat in reg.categories else "default")
    updated = dict(ti)
    updated["subagent_type"] = name
    # The name goes in the label too: the type column shows it, but it is truncated
    # past ~24 chars and the label is what completion notices quote.
    updated["description"] = (f"{emoji} {name} · {description}".strip()
                              if description else f"{emoji} {name}")
    return {"hookEventName": "PreToolUse", "updatedInput": updated}


def _agent_md_split(text):
    """Split a Claude Code agent .md into (frontmatter_lines, body). Frontmatter
    lines come back verbatim MINUS `name:`/`description:` (the roster clone owns
    those); no YAML parse, so unknown keys (tools, model, ...) survive untouched.
    Returns (None, text) when there is no leading frontmatter block."""
    if not text.startswith("---\n"):
        return None, text
    end = text.find("\n---\n", 4)
    if end < 0:
        return None, text
    kept = [ln for ln in text[4:end].splitlines()
            if not re.match(r"^(name|description)\s*:", ln)]
    return kept, text[end + 5:]


def _roster_agent_md(name, base_type, category, reg, base_fm, base_body) -> str:
    """Render one roster agent definition file."""
    theme = reg.theme(category)
    # Kept short: every roster file adds this line to each session's agent list.
    desc = f"Alias of {base_type}; dispatch '{base_type}' instead."
    fm = ["---", f"name: {name}", f"description: \"{desc}\""]
    fm += [ln for ln in (base_fm or []) if ln.strip()]
    fm.append("---")
    persona = persona_preamble(name, theme, task_follows=False)
    body = (base_body or "").strip() or _ROSTER_GENERIC_BODY.strip()
    return ("\n".join(fm) + "\n"
            + f"<!-- {_ROSTER_MARKER} base={base_type} category={category} -->\n"
            + persona + "\n" + body + "\n")


def _roster_find_base_file(base_type, agents_dir):
    """Locate an existing definition for `base_type` to clone (its own tools/
    model/body), searching the target dir then the user agents dir. Built-in
    types (general-purpose, Explore, ...) have no file -> generic body."""
    cands = [os.path.join(agents_dir, f"{base_type}.md"),
             os.path.join(os.path.expanduser("~"), ".claude", "agents", f"{base_type}.md")]
    for c in cands:
        if os.path.isfile(c):
            return c
    return None


def _roster_ensure(rpath=None, agents_dir=None):
    """Bring the roster to a usable state without being asked (the plugin runs this
    at SessionStart). No manifest -> install the default crew. Otherwise re-render
    any callsign file that is missing, or older than the base agent file it clones,
    so an edit to e.g. research-subagent.md reaches its callsigns instead of leaving
    them frozen at install time. Only files carrying the roster marker are touched.
    Returns a (installed, refreshed) summary."""
    rpath = rpath or _roster_state_path()
    ros = _load_roster(rpath)
    if not ros:
        argv = ["roster", "install", "--state", rpath]
        if agents_dir:
            argv += ["--dir", agents_dir]
        a = build_parser().parse_args(argv)
        with contextlib.redirect_stdout(io.StringIO()):
            cmd_roster(a)
        ros = _load_roster(rpath)
        return (len((ros or {}).get("files") or {}), 0)
    adir = ros.get("dir") or os.path.join(os.path.expanduser("~"), ".claude", "agents")
    reg, _cfg = _hook_registry()
    refreshed = 0
    for base, cats in (ros.get("agents") or {}).items():
        src = _roster_find_base_file(base, adir)
        src_m, base_fm, base_body = 0.0, None, None
        if src:
            src_m = os.path.getmtime(src)
            with open(src, "r", encoding="utf-8") as fh:
                base_fm, base_body = _agent_md_split(fh.read())
        for c, names in (cats or {}).items():
            for nm in names if isinstance(names, list) else []:
                fp = os.path.join(adir, (ros.get("files") or {}).get(nm) or f"{nm}.md")
                if os.path.exists(fp):
                    if not (src and src_m > os.path.getmtime(fp)):
                        continue
                    with open(fp, "r", encoding="utf-8") as fh:
                        if _ROSTER_MARKER not in fh.read():
                            continue      # never overwrite a file we didn't generate
                cat = c if c in reg.categories else "default"
                with open(fp, "w", encoding="utf-8") as fh:
                    fh.write(_roster_agent_md(nm, base, cat, reg, base_fm, base_body))
                if src_m > time.time():   # base mtime in the future (clock skew): pin the
                    os.utime(fp, (src_m, src_m))   # clone to it, or every run re-renders
                refreshed += 1
    return (0, refreshed)


def cmd_roster(args):
    action = args.roster_cmd
    rpath = getattr(args, "state", None) or _roster_state_path()
    if action == "ensure":
        # Runs from a SessionStart hook, whose stdout lands in the model's context:
        # --quiet prints nothing and never fails the session start.
        quiet = getattr(args, "quiet", False)
        try:
            installed, refreshed = _roster_ensure(rpath, getattr(args, "dir", None))
            if installed and quiet and not sys.stdin.isatty():
                # Agent definitions load at session start, so THIS session can't see
                # the callsigns we just wrote; retyping to one would fail the dispatch.
                ev = json.loads(sys.stdin.read() or "{}")
                sid = ev.get("session_id") if isinstance(ev, dict) else None
                if isinstance(sid, str) and sid:
                    _roster_mark_unloaded(sid)
        except Exception as e:  # noqa: BLE001 — a session start must never break
            if not quiet:
                print(f"error: {e}", file=sys.stderr)
            return 0 if quiet else 1
        if not quiet:
            print(f"roster ensure: installed {installed}, refreshed {refreshed}")
        return 0
    if action == "status":
        ros = _load_roster(rpath)
        if not ros:
            print(f"no roster installed (manifest: {rpath})")
            return 0
        adir = ros.get("dir") or "?"
        print(f"manifest:  {rpath}\nagents dir: {adir}")
        missing = 0
        for base, cats in sorted((ros.get("agents") or {}).items()):
            names = [n for ns in cats.values() for n in ns]
            print(f"  {base}: {len(names)} callsigns "
                  f"({', '.join(sorted(cats))})")
        for nm, rel in sorted((ros.get("files") or {}).items()):
            if not os.path.isfile(os.path.join(adir, rel)):
                print(f"  ⚠ missing file for {nm}: {rel}")
                missing += 1
        return 1 if missing else 0

    if action == "uninstall":
        ros = _load_roster(rpath)
        if not ros:
            print(f"no roster installed (manifest: {rpath})")
            return 0
        adir = ros.get("dir") or ""
        removed = 0
        for nm, rel in sorted((ros.get("files") or {}).items()):
            p = os.path.join(adir, rel)
            try:
                with open(p, "r", encoding="utf-8") as fh:
                    ours = _ROSTER_MARKER in fh.read()
            except OSError:
                continue
            if ours:                      # never delete a file we didn't generate
                os.unlink(p)
                removed += 1
        try:
            os.unlink(rpath)
        except OSError:
            pass
        print(f"removed {removed} roster agent file(s) from {adir} and the manifest")
        return 0

    # install
    reg, _cfg = _reg_cfg(args)
    bases = list(dict.fromkeys(args.base or ["general-purpose"]))
    adir = os.path.abspath(os.path.expanduser(
        args.dir or os.path.join("~", ".claude", "agents")))
    count = max(1, args.count)
    if args.categories:
        cats = [c.strip() for c in args.categories.split(",") if c.strip()]
        bad = [c for c in cats if c not in reg.categories]
        if bad:
            print(f"error: unknown categories: {', '.join(bad)} "
                  f"(see `named-subagents categories`)", file=sys.stderr)
            return 1
    else:
        cats = [c for c in reg.categories if c != "default"]
    os.makedirs(adir, exist_ok=True)
    led = Ledger()                        # ephemeral: cross-base draws never collide
    manifest = {"version": 1, "dir": adir, "agents": {}, "files": {}}
    written = []
    for base in bases:
        src = _roster_find_base_file(base, adir)
        base_fm, base_body = (None, None)
        if src:
            with open(src, "r", encoding="utf-8") as fh:
                base_fm, base_body = _agent_md_split(fh.read())
        per_base = {}
        drawn = 0
        for i in range(count):            # round-robin across categories
            c = cats[i % len(cats)]
            try:
                nm = _strip_gen(allocate(c, 1, reg, ledger=led)[0])
            except PoolExhaustedError:
                continue
            fp = os.path.join(adir, f"{nm}.md")
            if os.path.exists(fp) and not args.force:
                try:
                    with open(fp, "r", encoding="utf-8") as fh:
                        ours = _ROSTER_MARKER in fh.read()
                except OSError:
                    ours = False
                if not ours:
                    print(f"  skip {nm}: {fp} exists and is not a roster file "
                          f"(--force to overwrite)")
                    continue
            with open(fp, "w", encoding="utf-8") as fh:
                fh.write(_roster_agent_md(nm, base, c, reg, base_fm, base_body))
            per_base.setdefault(c, []).append(nm)
            manifest["files"][nm] = f"{nm}.md"
            written.append(nm)
            drawn += 1
        manifest["agents"][base] = per_base
        origin = f"cloned from {src}" if src else "generic body (built-in base)"
        print(f"{base}: {drawn} callsign(s) [{origin}]")
    _save_roster(manifest, rpath)
    print(f"\nwrote {len(written)} agent file(s) to {adir}\nmanifest: {rpath}\n"
          f"Next: `named-subagents hook install --roster`, then start a NEW Claude\n"
          f"Code session (agent definitions load at session start). Fan-outs will\n"
          f"show callsigns in the live task tree instead of the base agent type.\n"
          f"Note: each roster agent adds one line to the model's agent list — keep\n"
          f"the roster small (default 8/base).")
    return 0


def _settings_hooks_present(cwd=None):
    """True when a settings.json-registered copy of our hooks (from `hook install`)
    is active. The plugin's hooks then stand down: both copies would each claim a
    callsign for the same dispatch, and the loser would stay held."""
    paths = [os.path.join(os.path.expanduser("~"), ".claude", "settings.json")]
    if isinstance(cwd, str) and cwd:
        paths += [os.path.join(cwd, ".claude", n)
                  for n in ("settings.json", "settings.local.json")]
    for sp in paths:
        data, err = _read_settings(sp)
        if err:
            continue
        for ev_hooks in (data.get("hooks") or {}).values():
            if any(True for _ in _iter_our_hooks(ev_hooks)):
                return True
    return False


def cmd_hook_run(args=None, argv=None):
    """Auto-namer handler invoked by Claude Code. Reads the event JSON on stdin,
    writes a hookSpecificOutput JSON on stdout, always exits 0.

    Routing: `--capture` (the v0.4.3 PreToolUse registration) -> the output-free
    task-queue capture; a SubagentStart event -> `additionalContext` (the primary,
    clobber-proof path); anything else is treated as a PreToolUse dispatch and goes
    through `_hook_mutate` (kept so a lingering legacy PreToolUse registration still
    functions — new installs register capture + SubagentStart).

    FAIL-OPEN is the whole contract: any error is swallowed and nothing is written,
    so the dispatch proceeds unchanged. A broken namer must never break a fan-out,
    and it must never exit 2 (that would BLOCK the dispatch)."""
    try:
        capture = ("--capture" in (argv or [])) or bool(getattr(args, "capture", False))
        retype = ("--retype" in (argv or [])) or bool(getattr(args, "retype", False))
        event = json.loads(sys.stdin.read())
        ev = event.get("hook_event_name") if isinstance(event, dict) else None
        if ("--plugin" in (argv or []) and not os.environ.get("NAMED_SUBAGENTS_PLUGIN_FORCE")
                and _settings_hooks_present(
                    event.get("cwd") if isinstance(event, dict) else None)):
            return 0                      # a settings.json install already handles it
        if capture:
            out = _hook_pre_capture(event)
        elif ev == "SubagentStop":
            out = _hook_subagent_stop(event)
        elif ev == "SubagentStart":
            out = _hook_subagent_start(event)
        elif retype:
            out = _hook_retype(event)
        else:
            out = _hook_mutate(event)
        if out is not None:
            sys.stdout.write(json.dumps({"hookSpecificOutput": out}, ensure_ascii=False))
    except Exception:  # noqa: BLE001 — fail-open by design
        pass
    return 0


# ---- settings.json management (install / uninstall / status) --------------- #
def _settings_path(args) -> str:
    if getattr(args, "settings", None):
        return args.settings
    if getattr(args, "project", None):
        return os.path.join(args.project, ".claude", "settings.json")
    return os.path.join(os.path.expanduser("~"), ".claude", "settings.json")


def _hook_command(capture: bool = False) -> str:
    """The command Claude Code runs per dispatch. Absolute interpreter + `-m` module
    form (robust against the console script not being on the hook's PATH). The
    `--managed-by` marker is a real (ignored) CLI arg — NOT a shell comment — so
    status/uninstall can identify our entry whether or not the command is shell-parsed.
    `capture=True` is the v0.4.3 PreToolUse task-capture registration; the flag also
    distinguishes it from a LEGACY (pre-0.4.2, mutate-path) PreToolUse entry."""
    cap = " --capture" if capture else ""
    return f'"{sys.executable}" -m named_subagents hook run{cap} --managed-by {_HOOK_MARKER}'


def _hook_command_retype() -> str:
    """The roster-mode registration (v0.5.0): a single PreToolUse entry whose
    updatedInput rewrites `subagent_type` to a roster callsign."""
    return f'"{sys.executable}" -m named_subagents hook run --retype --managed-by {_HOOK_MARKER}'


def _hook_command_release() -> str:
    """The roster-mode SubagentStop registration: frees a finished callsign."""
    return f'"{sys.executable}" -m named_subagents hook run --release --managed-by {_HOOK_MARKER}'


def _read_settings(sp):
    """(-> data_dict, error_str_or_None). `data` is always a dict ({} when the file
    is absent OR unreadable); `error` is set when the file exists but can't be safely
    parsed, so callers refuse to clobber it. Keeping `data` a dict (never None) means
    no downstream None-handling."""
    if not os.path.exists(sp):
        return {}, None
    try:
        with open(sp, "r", encoding="utf-8") as fh:
            data = json.load(fh)
    except (ValueError, OSError) as e:
        return {}, str(e)
    if not isinstance(data, dict):
        return {}, "top-level JSON is not an object"
    return data, None


def _write_settings(sp, data, backup=False):
    d = os.path.dirname(os.path.abspath(sp)) or "."
    os.makedirs(d, exist_ok=True)
    if backup and os.path.exists(sp):
        shutil.copy2(sp, sp + ".bak")
    # mkstemp opens O_EXCL with a unique name, so a pre-planted `<settings>.tmp`
    # symlink can't redirect the write (same discipline as Ledger.save()).
    fd, tmp = tempfile.mkstemp(dir=d, prefix=os.path.basename(sp) + ".", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(json.dumps(data, ensure_ascii=False, indent=2) + "\n")
        os.replace(tmp, sp)   # atomic
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _iter_our_hooks(pre):
    """Yield (matcher_block, hook_entry) for every hook we own (marker match)."""
    for m in pre if isinstance(pre, list) else []:
        if not isinstance(m, dict):
            continue
        for h in m.get("hooks") or []:
            if isinstance(h, dict) and _HOOK_MARKER in (h.get("command") or ""):
                yield m, h


def _is_capture_hook(h) -> bool:
    """True for the v0.4.3 PreToolUse task-capture registration (ours + --capture);
    a marker'd PreToolUse entry with NEITHER flag is a legacy (pre-0.4.2) mutate hook."""
    cmd = h.get("command") or "" if isinstance(h, dict) else ""
    return _HOOK_MARKER in cmd and "--capture" in cmd


def _is_retype_hook(h) -> bool:
    """True for the v0.5.0 roster-mode PreToolUse registration (ours + --retype)."""
    cmd = h.get("command") or "" if isinstance(h, dict) else ""
    return _HOOK_MARKER in cmd and "--retype" in cmd


def _is_release_hook(h) -> bool:
    """True for the roster-mode SubagentStop registration (ours + --release)."""
    cmd = h.get("command") or "" if isinstance(h, dict) else ""
    return _HOOK_MARKER in cmd and "--release" in cmd


def _prune_our_hooks(entries, only=None):
    """Strip our marker'd hooks from a hooks-array (a `hooks.<event>` list),
    preserving every unrelated block. Returns (new_entries, removed_count).
    A non-list input passes straight through (nothing to prune). `only` narrows
    which of OUR hooks are removed (a predicate over the hook entry)."""
    if not isinstance(entries, list):
        return entries, 0

    def _ours(h):
        return (isinstance(h, dict) and _HOOK_MARKER in (h.get("command") or "")
                and (only is None or only(h)))

    removed, new = 0, []
    for m in entries:
        if not isinstance(m, dict) or not isinstance(m.get("hooks"), list):
            new.append(m)               # not a hooks block -> leave it exactly as-is
            continue
        hs = m["hooks"]
        kept = [h for h in hs if not _ours(h)]
        if len(kept) == len(hs):
            new.append(m)               # nothing of ours here -> untouched
            continue
        removed += len(hs) - len(kept)
        if kept:
            new.append({**m, "hooks": kept})   # keep the block with its survivors
        # else: the block held ONLY our hook(s) -> drop the now-empty matcher block
    return new, removed


def _hook_install_roster(args):
    """Register roster mode: ONE PreToolUse retype entry. Prunes our SubagentStart
    + capture + legacy entries — roster mode replaces them (persona now travels in
    the roster agent definition, so an SS namer would double-name)."""
    sp = _settings_path(args)
    data, err = _read_settings(sp)
    if err:
        print(f"error: {sp} is not valid settings JSON ({err}); refusing to modify it.",
              file=sys.stderr)
        return 1
    hooks = data.setdefault("hooks", {})
    if not isinstance(hooks, dict):
        print(f"error: {sp} has a non-object 'hooks'; refusing to modify.", file=sys.stderr)
        return 1
    existed = os.path.exists(sp)
    removed = 0
    for ev in ("SubagentStart", "PreToolUse"):
        new_list, n = _prune_our_hooks(hooks.get(ev), only=lambda h: not _is_retype_hook(h))
        if n:
            hooks[ev] = new_list
            removed += n
    pre = hooks.setdefault("PreToolUse", [])
    if not isinstance(pre, list):
        print(f"error: {sp} has a non-list 'hooks.PreToolUse'; refusing to modify.",
              file=sys.stderr)
        return 1
    cmd = _hook_command_retype()
    refreshed = False
    for _m, h in _iter_our_hooks(pre):
        h["command"] = cmd
        refreshed = True
        break
    if not refreshed:
        pre.append({"matcher": "Agent|Task",
                    "hooks": [{"type": "command", "command": cmd}]})
    stop = hooks.setdefault("SubagentStop", [])
    if not isinstance(stop, list):
        print(f"error: {sp} has a non-list 'hooks.SubagentStop'; refusing to modify.",
              file=sys.stderr)
        return 1
    rcmd = _hook_command_release()
    for _m, h in _iter_our_hooks(stop):
        h["command"] = rcmd
        break
    else:
        stop.append({"hooks": [{"type": "command", "command": rcmd}]})
    _write_settings(sp, data, backup=existed)
    mig = f"\n  replaced {removed} auto-namer entr{'y' if removed == 1 else 'ies'} (roster mode supersedes them)" if removed else ""
    ros = _load_roster()
    ros_line = ("" if ros else
                "\n  ⚠ no roster installed yet — run `named-subagents roster install` "
                "(until then, dispatches fall back to description+prompt naming)")
    print(f"installed the roster retype hook in {sp}\n"
          f"  event: PreToolUse   matcher: Agent|Task\n  command: {cmd}\n"
          f"  event: SubagentStop (frees a finished agent's callsign)\n"
          f"  command: {rcmd}{mig}{ros_line}\n"
          f"New Claude Code sessions will dispatch fan-outs under roster callsigns —\n"
          f"visible in the live task tree. Verify with `named-subagents hook status`.")
    return 0


def cmd_hook_install(args):
    if getattr(args, "roster", False):
        return _hook_install_roster(args)
    sp = _settings_path(args)
    data, err = _read_settings(sp)
    if err:
        print(f"error: {sp} is not valid settings JSON ({err}); refusing to modify it.\n"
              f"Fix or remove that file, then re-run `named-subagents hook install`.",
              file=sys.stderr)
        return 1
    hooks = data.setdefault("hooks", {})
    if not isinstance(hooks, dict):
        print(f"error: {sp} has a non-object 'hooks'; refusing to modify.", file=sys.stderr)
        return 1
    ss = hooks.setdefault("SubagentStart", [])
    if not isinstance(ss, list):
        print(f"error: {sp} has a non-list 'hooks.SubagentStart'; refusing to modify.", file=sys.stderr)
        return 1
    pre = hooks.setdefault("PreToolUse", [])
    if not isinstance(pre, list):
        print(f"error: {sp} has a non-list 'hooks.PreToolUse'; refusing to modify.", file=sys.stderr)
        return 1
    existed = os.path.exists(sp)
    cmd = _hook_command()
    cap_cmd = _hook_command(capture=True)
    # v0.4.2 migration: strip any LEGACY PreToolUse auto-namer entry (marker, no
    # --capture) — that mutate path is clobber-prone (claude-code#15897/#39814).
    # The v0.4.3 task-capture entry is output-free and NOT exposed to the clobber;
    # it must survive this pruning, hence the `only=` predicate.
    pre_new, pre_removed = _prune_our_hooks(pre, only=lambda h: not _is_capture_hook(h))
    if pre_removed:
        hooks["PreToolUse"] = pre = pre_new
    # Switching back from roster mode: its SubagentStop release entry has no job here.
    stop_new, stop_removed = _prune_our_hooks(hooks.get("SubagentStop"))
    if stop_removed:
        hooks["SubagentStop"] = stop_new
    migrated = " (migrated the legacy PreToolUse entry)" if pre_removed else ""
    refreshed = False
    for _m, h in _iter_our_hooks(ss):
        h["command"] = cmd              # refresh (e.g. new interpreter path); idempotent
        refreshed = True
    for _m, h in _iter_our_hooks(pre):
        h["command"] = cap_cmd
        break
    else:
        pre.append({"matcher": "Agent|Task",
                    "hooks": [{"type": "command", "command": cap_cmd}]})
    if refreshed:
        _write_settings(sp, data, backup=existed)
        print(f"auto-namer hook already installed — refreshed the commands in {sp}{migrated}")
        return 0
    ss.append({"matcher": "*", "hooks": [{"type": "command", "command": cmd}]})
    _write_settings(sp, data, backup=existed)
    mig_line = "\n  migrated the legacy PreToolUse entry" if pre_removed else ""
    print(f"installed the auto-namer hooks in {sp}\n"
          f"  event: SubagentStart   matcher: *\n  command: {cmd}\n"
          f"  event: PreToolUse     matcher: Agent|Task   (task capture, output-free)\n"
          f"  command: {cap_cmd}{mig_line}\n"
          f"New Claude Code sessions will nickname every subagent dispatch, themed by\n"
          f"its task when available (else by role).\n"
          f"Verify with `named-subagents hook status`.")
    return 0


def cmd_hook_uninstall(args):
    sp = _settings_path(args)
    if not os.path.exists(sp):
        print(f"nothing to remove: {sp} does not exist")
        return 0
    data, err = _read_settings(sp)
    if err:
        print(f"error: {sp} is not valid JSON ({err}); refusing to modify.", file=sys.stderr)
        return 1
    hooks = data.get("hooks")
    if not isinstance(hooks, dict):
        print(f"no auto-namer hook found in {sp}")
        return 0
    # Remove our entries from every event we register on.
    total = 0
    for ev in ("SubagentStart", "PreToolUse", "SubagentStop"):
        new_list, removed = _prune_our_hooks(hooks.get(ev))
        if removed:
            hooks[ev] = new_list
            total += removed
    if total:
        _write_settings(sp, data, backup=True)
        print(f"removed the auto-namer hook from {sp}")
    else:
        print(f"no auto-namer hook found in {sp}")
    return 0


def cmd_hook_status(args):
    sp = _settings_path(args)
    data, err = _read_settings(sp)
    installed, cmd, legacy, capture, retype = False, None, False, False, False
    _hk = data.get("hooks") or {}
    for _m, h in _iter_our_hooks(_hk.get("SubagentStart") or []):
        installed, cmd = True, h.get("command")
    release = any(_is_release_hook(h) for _m, h in _iter_our_hooks(_hk.get("SubagentStop") or []))
    for _m, h in _iter_our_hooks(_hk.get("PreToolUse") or []):
        if _is_capture_hook(h):
            capture = True                  # the v0.4.3 task-capture entry
            continue
        if _is_retype_hook(h):
            retype = True                   # the v0.5.0 roster-mode entry
            if not installed:
                cmd = h.get("command")
            continue
        legacy = True                       # a pre-0.4.2 (clobber-prone) registration lingers
        if not installed:
            cmd = h.get("command")
    lp = _hook_ledger_path()
    led_exists = os.path.exists(lp)
    allocated = None
    if led_exists:
        try:
            reg, _ = _hook_registry()
            allocated = ledger_stats(reg, Ledger(lp))["totals"]["total_allocated"]
        except Exception:  # noqa: BLE001 — status must never crash
            allocated = None
    disabled = bool(os.environ.get("NAMED_SUBAGENTS_HOOK_DISABLE"))
    if getattr(args, "json", False):
        print(json.dumps({
            "settings_path": sp, "settings_malformed": bool(err),
            "installed": installed, "command": cmd, "ledger_path": lp,
            "ledger_exists": led_exists, "total_allocated": allocated,
            "disabled": disabled, "legacy_pretooluse": legacy,
            "capture_installed": capture, "retype_installed": retype,
            "release_installed": release,
            "roster_path": _roster_state_path(),
            "roster_installed": bool(_load_roster()),
        }, ensure_ascii=False, indent=2))
        return 0
    print(f"settings:   {sp}" + ("  ⚠ MALFORMED JSON" if err else ""))
    if retype:
        mode = "yes  (roster mode — PreToolUse retype: callsigns in the live task tree)"
    elif installed:
        mode = "yes  (event: SubagentStart)"
    else:
        mode = "no"
    print(f"installed:  {mode}")
    if retype:
        ros = _load_roster()
        print(f"  roster:   {_roster_state_path()}  "
              f"({'installed' if ros else '⚠ NOT installed — run `named-subagents roster install`'})")
        print("  release:  " + ("yes  (SubagentStop frees finished callsigns)" if release else
              "⚠ no — callsigns are never freed within a session; re-run `hook install --roster`"))
        if installed or capture:
            print("  ⚠ mixed:  auto-namer entries are also present — "
                  "re-run `hook install --roster` to prune them")
    if cmd:
        print(f"  command:  {cmd}")
    if installed:
        print(f"  capture:  {'yes  (PreToolUse task capture — task-themed nicknames)' if capture else 'no  (role-themed only; re-run `hook install` to enable task theming)'}")
    if legacy:
        print("  ⚠ legacy:  a pre-0.4.2 PreToolUse entry is still present (clobber-prone);"
              " re-run `hook install` to migrate it, or `hook uninstall` to clear it")
    print(f"ledger:     {lp}  ({'exists' if led_exists else 'not created yet'}"
          + (f", {allocated} names allocated" if allocated is not None else "") + ")")
    if disabled:
        print("note:       NAMED_SUBAGENTS_HOOK_DISABLE is set — hook is a no-op in this env")
    return 0


# --------------------------------------------------------------------------- #
def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="named-subagents", description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--registry", help="path to registry.json (default: bundled)")
    p.add_argument("--config",
                   help="path to a config file (default search: $NAMED_SUBAGENTS_CONFIG, "
                        "~/.config/named-subagents/config.json; ./.named-subagents.json only "
                        "with --cwd-config)")
    p.add_argument("--cwd-config", dest="cwd_config", action="store_true",
                   help="opt in to loading ./.named-subagents.json (off by default since 0.3 "
                        "— it is the one untrusted-input surface)")
    p.add_argument("--no-cwd-config", dest="no_cwd_config", action="store_true",
                   help="never load ./.named-subagents.json (wins over --cwd-config and "
                        "$NAMED_SUBAGENTS_CWD_CONFIG)")
    p.add_argument("--version", action="version", version=f"named-subagents {__version__}")
    sub = p.add_subparsers(dest="cmd", required=True)

    def add_common_flags(sp):
        # SUPPRESS: when absent, don't clobber the value the root parser set
        # (argparse subparser defaults override parent-parsed attributes). Both
        # --registry and --config are accepted before OR after the subcommand.
        sp.add_argument("--registry", default=argparse.SUPPRESS,
                        help="path to registry.json (also accepted before the subcommand)")
        sp.add_argument("--config", default=argparse.SUPPRESS,
                        help="path to a config file (also accepted before the subcommand)")
        sp.add_argument("--cwd-config", dest="cwd_config", action="store_true",
                        default=argparse.SUPPRESS,
                        help="opt in to ./.named-subagents.json (also accepted before the subcommand)")
        sp.add_argument("--no-cwd-config", dest="no_cwd_config", action="store_true",
                        default=argparse.SUPPRESS,
                        help="never load ./.named-subagents.json (also accepted before the subcommand)")

    sc = sub.add_parser("categories", help="list categories + themes")
    add_common_flags(sc)
    sc.set_defaults(func=cmd_categories)

    sr = sub.add_parser("resolve", help="show which category a role/task maps to")
    sr.add_argument("--role"); sr.add_argument("--task"); sr.add_argument("--category")
    sr.add_argument("--explain", action="store_true",
                    help="show why this category was chosen (winning arm, matched keywords, scores)")
    add_common_flags(sr)
    sr.set_defaults(func=cmd_resolve)

    sa = sub.add_parser("allocate", help="emit N nicknames for a category/role/task")
    sa.add_argument("--category"); sa.add_argument("--role"); sa.add_argument("--task")
    add_common_flags(sa)
    sa.add_argument("--count", type=int, default=1)
    sa.add_argument("--ledger", help="persist used names here (non-repeat across runs)")
    sa.add_argument("--pin", action="append", metavar="CATEGORY=NAME",
                    help="pin a stable identity for a category (repeatable; overrides config pins)")
    sa.add_argument("--avoid-installed", action="store_true",
                    help="exclude installed agent names (.claude/agents scans)")
    sa.add_argument("--json", action="store_true")
    sa.set_defaults(func=cmd_allocate)

    sg = sub.add_parser("assign", help="full Agent-tool payloads for tasks")
    add_common_flags(sg)
    sg.add_argument("--task", nargs="+", action="extend", required=True,
                    help="one or more task strings (flag may be repeated)")
    sg.add_argument("--role"); sg.add_argument("--category")
    sg.add_argument("--subagent-type", dest="subagent_type")
    sg.add_argument("--count", type=int, default=0, help="replicate a single task into N workers")
    sg.add_argument("--ledger", help="persist used names here")
    sg.add_argument("--pin", action="append", metavar="CATEGORY=NAME",
                    help="pin a stable identity for a category (repeatable; overrides config pins)")
    sg.add_argument("--avoid-installed", action="store_true",
                    help="exclude installed agent names (.claude/agents scans)")
    sg.add_argument("--format", choices=["agent", "labels", "workflow", "swarm", "table"],
                    default="agent", help="output shape (default: agent JSON; `table` = human-readable)")
    sg.add_argument("--bio-in-prompt", action="store_true",
                    help="include the nickname's bio line in the persona preamble")
    sg.set_defaults(func=cmd_assign)

    for name, fn, hlp in (("release", cmd_release, "return a held name to the pool"),
                          ("retire", cmd_retire, "permanently exclude a name from allocation"),
                          ("unretire", cmd_unretire, "reverse a retire")):
        s = sub.add_parser(name, help=hlp)
        s.add_argument("--category", required=True)
        s.add_argument("--name", required=True)
        s.add_argument("--ledger", required=True)
        s.set_defaults(func=fn)

    ss = sub.add_parser("stats", help="per-category ledger usage stats")
    ss.add_argument("--ledger", help="ledger path (omit for an empty ledger)")
    ss.add_argument("--json", action="store_true")
    add_common_flags(ss)
    ss.set_defaults(func=cmd_stats)

    sd = sub.add_parser("doctor", help="self-diagnostics; exit 1 on any FAIL")
    sd.add_argument("--ledger", help="also check this ledger file")
    sd.add_argument("--json", action="store_true")
    add_common_flags(sd)
    sd.set_defaults(func=cmd_doctor)

    sb = sub.add_parser("bio", help="print the bio for a name (searches all categories)")
    sb.add_argument("name", metavar="NAME")
    add_common_flags(sb)
    sb.set_defaults(func=cmd_bio)

    si = sub.add_parser("init", help="scaffold a starter config file")
    si.add_argument("--path", help="write to this path (default: ~/.config/named-subagents/config.json)")
    si.add_argument("--cwd", action="store_true",
                    help="write ./.named-subagents.json instead (the opt-in project-local config)")
    si.add_argument("--force", action="store_true", help="overwrite an existing file")
    si.set_defaults(func=cmd_init)

    sh = sub.add_parser("hook",
                        help="auto-namer: install once, nickname every subagent dispatch")
    hsub = sh.add_subparsers(dest="hook_cmd", required=True)

    hr = hsub.add_parser("run",
                         help="(invoked by Claude Code) handle a hook event from stdin — "
                              "PreToolUse task capture (--capture) or SubagentStart naming")
    # Ignored marker so `hook status`/`uninstall` can identify the registered command
    # (a real CLI arg, robust to shell-vs-exec, unlike a `# comment`).
    hr.add_argument("--managed-by", help=argparse.SUPPRESS, default=None)
    hr.add_argument("--capture", action="store_true", help=argparse.SUPPRESS)
    hr.add_argument("--retype", action="store_true", help=argparse.SUPPRESS)
    hr.add_argument("--release", action="store_true", help=argparse.SUPPRESS)
    hr.set_defaults(func=cmd_hook_run)

    def _hook_target_flags(sp_):
        sp_.add_argument("--settings",
                         help="settings.json path (default: ~/.claude/settings.json)")
        sp_.add_argument("--project",
                         help="target <DIR>/.claude/settings.json instead of the global settings")

    hi = hsub.add_parser("install", help="register the hook in Claude Code settings.json")
    _hook_target_flags(hi)
    hi.add_argument("--roster", action="store_true",
                    help="roster mode: rewrite subagent_type to a roster callsign so the "
                         "live task tree shows the NAME (requires `roster install`)")
    hi.set_defaults(func=cmd_hook_install)

    hu = hsub.add_parser("uninstall", help="remove the hook from settings.json")
    _hook_target_flags(hu)
    hu.set_defaults(func=cmd_hook_uninstall)

    hstat = hsub.add_parser("status", help="show whether the hook is installed + ledger stats")
    _hook_target_flags(hstat)
    hstat.add_argument("--json", action="store_true")
    hstat.set_defaults(func=cmd_hook_status)

    ro = sub.add_parser("roster",
                        help="visible names: generate persona agent definitions so the "
                             "live task tree shows callsigns instead of the agent type")
    rsub = ro.add_subparsers(dest="roster_cmd", required=True)
    ri = rsub.add_parser("install", help="generate roster agent files + manifest")
    ri.add_argument("--base", action="append",
                    help="base agent type to roster (repeatable; default: general-purpose). "
                         "A custom base's .md is cloned (tools/model/body preserved); "
                         "built-in bases get a generic body")
    ri.add_argument("--dir", help="agents directory to write into (default: ~/.claude/agents)")
    ri.add_argument("--count", type=int, default=8,
                    help="callsigns per base (default 8; each adds a line to the model's agent list)")
    ri.add_argument("--categories",
                    help="comma-separated registry categories to draw from "
                         "(default: all except 'default', round-robin)")
    ri.add_argument("--force", action="store_true",
                    help="overwrite existing non-roster files with the same name")
    ri.add_argument("--state", help=argparse.SUPPRESS)   # manifest path override (tests)
    add_common_flags(ri)
    ri.set_defaults(func=cmd_roster)
    re_ = rsub.add_parser("ensure", help="install the default crew if missing; re-render "
                          "callsign files that are missing or older than their base agent")
    re_.add_argument("--quiet", action="store_true",
                     help="print nothing and always exit 0 (for a SessionStart hook)")
    re_.add_argument("--dir", help=argparse.SUPPRESS)
    re_.add_argument("--state", help=argparse.SUPPRESS)
    re_.set_defaults(func=cmd_roster)
    for name_, hlp in (("status", "show the installed roster + file integrity"),
                       ("uninstall", "delete generated roster files + the manifest")):
        rs = rsub.add_parser(name_, help=hlp)
        rs.add_argument("--state", help=argparse.SUPPRESS)
        rs.set_defaults(func=cmd_roster)

    return p


def main(argv=None):
    # FAIL-OPEN fast path: `hook run` must NEVER exit non-zero on ANY argv — argparse
    # is strict and sys.exit(2)s on an unexpected token, and exit 2 would BLOCK the
    # dispatch (the one thing the contract forbids). Route it straight to the handler,
    # bypassing argparse, so extra/unknown args can never turn into a blocking exit.
    argv_list = list(sys.argv[1:] if argv is None else argv)
    if argv_list[:2] == ["hook", "run"]:
        return cmd_hook_run(None, argv=argv_list[2:])
    args = build_parser().parse_args(argv_list)
    try:
        return args.func(args)
    except (OSError, ValueError) as e:
        # A bad ledger dir (ENOENT), a non-regular/oversized registry path, an
        # out-of-range --count, etc. surface as a clean one-line error + exit 1
        # instead of a raw traceback.
        print(f"error: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
