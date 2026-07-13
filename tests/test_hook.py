#!/usr/bin/env python3
"""Tests for the auto-namer hook: `hook run` (the PreToolUse handler) and the
`hook install|uninstall|status` settings-management verbs.

Run:  python tests/test_hook.py   (stdlib only, no pytest). Exit non-zero on any FAIL.

The load-bearing property is FAIL-OPEN: `hook run` must NEVER exit non-zero and
NEVER crash on bad input — a broken hook would break every subagent dispatch.
"""
import concurrent.futures
import json
import os
import subprocess
import sys
import tempfile

# Repo root (one level up from tests/) — the subprocess CWD so `python -m
# named_subagents.cli` resolves the package from source without installing, and
# on sys.path so this file's in-process `from named_subagents import ...` resolves.
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
PY = sys.executable
SIG = "parallel agents in this run."   # stable substring of persona_preamble()
MARKER = "named-subagents-autonamer"   # sentinel in the registered hook command

failures = []


def check(name, cond, detail=""):
    print(f"  [{'PASS' if cond else 'FAIL'}] {name}" + (f"  -- {detail}" if detail and not cond else ""))
    if not cond:
        failures.append(name)


def section(title):
    print(f"\n== {title} ==")


# A process-lifetime temp ledger so NO test ever writes the real default ledger
# (~/.local/state/named-subagents/hook-ledger.json). Explicit env_extra overrides it.
_SAFE_LEDGER_DIR = tempfile.mkdtemp(prefix="ns-hook-safe-")
import atexit
import shutil as _shutil
atexit.register(lambda: _shutil.rmtree(_SAFE_LEDGER_DIR, ignore_errors=True))


def run_hook(stdin, *argv, env_extra=None):
    env = os.environ.copy()
    env.pop("NAMED_SUBAGENTS_CONFIG", None)
    env.pop("NAMED_SUBAGENTS_HOOK_DISABLE", None)
    env["NAMED_SUBAGENTS_LEDGER"] = os.path.join(_SAFE_LEDGER_DIR, "safe-led.json")
    if env_extra:
        env.update(env_extra)   # explicit ledger/override wins
    return subprocess.run([PY, "-m", "named_subagents.cli", "hook", *argv],
                          input=stdin, capture_output=True, text=True, cwd=ROOT,
                          env=env, timeout=90)


def payload(tool_name="Agent", **tool_input):
    return json.dumps({"tool_name": tool_name, "tool_input": tool_input})


def updated_input(r):
    if not r.stdout.strip():
        return None
    try:
        return json.loads(r.stdout)["hookSpecificOutput"]["updatedInput"]
    except (ValueError, KeyError):
        return None


# --------------------------------------------------------------------------- #
section("idempotency signature is coupled to persona_preamble (L3)")
from named_subagents import persona_preamble  # noqa: E402
check("SIG substring is present in persona_preamble() output",
      SIG in persona_preamble("Testcallsign", "Explorers & navigators"))

# --------------------------------------------------------------------------- #
section("Ledger.lock(timeout=) is bounded — never hang (MED-1)")
try:
    import fcntl as _fcntl
except ImportError:
    _fcntl = None
if _fcntl is None:
    check("lock-timeout test skipped (no fcntl on this platform)", True)
else:
    import time as _time
    from named_subagents import Ledger as _Ledger
    with tempfile.TemporaryDirectory() as _d:
        _lp = os.path.join(_d, "led.json")
        _held = os.open(_lp + ".lock", os.O_CREAT | os.O_RDWR, 0o600)
        _fcntl.flock(_held, _fcntl.LOCK_EX)          # hold the lock from another fd
        try:
            _t0 = _time.monotonic()
            _raised = False
            try:
                with _Ledger(_lp).lock(timeout=0.3):
                    pass
            except TimeoutError:
                _raised = True
            _elapsed = _time.monotonic() - _t0
            check("lock(timeout=) raises TimeoutError on a held lock (no hang)", _raised)
            check("lock(timeout=) returns near its deadline (<2s)", _elapsed < 2.0, f"{_elapsed:.2f}s")
        finally:
            _fcntl.flock(_held, _fcntl.LOCK_UN)
            os.close(_held)

