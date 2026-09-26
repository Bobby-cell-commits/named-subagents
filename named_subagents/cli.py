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
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import time

import named_subagents as ns
from named_subagents import (
    Ledger,
    LEDGER_VERSION,
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
    legacy, capture, name_mode = False, False, False
    for _m, h in _iter_our_hooks(_sh.get("PreToolUse") or []):
        if _is_capture_hook(h):
            capture = True              # the v0.4.3 task-capture entry, NOT legacy
        elif _is_name_hook(h):
            name_mode = True            # name mode (or a 0.5/0.6 retype entry it now runs)
        else:
            legacy = True
    if hooked and _is_name_hook(hooked[1]):
        hooked = None                   # name mode's own SubagentStart entry
    if name_mode:
        add("INFO", "hook-install",
            f"name mode in {sp}"
            + ("  ⚠ auto-namer entries also present — re-run `hook install --name`"
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


# ---- name mode (v0.7.0): visible names via the Agent tool's `name` field --- #
# A PreToolUse `updatedInput` that sets `name` makes the live task tree's left
# column show that name (verified CC 2.1.283 for background general-purpose and
# Explore; nested children fold under their parent). It costs the main prompt
# nothing, unlike the v0.5/0.6 roster agent files (~57-183 tokens each, loaded
# into every session's agent list). `name` is also the SendMessage/ListAgents
# address, so two LIVE agents must never share one: ListAgents drops the first
# one's name and SendMessage(to: name) silently reaches the newest.
#
# State, per session, under the queue dir (all under one flock):
#   q-<sid>.jsonl   dispatches waiting for their SubagentStart (role FIFO)
#   b-<sid>.json    {"agents": {agent_id: {name, live, own, category, ts}}}
# SubagentStart/Stop carry agent_id + agent_type but NOT the name (and meta.json
# is written only after SubagentStart fires), so Start pairs with the oldest
# queued dispatch of its role; Starts arrive in dispatch order. A SendMessage
# resume re-fires Start/Stop without PreToolUse: Start recognises the agent_id
# and only marks it live again; Stop releases by agent_id, so a stray or repeated
# Stop can never free a name another live agent holds.
_ROSTER_MARKER = "named-subagents-roster v1"       # sentinel in 0.5/0.6 agent files
_STATE_TTL = 48 * 3600.0                           # per-session state GC horizon
_DEFAULT_ROLE = "general-purpose"                  # CC's type when subagent_type is omitted
_NAME_EVENTS = ("PreToolUse", "SubagentStart", "SubagentStop", "Stop")


def _roster_state_path() -> str:
    """Where a 0.5/0.6 roster manifest lives (read only by `roster uninstall`,
    `roster status` and doctor, to clean up or recognise leftover files)."""
    env = os.environ.get("NAMED_SUBAGENTS_ROSTER")
    if env:
        return env
    base = os.environ.get("XDG_STATE_HOME") or os.path.join(
        os.path.expanduser("~"), ".local", "state")
    return os.path.join(base, "named-subagents", "roster.json")


def _load_roster(path=None):
    """Manifest dict or None (malformed/missing -> None, never a crash)."""
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


def _bindings_path(session_id, queue_dir=None) -> str:
    sid = re.sub(r"[^A-Za-z0-9_.-]", "_", session_id if isinstance(session_id, str) else "")[:80]
    return os.path.join(queue_dir or _hook_queue_dir(), f"b-{sid or 'nosession'}.json")


def _prune_state(queue_dir=None) -> None:
    """Best-effort GC of per-session state older than _STATE_TTL (sessions end
    silently): binding files, stale `.lock` sidecars, and the u-/n- files the
    0.5/0.6 roster mode left behind."""
    qd = queue_dir or _hook_queue_dir()
    try:
        now = time.time()
        for fn in os.listdir(qd):
            if ((fn.startswith(("b-", "u-", "n-")) and fn.endswith(".json"))
                    or (fn.startswith("a-") and fn.endswith(".jsonl")) or fn.endswith(".lock")):
                p = os.path.join(qd, fn)
                try:
                    if now - os.path.getmtime(p) > _STATE_TTL:
                        os.unlink(p)
                except OSError:
                    pass
    except OSError:
        pass


def _read_json(path, default):
    try:
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
    except (ValueError, OSError):
        return default
    return data if isinstance(data, type(default)) else default


def _write_json_atomic(path, data) -> None:
    d = os.path.dirname(path) or "."
    fd, tmp = tempfile.mkstemp(dir=d, prefix=os.path.basename(path) + ".", suffix=".tmp")
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False)
    os.replace(tmp, path)


def _read_queue(qpath):
    """Unexpired queue entries (orphans older than _QUEUE_TTL_SECONDS dropped)."""
    try:
        with open(qpath, "r", encoding="utf-8") as fh:
            lines = fh.read().splitlines()
    except OSError:
        return []
    now, out = time.time(), []
    for line in lines:
        try:
            e = json.loads(line)
        except ValueError:
            continue
        if isinstance(e, dict) and now - float(e.get("ts") or 0) <= _QUEUE_TTL_SECONDS:
            out.append(e)
    return out


def _write_queue(qpath, entries) -> None:
    if not entries:
        try:
            os.unlink(qpath)
        except OSError:
            pass
        return
    d = os.path.dirname(qpath) or "."
    fd, tmp = tempfile.mkstemp(dir=d, prefix=os.path.basename(qpath) + ".", suffix=".tmp")
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        for e in entries:
            fh.write(json.dumps(e, ensure_ascii=False) + "\n")
    os.replace(tmp, qpath)


def _read_bindings(bpath):
    data = _read_json(bpath, {})
    agents = data.get("agents")
    return {k: v for k, v in agents.items() if isinstance(v, dict)} if isinstance(agents, dict) else {}


def _live_names(bindings, queue):
    """Names held by live agents plus names queued for a Start that hasn't fired."""
    names = {r.get("name") for r in bindings.values() if r.get("live")}
    names |= {e.get("name") for e in queue if not e.get("skip")}
    return {n for n in names if isinstance(n, str) and n}


def _name_live(session_id, queue_dir=None):
    """The session's live + pending names (read-only; for tests and status)."""
    qpath = _queue_path(session_id, queue_dir)
    return _live_names(_read_bindings(_bindings_path(session_id, queue_dir)), _read_queue(qpath))


def _peer_session_titles():
    """Titles of local Claude Code sessions (~/.claude/sessions/<pid>.json `name`).
    They share SendMessage's address space with subagent names, so a subagent
    named like a peer session could be ambiguous. Unreadable files are skipped."""
    d = os.environ.get("NAMED_SUBAGENTS_SESSIONS_DIR") or os.path.join(
        os.path.expanduser("~"), ".claude", "sessions")
    titles = set()
    try:
        entries = os.listdir(d)
    except OSError:
        return titles
    for fn in entries:
        if not fn.endswith(".json"):
            continue
        p = os.path.join(d, fn)
        try:
            if not stat.S_ISREG(os.stat(p).st_mode) or os.path.getsize(p) > 65536:
                continue
        except OSError:
            continue
        data = _read_json(p, {})
        t = data.get("name")
        if isinstance(t, str) and t:
            titles.add(t)
    return titles


def _name_pre(event, queue_dir=None, ledger_path=None):
    """PreToolUse: pick a name unique among the session's live agents and emit it
    in `name` plus the `<emoji> Name · task` label (finish notices quote the label,
    and it is the fallback if CC stops honoring `name`). The prompt is untouched:
    the identity block arrives via SubagentStart. A model-supplied `name` and a
    CLI-assigned dispatch pass through; both are still queued so the pairing with
    SubagentStart stays in step, and a model-supplied name counts as live."""
    if not isinstance(event, dict) or event.get("tool_name") not in _DISPATCH_TOOLS:
        return None
    ti = event.get("tool_input")
    if not isinstance(ti, dict):
        return None

    def _str(v) -> str:
        return v if isinstance(v, str) else ""

    prompt, description = _str(ti.get("prompt")), _str(ti.get("description"))
    role = _str(ti.get("subagent_type")) or _DEFAULT_ROLE
    given = _str(ti.get("name")).strip()
    reg, _cfg = _hook_registry()
    entry = {"role": role, "ts": time.time()}
    if given:
        entry.update(name=given, own=False)
    elif _PERSONA_SIG in prompt or (not prompt and description and any(
            description.startswith(reg.emoji(c)) for c in reg.categories)):
        entry["skip"] = True
    else:
        entry["category"] = resolve_for_hook(
            reg, role=role, task=(description + "\n" + prompt).strip() or None)

    sid = event.get("session_id")
    qpath = _queue_path(sid, queue_dir)
    os.makedirs(os.path.dirname(qpath) or ".", exist_ok=True)
    _prune_state(queue_dir)
    with _queue_lock(qpath):
        queue = _read_queue(qpath)
        if "category" in entry:
            avoid = _live_names(_read_bindings(_bindings_path(sid, queue_dir)), queue)
            avoid |= _peer_session_titles()
            led = Ledger(ledger_path if ledger_path is not None else _hook_ledger_path())
            if led.path:
                os.makedirs(os.path.dirname(os.path.abspath(led.path)) or ".", exist_ok=True)
            with led.lock(timeout=10):
                drawn = allocate(entry["category"], 1, reg, ledger=led, avoid=avoid)[0]
                led.save()
            entry.update(name=_strip_gen(drawn), own=True)
        queue.append(entry)
        _write_queue(qpath, queue)
    if not entry.get("own"):
        return None
    nm, cat = entry["name"], entry["category"]
    updated = dict(ti)
    if not os.environ.get("NAMED_SUBAGENTS_FAULT_DROP_NAME"):   # break-it-on-purpose switch
        updated["name"] = nm
    emoji = reg.emoji(cat if cat in reg.categories else "default")
    updated["description"] = (f"{emoji} {nm} · {description}".strip()
                              if description else f"{emoji} {nm}")
    return {"hookSpecificOutput": {"hookEventName": "PreToolUse", "updatedInput": updated}}


def _name_start(event, queue_dir=None):
    """SubagentStart: bind the oldest queued dispatch of this role to agent_id and
    inject the identity block (`[Name]` report line), which the roster agent files
    used to carry. A known agent_id is a SendMessage resume: mark it live again,
    inject nothing, and leave the queue alone (its entries belong to siblings)."""
    if not isinstance(event, dict):
        return None
    aid = event.get("agent_id")
    if not isinstance(aid, str) or not aid:
        return None
    atype = event.get("agent_type")
    atype = atype if isinstance(atype, str) and atype else _DEFAULT_ROLE
    sid = event.get("session_id")
    qpath, bpath = _queue_path(sid, queue_dir), _bindings_path(sid, queue_dir)
    os.makedirs(os.path.dirname(qpath) or ".", exist_ok=True)
    with _queue_lock(qpath):
        bindings = _read_bindings(bpath)
        if aid in bindings:
            bindings[aid].update(live=True, ts=time.time())
            _write_json_atomic(bpath, {"agents": bindings})
            return None
        queue = _read_queue(qpath)
        idx = next((i for i, e in enumerate(queue) if e.get("role") == atype), None)
        if idx is None:
            return None
        entry = queue.pop(idx)
        _write_queue(qpath, queue)
        if entry.get("skip") or not isinstance(entry.get("name"), str):
            return None
        bindings[aid] = {"name": entry["name"], "live": True, "own": bool(entry.get("own")),
                         "category": entry.get("category"), "ts": time.time()}
        _write_json_atomic(bpath, {"agents": bindings})
    if not entry.get("own"):
        return None
    reg, _cfg = _hook_registry()
    cat = entry.get("category")
    theme = reg.theme(cat if cat in reg.categories else "default")
    bio = reg.bio(cat, entry["name"]) if os.environ.get("NAMED_SUBAGENTS_HOOK_BIO") else None
    context = persona_preamble(entry["name"], theme, bio=bio, task_follows=False)
    return {"hookSpecificOutput": {"hookEventName": "SubagentStart",
                                   "additionalContext": context}}


def _meta_path(event, aid):
    """The subagent's meta.json: next to agent_transcript_path, else derived from
    the session transcript_path (`<dir>/<sid>.jsonl` -> `<dir>/<sid>/subagents/`)."""
    atp = event.get("agent_transcript_path")
    if isinstance(atp, str) and atp.endswith(".jsonl"):
        return atp[:-len(".jsonl")] + ".meta.json"
    tp = event.get("transcript_path")
    if isinstance(tp, str) and tp.endswith(".jsonl"):
        return os.path.join(tp[:-len(".jsonl")], "subagents", f"agent-{aid}.meta.json")
    return None


def _alerts_path(session_id, queue_dir=None) -> str:
    sid = re.sub(r"[^A-Za-z0-9_.-]", "_", session_id if isinstance(session_id, str) else "")[:80]
    return os.path.join(queue_dir or _hook_queue_dir(), f"a-{sid or 'nosession'}.jsonl")


def _name_check(event, aid, expected):
    """The alert text when the subagent's meta.json does not carry `expected`,
    else None. It is the detector for CC ceasing to honor `name` (and for a
    Start paired with the wrong dispatch)."""
    mp = _meta_path(event, aid)
    if not mp or not os.path.isfile(mp):
        return (f"named-subagents: cannot verify {expected}'s name — its meta.json is "
                f"missing ({mp or 'no transcript path in the SubagentStop event'}). "
                f"Claude Code may have changed how it records subagents.")
    got = _read_json(mp, {}).get("name")
    if not isinstance(got, str) or not got:
        return (f"named-subagents: {expected} was dispatched with `name` but Claude Code "
                f"did not record it — the task tree likely showed the agent type instead. "
                f"`name` may no longer be honored; the label still carries the name.")
    if got != expected:
        return (f"named-subagents: identity mix-up — the agent shown as {got} was told it "
                f"is {expected}. Its [Name] report line will not match the tree.")
    return None


def _name_stop(event, queue_dir=None):
    """SubagentStop: release the agent's name by agent_id (a Stop for an agent that
    is not live — unknown, or already released — is a no-op), then check its
    meta.json. A failed check is RECORDED, not emitted: CC 2.1.283 drops a
    SubagentStop systemMessage (it renders one from PreToolUse/PostToolUse/Stop),
    so the main agent's Stop hook shows it (_name_main_stop). Always returns None
    (a SubagentStop `decision` could block the stop)."""
    if not isinstance(event, dict):
        return None
    aid = event.get("agent_id")
    if not isinstance(aid, str) or not aid:
        return None
    sid = event.get("session_id")
    qpath, bpath = _queue_path(sid, queue_dir), _bindings_path(sid, queue_dir)
    if not os.path.exists(bpath):
        return None
    with _queue_lock(qpath):
        bindings = _read_bindings(bpath)
        rec = bindings.get(aid)
        if not rec or not rec.get("live"):
            return None
        rec.update(live=False, ts=time.time())
        _write_json_atomic(bpath, {"agents": bindings})
        alert = _name_check(event, aid, rec.get("name"))
        if alert:
            with open(_alerts_path(sid, queue_dir), "a", encoding="utf-8") as fh:
                fh.write(json.dumps({"msg": alert, "ts": time.time()}, ensure_ascii=False) + "\n")
    return None


def _name_main_stop(event, queue_dir=None):
    """Main-agent Stop: show this session's recorded alerts to the owner as one
    `systemMessage`, then clear them. Each broken dispatch alerts once, so a CC
    change that breaks `name` alerts on every dispatch from then on."""
    sid = event.get("session_id")
    apath = _alerts_path(sid, queue_dir)
    if not os.path.exists(apath):
        return None
    qpath = _queue_path(sid, queue_dir)
    with _queue_lock(qpath):
        try:
            with open(apath, "r", encoding="utf-8") as fh:
                lines = fh.read().splitlines()
            os.unlink(apath)
        except OSError:
            return None
    msgs = []
    for line in lines:
        try:
            m = json.loads(line).get("msg")
        except (ValueError, AttributeError):
            continue
        if isinstance(m, str) and m and m not in msgs:
            msgs.append(m)
    return {"systemMessage": "\n".join(msgs)} if msgs else None


def _hook_name(event, queue_dir=None, ledger_path=None):
    """`hook run --name`: route one hook event to its name-mode handler. Returns
    the full hook output object (or None)."""
    if os.environ.get("NAMED_SUBAGENTS_HOOK_DISABLE") or not isinstance(event, dict):
        return None
    ev = event.get("hook_event_name")
    if ev == "SubagentStart":
        return _name_start(event, queue_dir)
    if ev == "SubagentStop":
        return _name_stop(event, queue_dir)
    if ev == "Stop":
        return _name_main_stop(event, queue_dir)
    return _name_pre(event, queue_dir, ledger_path)


def _roster_leftovers(adir=None):
    """(agents_dir, [paths]) of 0.5/0.6 roster agent files still on disk: every
    manifest-listed file carrying the roster marker, else (no manifest) every
    *.md in the agents dir that carries it. Never returns a file we didn't write."""
    ros = _load_roster()
    adir = adir or (ros or {}).get("dir") or os.path.join(os.path.expanduser("~"), ".claude", "agents")
    if ros and adir == ros.get("dir"):
        cands = [os.path.join(adir, rel) for rel in sorted((ros.get("files") or {}).values())]
    elif os.path.isdir(adir):
        cands = [os.path.join(adir, f) for f in sorted(os.listdir(adir)) if f.endswith(".md")]
    else:
        cands = []
    found = []
    for p in cands:
        try:
            with open(p, "r", encoding="utf-8") as fh:
                if _ROSTER_MARKER in fh.read(8192):
                    found.append(p)
        except OSError:
            continue
    return adir, found


def cmd_roster(args):
    """Roster mode was removed in 0.7.0 (name mode replaces it). What remains is
    the migration: `status` lists leftover roster files, `uninstall` deletes them
    and the manifest, and `ensure` is a silent no-op so a stale SessionStart
    registration can never fail a session start."""
    action = args.roster_cmd
    rpath = getattr(args, "state", None) or _roster_state_path()
    if getattr(args, "state", None):
        os.environ["NAMED_SUBAGENTS_ROSTER"] = rpath
    if action == "ensure":
        return 0
    adir, files = _roster_leftovers(getattr(args, "dir", None))
    if action == "status":
        if not files:
            print(f"no roster agent files in {adir} — nothing to migrate")
            return 0
        print(f"{len(files)} leftover roster agent file(s) in {adir} "
              f"(roster mode was removed in 0.7.0):")
        for p in files:
            print(f"  {os.path.basename(p)}")
        print("Remove them with `named-subagents roster uninstall` "
              "(add --dry-run to preview).")
        return 1
    # uninstall
    dry = getattr(args, "dry_run", False)
    for p in files:
        if dry:
            print(f"would remove {p}")
        else:
            os.unlink(p)
    if dry:
        print(f"dry run: {len(files)} roster agent file(s) in {adir}"
              + (f"; manifest {rpath}" if os.path.exists(rpath) else ""))
        return 0
    try:
        os.unlink(rpath)
    except OSError:
        pass
    print(f"removed {len(files)} roster agent file(s) from {adir} and the manifest. "
          f"Start a new Claude Code session so its agent list drops them.")
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
        flags = set(argv or [])
        capture = "--capture" in flags or bool(getattr(args, "capture", False))
        # --retype/--release are the 0.5/0.6 roster registrations; they now run
        # name mode, so a lingering settings.json install keeps naming.
        name_mode = bool(flags & {"--name", "--retype", "--release"}) or any(
            bool(getattr(args, f, False)) for f in ("name", "retype", "release"))
        event = json.loads(sys.stdin.read())
        ev = event.get("hook_event_name") if isinstance(event, dict) else None
        if ("--plugin" in (argv or []) and not os.environ.get("NAMED_SUBAGENTS_PLUGIN_FORCE")
                and _settings_hooks_present(
                    event.get("cwd") if isinstance(event, dict) else None)):
            return 0                      # a settings.json install already handles it
        if name_mode:
            top = _hook_name(event)
            if top is not None:
                sys.stdout.write(json.dumps(top, ensure_ascii=False))
            return 0
        if capture:
            out = _hook_pre_capture(event)
        elif ev == "SubagentStop":
            out = None                    # only name mode acts on SubagentStop
        elif ev == "SubagentStart":
            out = _hook_subagent_start(event)
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


def _hook_command_name() -> str:
    """The name-mode registration (v0.7.0): the same command on PreToolUse,
    SubagentStart and SubagentStop; `hook run --name` routes by event."""
    return f'"{sys.executable}" -m named_subagents hook run --name --managed-by {_HOOK_MARKER}'


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


def _is_name_hook(h) -> bool:
    """True for a name-mode registration (ours + --name), or a 0.5/0.6 roster one
    (--retype/--release), which `hook run` now also routes to name mode."""
    cmd = h.get("command") or "" if isinstance(h, dict) else ""
    return _HOOK_MARKER in cmd and any(f in cmd for f in ("--name", "--retype", "--release"))


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


def _hook_install_name(args):
    """Register name mode: one `hook run --name` entry each on PreToolUse
    (Agent|Task), SubagentStart and SubagentStop. Prunes every other entry of ours
    (auto-namer, capture, 0.5/0.6 retype/release) — name mode injects the identity
    itself, so a second SubagentStart namer would double-name."""
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
    for ev in _NAME_EVENTS:
        if not isinstance(hooks.setdefault(ev, []), list):
            print(f"error: {sp} has a non-list 'hooks.{ev}'; refusing to modify.",
                  file=sys.stderr)
            return 1
    existed = os.path.exists(sp)
    cmd = _hook_command_name()
    removed = 0
    for ev in _NAME_EVENTS:
        new_list, n = _prune_our_hooks(hooks[ev])
        hooks[ev] = new_list
        removed += n
        block = {"hooks": [{"type": "command", "command": cmd}]}
        if ev == "PreToolUse":
            block = {"matcher": "Agent|Task", **block}
        hooks[ev].append(block)
    _write_settings(sp, data, backup=existed)
    mig = (f"\n  replaced {removed} earlier entr{'y' if removed == 1 else 'ies'} of ours"
           if removed else "")
    _adir, left = _roster_leftovers()
    left_line = (f"\n  ⚠ {len(left)} roster agent file(s) from 0.5/0.6 remain — remove them "
                 f"with `named-subagents roster uninstall`" if left else "")
    print(f"installed name mode in {sp}\n"
          f"  events: PreToolUse (Agent|Task), SubagentStart, SubagentStop, Stop\n"
          f"  command: {cmd}{mig}{left_line}\n"
          f"New Claude Code sessions will show each subagent's name in the live task tree.\n"
          f"Verify with `named-subagents hook status`.")
    return 0


def cmd_hook_install(args):
    if getattr(args, "name", False) or getattr(args, "roster", False):
        return _hook_install_name(args)
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
    for ev in ("SubagentStop", "Stop"):    # name mode's release + alert entries
        ev_new, ev_removed = _prune_our_hooks(hooks.get(ev))
        if ev_removed:
            hooks[ev] = ev_new
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
    for ev in ("SubagentStart", "PreToolUse", "SubagentStop", "Stop"):
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
    installed, cmd, legacy, capture = False, None, False, False
    _hk = data.get("hooks") or {}
    name_events = [ev for ev in _NAME_EVENTS
                   if any(_is_name_hook(h) for _m, h in _iter_our_hooks(_hk.get(ev) or []))]
    name_mode = "PreToolUse" in name_events
    for _m, h in _iter_our_hooks(_hk.get("SubagentStart") or []):
        if not _is_name_hook(h):
            installed, cmd = True, h.get("command")
    for _m, h in _iter_our_hooks(_hk.get("PreToolUse") or []):
        if _is_capture_hook(h):
            capture = True                  # the v0.4.3 task-capture entry
        elif _is_name_hook(h):
            cmd = h.get("command")          # name mode (or a 0.5/0.6 retype entry)
        else:
            legacy = True                   # a pre-0.4.2 (clobber-prone) registration lingers
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
    _adir, leftovers = _roster_leftovers()
    if getattr(args, "json", False):
        print(json.dumps({
            "settings_path": sp, "settings_malformed": bool(err),
            "installed": installed, "command": cmd, "ledger_path": lp,
            "ledger_exists": led_exists, "total_allocated": allocated,
            "disabled": disabled, "legacy_pretooluse": legacy,
            "capture_installed": capture, "name_installed": name_mode,
            "name_events": name_events, "roster_leftover_files": len(leftovers),
        }, ensure_ascii=False, indent=2))
        return 0
    print(f"settings:   {sp}" + ("  ⚠ MALFORMED JSON" if err else ""))
    if name_mode:
        mode = "yes  (name mode — names in the live task tree)"
    elif installed:
        mode = "yes  (event: SubagentStart)"
    else:
        mode = "no"
    print(f"installed:  {mode}")
    if name_mode and len(name_events) < len(_NAME_EVENTS):
        print(f"  ⚠ partial: name mode is registered only on {', '.join(name_events)} "
              f"(identity, release and alerts need all {len(_NAME_EVENTS)}) — "
              f"re-run `hook install --name`")
    if name_mode and (installed or capture):
        print("  ⚠ mixed:  auto-namer entries are also present — "
              "re-run `hook install --name` to prune them")
    if cmd:
        print(f"  command:  {cmd}")
    if installed:
        print(f"  capture:  {'yes  (PreToolUse task capture — task-themed nicknames)' if capture else 'no  (role-themed only; re-run `hook install` to enable task theming)'}")
    if legacy:
        print("  ⚠ legacy:  a pre-0.4.2 PreToolUse entry is still present (clobber-prone);"
              " re-run `hook install` to migrate it, or `hook uninstall` to clear it")
    if leftovers:
        print(f"  ⚠ roster: {len(leftovers)} agent file(s) from 0.5/0.6 remain in {_adir} "
              f"— `named-subagents roster uninstall` removes them")
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
    hr.add_argument("--name", action="store_true", help=argparse.SUPPRESS)
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
    hi.add_argument("--name", action="store_true",
                    help="name mode: set each dispatch's `name` so the live task tree "
                         "shows it (PreToolUse + SubagentStart + SubagentStop)")
    hi.add_argument("--roster", action="store_true", help=argparse.SUPPRESS)  # 0.5/0.6 alias
    hi.set_defaults(func=cmd_hook_install)

    hu = hsub.add_parser("uninstall", help="remove the hook from settings.json")
    _hook_target_flags(hu)
    hu.set_defaults(func=cmd_hook_uninstall)

    hstat = hsub.add_parser("status", help="show whether the hook is installed + ledger stats")
    _hook_target_flags(hstat)
    hstat.add_argument("--json", action="store_true")
    hstat.set_defaults(func=cmd_hook_status)

    ro = sub.add_parser("roster",
                        help="migration: find/remove agent files left by the 0.5/0.6 "
                             "roster mode (removed in 0.7.0)")
    rsub = ro.add_subparsers(dest="roster_cmd", required=True)
    for name_, hlp in (("status", "list leftover roster agent files (exit 1 if any)"),
                       ("uninstall", "delete leftover roster agent files + the manifest"),
                       ("ensure", argparse.SUPPRESS)):
        rs = rsub.add_parser(name_, help=hlp)
        rs.add_argument("--dir", help="agents directory to scan (default: the manifest's, "
                                      "else ~/.claude/agents)")
        rs.add_argument("--state", help=argparse.SUPPRESS)
        rs.add_argument("--quiet", action="store_true", help=argparse.SUPPRESS)
        if name_ == "uninstall":
            rs.add_argument("--dry-run", dest="dry_run", action="store_true",
                            help="list what would be removed, remove nothing")
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