# --------------------------------------------------------------------------- #
section("hook run — mutation on Agent")
with tempfile.TemporaryDirectory() as d:
    env = {"NAMED_SUBAGENTS_LEDGER": os.path.join(d, "led.json")}
    r = run_hook(payload("Agent", description="map the auth module",
                         prompt="Do the thing.", subagent_type="general-purpose"),
                 "run", env_extra=env)
    check("exits 0 on Agent dispatch", r.returncode == 0, r.stderr[:300])
    ui = updated_input(r)
    check("emits updatedInput", ui is not None, r.stdout[:200])
    if ui:
        check("description keeps original text", ui.get("description", "").endswith("map the auth module"))
        check("description is prefixed (nickname added)", ui.get("description") != "map the auth module")
        check("prompt gets the persona preamble", SIG in ui.get("prompt", ""))
        check("original prompt retained after preamble", ui.get("prompt", "").endswith("Do the thing."))
        check("subagent_type preserved", ui.get("subagent_type") == "general-purpose")
    try:
        out = json.loads(r.stdout) if r.stdout.strip() else {}
    except ValueError:
        out = {}
    check("hookEventName == PreToolUse",
          out.get("hookSpecificOutput", {}).get("hookEventName") == "PreToolUse")
    check("does NOT force permissionDecision",
          "permissionDecision" not in out.get("hookSpecificOutput", {}))

section("hook run — Task alias")
with tempfile.TemporaryDirectory() as d:
    env = {"NAMED_SUBAGENTS_LEDGER": os.path.join(d, "led.json")}
    r = run_hook(payload("Task", description="x", prompt="y", subagent_type="general-purpose"),
                 "run", env_extra=env)
    check("mutates the Task alias too", updated_input(r) is not None, r.stdout[:200])

section("hook run — SubagentStart (additionalContext)")
with tempfile.TemporaryDirectory() as d:
    env = {"NAMED_SUBAGENTS_LEDGER": os.path.join(d, "led.json")}
    r = run_hook(json.dumps({"hook_event_name": "SubagentStart", "agent_type": "Explore"}),
                 "run", env_extra=env)
    check("SubagentStart event -> exit 0", r.returncode == 0, r.stderr[:300])
    try:
        hso = json.loads(r.stdout)["hookSpecificOutput"] if r.stdout.strip() else {}
    except (ValueError, KeyError):
        hso = {}
    check("hookEventName == SubagentStart", hso.get("hookEventName") == "SubagentStart", r.stdout[:200])
    ac = hso.get("additionalContext", "")
    check("additionalContext carries the persona SIG", SIG in ac, ac[:160])
    check("additionalContext has NO '--- YOUR TASK ---' trailer (standalone block)",
          "--- YOUR TASK ---" not in ac, ac[-120:])
    check("SubagentStart emits no updatedInput", "updatedInput" not in hso)

section("hook run — passthrough on non-dispatch tools")
r = run_hook(payload("Bash", command="ls -la"), "run")
check("Bash tool -> exit 0", r.returncode == 0)
check("Bash tool -> no mutation emitted", updated_input(r) is None, r.stdout[:200])

section("hook run — FAIL-OPEN (never break a dispatch)")
FAILOPEN = [
    ("garbage stdin", "not json {{{"),
    ("empty stdin", ""),
    ("whitespace stdin", "   \n  "),
    ("json array not object", "[1,2,3]"),
    ("json null", "null"),
    ("missing tool_input", json.dumps({"tool_name": "Agent"})),
    ("tool_input is a string", json.dumps({"tool_name": "Agent", "tool_input": "nope"})),
    ("tool_input is null", json.dumps({"tool_name": "Agent", "tool_input": None})),
    ("missing tool_name", json.dumps({"tool_input": {"prompt": "x"}})),
    ("Agent with empty tool_input", json.dumps({"tool_name": "Agent", "tool_input": {}})),
    ("prompt is not a string", json.dumps({"tool_name": "Agent", "tool_input": {"prompt": 5}})),
]
for label, stdin in FAILOPEN:
    r = run_hook(stdin, "run")
    check(f"fail-open [{label}] exits 0", r.returncode == 0, f"rc={r.returncode} err={r.stderr[:160]}")
    check(f"fail-open [{label}] never exits 2 (would block)", r.returncode != 2)

with tempfile.TemporaryDirectory() as d:
    blocker = os.path.join(d, "iam-a-file")     # a regular file as the ledger's parent dir
    open(blocker, "w").write("x")               # -> mkdir(<file>/...) fails ENOTDIR, fast + caught
    r = run_hook(payload("Agent", description="x", prompt="t", subagent_type="Explore"),
                 "run", env_extra={"NAMED_SUBAGENTS_LEDGER": os.path.join(blocker, "led.json")})
    check("fail-open on unwritable ledger dir -> exit 0", r.returncode == 0, r.stderr[:200])
    check("fail-open on unwritable ledger -> no crash output on stderr",
          "Traceback" not in r.stderr, r.stderr[:200])

# M1: unexpected argv on `hook run` must STILL exit 0 — argparse / the JS parser
# sys.exit(2) on an unexpected token, and exit 2 BLOCKS the dispatch. The TRAILING
# VALUELESS flag (`--managed-by` with no value) is the decisive case: a strict parser
# consumes the next token as its value and errors when there isn't one.
with tempfile.TemporaryDirectory() as d:
    env = {"NAMED_SUBAGENTS_LEDGER": os.path.join(d, "l.json")}
    for extra in (["--some-future-flag", "extra-token"], ["--managed-by"], ["--future-flag"]):
        r = run_hook(payload("Agent", description="map x", prompt="t", subagent_type="Explore"),
                     "run", *extra, env_extra=env)
        label = " ".join(extra)
        check(f"fail-open: `hook run {label}` exits 0 (never 2 = block)",
              r.returncode == 0, f"rc={r.returncode} err={r.stderr[:160]}")
        check(f"fail-open: `hook run {label}` still yields a mutation", updated_input(r) is not None)

section("hook run — kill switch")
r = run_hook(payload("Agent", description="x", prompt="t", subagent_type="Explore"),
             "run", env_extra={"NAMED_SUBAGENTS_HOOK_DISABLE": "1"})
check("NAMED_SUBAGENTS_HOOK_DISABLE -> passthrough (exit 0, no mutation)",
      r.returncode == 0 and updated_input(r) is None, r.stdout[:200])

section("hook run — idempotency (no double-preamble)")
with tempfile.TemporaryDirectory() as d:
    env = {"NAMED_SUBAGENTS_LEDGER": os.path.join(d, "led.json")}
    r1 = run_hook(payload("Agent", description="map auth", prompt="task body",
                          subagent_type="general-purpose"), "run", env_extra=env)
    ui1 = updated_input(r1)
    check("first pass mutates", ui1 is not None)
    if ui1:
        # feed the already-named payload back in
        r2 = run_hook(payload("Agent", **{k: ui1[k] for k in ("description", "prompt", "subagent_type")}),
                      "run", env_extra=env)
        ui2 = updated_input(r2)
        check("re-run on already-named payload -> passthrough (no re-mutation)", ui2 is None,
              (ui2 or {}).get("prompt", "")[:120])

# L2: an empty-prompt dispatch still gets a description prefix, and a re-fire on the
# already-emoji-prefixed description must NOT double-prefix.
with tempfile.TemporaryDirectory() as d:
    env = {"NAMED_SUBAGENTS_LEDGER": os.path.join(d, "led.json")}
    r1 = run_hook(payload("Agent", description="map billing", prompt="", subagent_type="code"),
                  "run", env_extra=env)
    ui1 = updated_input(r1)
    check("empty-prompt dispatch still gets a description prefix",
          bool(ui1) and ui1["description"] != "map billing", str(ui1))
    if ui1:
        r2 = run_hook(payload("Agent", description=ui1["description"], prompt="", subagent_type="code"),
                      "run", env_extra=env)
        check("emoji-prefixed description -> passthrough (no double-prefix)",
              updated_input(r2) is None, (updated_input(r2) or {}).get("description", ""))
    # LOW-1: a NORMAL (prompted) dispatch whose description happens to start with a
    # category emoji must STILL be named — the emoji probe is empty-prompt-only.
    r3 = run_hook(payload("Agent", description="📊 quarterly revenue chart",
                          prompt="Build the chart.", subagent_type="data"), "run", env_extra=env)
    ui3 = updated_input(r3)
    check("emoji-led description WITH a prompt is still named (no false idempotency)",
          bool(ui3) and SIG in ui3.get("prompt", ""), str(ui3)[:120])

section("hook run — distinct, non-repeating names")
with tempfile.TemporaryDirectory() as d:
    env = {"NAMED_SUBAGENTS_LEDGER": os.path.join(d, "led.json")}
    descs = []
    for i in range(5):
        r = run_hook(payload("Agent", description=f"map module {i}", prompt="t",
                             subagent_type="Explore"), "run", env_extra=env)
        ui = updated_input(r)
        if ui:
            descs.append(ui["description"])
    check("5 sequential dispatches -> 5 distinct descriptions", len(set(descs)) == 5, str(descs))

section("hook run — concurrency (flock: no duplicate names)")
with tempfile.TemporaryDirectory() as d:
    env = {"NAMED_SUBAGENTS_LEDGER": os.path.join(d, "led.json")}

    def one(i):
        r = run_hook(payload("Agent", description=f"m{i}", prompt="t", subagent_type="Explore"),
                     "run", env_extra=env)
        ui = updated_input(r)
        return ui["description"] if ui else None

    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as ex:
        got = [x for x in ex.map(one, range(8)) if x]
    check("8 concurrent dispatches -> 8 results", len(got) == 8, str(len(got)))
    check("8 concurrent dispatches -> 8 DISTINCT names (flock held)", len(set(got)) == 8,
          str(sorted(got)))

# --------------------------------------------------------------------------- #
section("hook install / status / uninstall")
with tempfile.TemporaryDirectory() as d:
    sp = os.path.join(d, "settings.json")   # absent to start
    r = run_hook("", "install", "--settings", sp)
    check("install into absent settings -> exit 0", r.returncode == 0, r.stderr[:300])
    check("install created the settings file", os.path.exists(sp))
    data = json.load(open(sp))
    ss = data.get("hooks", {}).get("SubagentStart", [])
    ours = [m for m in ss if any(MARKER in h.get("command", "") for h in m.get("hooks", []))]
    check("install registered exactly one auto-namer hook (SubagentStart)", len(ours) == 1, json.dumps(ss)[:300])
    if ours:
        check("matcher is the wildcard '*'", ours[0]["matcher"] == "*")
    check("install did NOT register under PreToolUse",
          not data.get("hooks", {}).get("PreToolUse"))

    r = run_hook("", "status", "--settings", sp)
    check("status exit 0 + reports installed", r.returncode == 0 and "install" in r.stdout.lower(),
          r.stdout[:200])

    # idempotent re-install (existing file -> writes a backup, no duplicate)
    r = run_hook("", "install", "--settings", sp)
    data2 = json.load(open(sp))
    ours2 = [m for m in data2["hooks"]["SubagentStart"]
             if any(MARKER in h.get("command", "") for h in m.get("hooks", []))]
    check("re-install is idempotent (still exactly one)", len(ours2) == 1)
    check("re-install of an existing file wrote a .bak", os.path.exists(sp + ".bak"))

    r = run_hook("", "uninstall", "--settings", sp)
    data3 = json.load(open(sp))
    ours3 = [m for m in data3.get("hooks", {}).get("SubagentStart", [])
             if any(MARKER in h.get("command", "") for h in m.get("hooks", []))]
    check("uninstall removed our hook", len(ours3) == 0)

section("hook install — migrates a legacy PreToolUse entry")
with tempfile.TemporaryDirectory() as d:
    sp = os.path.join(d, "settings.json")
    # Pre-seed a pre-0.4.2 auto-namer registration under PreToolUse (marker present).
    json.dump({"hooks": {"PreToolUse": [
        {"matcher": "Agent|Task", "hooks": [{"type": "command",
         "command": f"python -m named_subagents hook run --managed-by {MARKER}"}]}]}},
        open(sp, "w"))
    r = run_hook("", "install", "--settings", sp)
    check("install over a legacy PreToolUse entry -> exit 0", r.returncode == 0, r.stderr[:300])
    data = json.load(open(sp))
    pre = data.get("hooks", {}).get("PreToolUse", [])
    legacy_left = [m for m in pre if any(MARKER in h.get("command", "") for h in m.get("hooks", []))]
    check("legacy PreToolUse auto-namer entry is gone after migrate", len(legacy_left) == 0, json.dumps(pre)[:200])
    ss = data.get("hooks", {}).get("SubagentStart", [])
    ours = [m for m in ss if any(MARKER in h.get("command", "") for h in m.get("hooks", []))]
    check("a SubagentStart auto-namer entry now exists", len(ours) == 1, json.dumps(ss)[:200])

section("hook install — merge safety")
with tempfile.TemporaryDirectory() as d:
    sp = os.path.join(d, "settings.json")
    # An UNRELATED SubagentStart hook (no marker) must survive install AND uninstall.
    json.dump({"hooks": {"SubagentStart": [
        {"matcher": "*", "hooks": [{"type": "command", "command": "echo unrelated"}]}]},
        "permissions": {"allow": ["Bash"]}}, open(sp, "w"))
    r = run_hook("", "install", "--settings", sp)
    check("install into populated settings -> exit 0", r.returncode == 0, r.stderr[:300])
    data = json.load(open(sp))
    ss = data["hooks"]["SubagentStart"]
    check("preserves the pre-existing unrelated SubagentStart hook",
          any("echo unrelated" in h.get("command", "") for m in ss for h in m.get("hooks", [])))
    check("adds our auto-namer SubagentStart entry",
          any(MARKER in h.get("command", "") for m in ss for h in m.get("hooks", [])))
    check("preserves unrelated top-level keys", data.get("permissions") == {"allow": ["Bash"]})
    # uninstall must leave the unrelated hook untouched
    run_hook("", "uninstall", "--settings", sp)
    data = json.load(open(sp))
    check("uninstall leaves the unrelated SubagentStart hook intact",
          any("echo unrelated" in h.get("command", "")
              for m in data["hooks"]["SubagentStart"] for h in m.get("hooks", [])))
    check("uninstall removed our SubagentStart entry",
          not any(MARKER in h.get("command", "")
                  for m in data["hooks"]["SubagentStart"] for h in m.get("hooks", [])))

section("hook install — refuses to clobber malformed settings")
with tempfile.TemporaryDirectory() as d:
    sp = os.path.join(d, "settings.json")
    open(sp, "w").write("{ this is not valid json ")
    r = run_hook("", "install", "--settings", sp)
    check("install on malformed JSON -> non-zero exit", r.returncode != 0, r.stdout[:200])
    check("install did NOT modify the malformed file",
          open(sp).read() == "{ this is not valid json ")

# --------------------------------------------------------------------------- #
def run_cli(*argv, env_extra=None):
    env = os.environ.copy()
    env.pop("NAMED_SUBAGENTS_CONFIG", None)
    env["NAMED_SUBAGENTS_LEDGER"] = os.path.join(_SAFE_LEDGER_DIR, "safe-led.json")
    if env_extra:
        env.update(env_extra)
    return subprocess.run([PY, "-m", "named_subagents.cli", *argv],
                          capture_output=True, text=True, cwd=ROOT, env=env, timeout=90)


section("doctor knows the auto-namer (item 1)")
r = run_cli("doctor")
check("doctor exits 0 when clean", r.returncode == 0, r.stderr[:200])
check("doctor reports [PASS] hook-selftest", "[PASS] hook-selftest" in r.stdout, r.stdout[-400:])
check("doctor reports hook-install status", "hook-install" in r.stdout)
# review fix: the kill switch is a legitimate, documented state — never a FAIL / non-zero exit
r = run_cli("doctor", env_extra={"NAMED_SUBAGENTS_HOOK_DISABLE": "1"})
check("doctor with kill-switch set -> exit 0 (not a FAIL)", r.returncode == 0, r.stderr[:200])
check("doctor kill-switch -> hook-selftest is not a FAIL",
      "[FAIL] hook-selftest" not in r.stdout, r.stdout[-300:])
# review fix: a malformed (truthy non-dict) `hooks` in settings.json must not crash doctor
with tempfile.TemporaryDirectory() as _home:
    os.makedirs(os.path.join(_home, ".claude"))
    with open(os.path.join(_home, ".claude", "settings.json"), "w") as fh:
        fh.write('{"hooks": "enabled"}')
    r = run_cli("doctor", env_extra={"HOME": _home})
    check("doctor with a malformed non-dict `hooks` -> no crash (exit 0)",
          r.returncode == 0, r.stderr[:200])
    check("doctor malformed hooks -> no Traceback", "Traceback" not in r.stderr, r.stderr[:200])

section("init scaffolds a valid, usable config (item 10)")
with tempfile.TemporaryDirectory() as d:
    cfg = os.path.join(d, "config.json")
    r = run_cli("init", "--path", cfg)
    check("init exits 0 + writes the file", r.returncode == 0 and os.path.exists(cfg), r.stderr[:200])
    check("init writes valid JSON", isinstance(json.load(open(cfg)), dict))
    r = run_cli("allocate", "--category", "starships", "--count", "2", "--config", cfg)
    check("scaffolded config is usable (allocate from the custom category)",
          r.returncode == 0 and len(r.stdout.split()) == 2, r.stderr[:200])
    r = run_cli("init", "--path", cfg)
    check("init refuses overwrite without --force", r.returncode != 0)
    r = run_cli("init", "--path", cfg, "--force")
    check("init --force overwrites", r.returncode == 0, r.stderr[:200])

section("assign --format table (item 10)")
r = run_cli("assign", "--role", "Explore", "--task", "map the router", "--count", "3", "--format", "table")
check("assign --format table exits 0", r.returncode == 0, r.stderr[:200])
check("table has the header + a themed nickname row",
      "subagent_type" in r.stdout and "Explore" in r.stdout, r.stdout[:200])

# --------------------------------------------------------------------------- #
if failures:
    print(f"\nRESULT: {len(failures)} FAILED -> {failures}")
    sys.exit(1)
print("\nRESULT: ALL PASS")
