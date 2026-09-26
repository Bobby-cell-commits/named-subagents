#!/usr/bin/env python3
"""Tests for the 0.7.0 migration away from roster mode, and the settings.json
side of name mode: `roster status|uninstall|ensure`, `hook install --name`
(`--roster` kept as an alias), `hook status`, and the plugin stand-down.

Run:  python tests/test_roster.py   (stdlib only, no pytest). Exit non-zero on any FAIL.
      NAMED_SUBAGENTS_TEST_PORT=js python tests/test_roster.py   runs it against the JS port.

The load-bearing properties:
- `roster uninstall` deletes only files carrying the roster marker (never a
  user's own agent), with or without the old manifest, and `--dry-run` deletes
  nothing;
- `roster ensure` (the 0.6.0 SessionStart hook) is a silent exit-0 no-op, so a
  stale registration can never fail a session start;
- `hook install --name` registers the three name-mode entries and prunes every
  other entry of ours; a foreign hook is never touched.
"""
import json
import os
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
PY = sys.executable
# NAMED_SUBAGENTS_TEST_PORT=js runs the same checks against the JS CLI.
PORT = os.environ.get("NAMED_SUBAGENTS_TEST_PORT", "py")
CLI = ["node", os.path.join(ROOT, "js", "cli.mjs")] if PORT == "js" else [PY, "-m", "named_subagents"]
MARKER = "named-subagents-autonamer"
ROSTER_MARKER = "named-subagents-roster v1"

failures = []


def check(name, cond, detail=""):
    print(f"  [{'PASS' if cond else 'FAIL'}] {name}" + (f"  -- {detail}" if detail and not cond else ""))
    if not cond:
        failures.append(name)


def section(title):
    print(f"\n== {title} ==")


def run_cli(argv, env_extra=None, stdin_data=None):
    env = dict(os.environ)
    env.update(env_extra or {})
    return subprocess.run(CLI + argv, cwd=ROOT,
                          input=stdin_data, capture_output=True, text=True, env=env)


def roster_file(adir, name):
    with open(os.path.join(adir, f"{name}.md"), "w", encoding="utf-8") as fh:
        fh.write(f"---\nname: {name}\ndescription: \"Alias of general-purpose\"\n---\n"
                 f"<!-- {ROSTER_MARKER} base=general-purpose category=explore -->\nbody\n")


with tempfile.TemporaryDirectory() as td:
    AGENTS = os.path.join(td, "agents")
    STATE = os.path.join(td, "roster.json")
    os.makedirs(AGENTS)
    ENV = {"NAMED_SUBAGENTS_ROSTER": STATE,
           "NAMED_SUBAGENTS_QUEUE_DIR": os.path.join(td, "q"),
           "NAMED_SUBAGENTS_LEDGER": os.path.join(td, "led.json"),
           "NAMED_SUBAGENTS_SESSIONS_DIR": os.path.join(td, "sessions")}
    for nm in ("Bosch", "Puck", "Turing"):
        roster_file(AGENTS, nm)
    with open(os.path.join(AGENTS, "research-subagent.md"), "w", encoding="utf-8") as fh:
        fh.write("---\nname: research-subagent\ndescription: mine\n---\nMy body.\n")
    with open(os.path.join(AGENTS, "Hudson.md"), "w", encoding="utf-8") as fh:
        fh.write("---\nname: Hudson\ndescription: a user's own agent, same name\n---\nx\n")
    with open(STATE, "w", encoding="utf-8") as fh:
        json.dump({"version": 1, "dir": AGENTS,
                   "agents": {"general-purpose": {"explore": ["Bosch", "Puck", "Hudson"]}},
                   "files": {"Bosch": "Bosch.md", "Puck": "Puck.md", "Hudson": "Hudson.md"}}, fh)

    section("roster ensure — the 0.6.0 SessionStart command is now a no-op")
    r = run_cli(["roster", "ensure", "--quiet"], env_extra=ENV,
                stdin_data=json.dumps({"hook_event_name": "SessionStart", "session_id": "s"}))
    check("exit 0, prints nothing", r.returncode == 0 and not r.stdout.strip() and not r.stderr.strip(),
          r.stdout + r.stderr)
    check("writes no agent files", sorted(os.listdir(AGENTS)) ==
          ["Bosch.md", "Hudson.md", "Puck.md", "Turing.md", "research-subagent.md"])
    r = run_cli(["roster", "install"], env_extra=ENV)
    check("roster install is gone", r.returncode != 0)

    section("roster status — lists leftovers")
    r = run_cli(["roster", "status"], env_extra=ENV)
    check("exit 1 while leftovers exist", r.returncode == 1, r.stdout + r.stderr)
    check("lists manifest files carrying the marker",
          "Bosch.md" in r.stdout and "Puck.md" in r.stdout, r.stdout)
    check("never lists a manifest-named file without the marker", "Hudson.md" not in r.stdout)

    section("roster uninstall --dry-run")
    r = run_cli(["roster", "uninstall", "--dry-run"], env_extra=ENV)
    check("dry run exits 0", r.returncode == 0, r.stderr)
    check("dry run names the files", "Bosch.md" in r.stdout and "Puck.md" in r.stdout, r.stdout)
    check("dry run deletes nothing",
          len(os.listdir(AGENTS)) == 5 and os.path.exists(STATE))

    section("roster uninstall — with the manifest")
    r = run_cli(["roster", "uninstall"], env_extra=ENV)
    check("exit 0", r.returncode == 0, r.stderr)
    left = sorted(os.listdir(AGENTS))
    check("manifest-listed roster files removed, the user's same-named agent kept",
          left == ["Hudson.md", "Turing.md", "research-subagent.md"], str(left))
    check("manifest removed", not os.path.exists(STATE))

    section("roster uninstall — no manifest: scans --dir for the marker")
    r = run_cli(["roster", "status", "--dir", AGENTS], env_extra=ENV)
    check("status finds the unlisted leftover", r.returncode == 1 and "Turing.md" in r.stdout, r.stdout)
    r = run_cli(["roster", "uninstall", "--dir", AGENTS], env_extra=ENV)
    left = sorted(os.listdir(AGENTS))
    check("marker files removed, user files kept",
          r.returncode == 0 and left == ["Hudson.md", "research-subagent.md"], str(left) + r.stderr)
    r = run_cli(["roster", "status", "--dir", AGENTS], env_extra=ENV)
    check("status exits 0 once clean", r.returncode == 0, r.stdout)

    section("hook install --name — settings management")
    sp = os.path.join(td, "settings.json")
    with open(sp, "w", encoding="utf-8") as fh:
        json.dump({"hooks": {
            "PreToolUse": [
                {"matcher": "Agent|Task", "hooks": [
                    {"type": "command", "command": f"x hook run --retype --managed-by {MARKER}"}]},
                {"matcher": "Bash", "hooks": [{"type": "command", "command": "somebody-elses-hook"}]}],
            "SubagentStop": [{"hooks": [
                {"type": "command", "command": f"x hook run --release --managed-by {MARKER}"}]}],
            "SubagentStart": [{"matcher": "*", "hooks": [
                {"type": "command", "command": f"x hook run --managed-by {MARKER}"}]}]}}, fh)
    r = run_cli(["hook", "install", "--name", "--settings", sp], env_extra=ENV)
    check("install --name exits 0", r.returncode == 0, r.stderr)
    data = json.load(open(sp, encoding="utf-8"))
    hk = data["hooks"]

    def cmds(ev):
        return [h["command"] for b in hk.get(ev, []) for h in b.get("hooks", [])]

    check("roster retype entry pruned", not any("--retype" in c for c in cmds("PreToolUse")))
    check("roster release entry pruned", not any("--release" in c for c in cmds("SubagentStop")))
    for ev in ("PreToolUse", "SubagentStart", "SubagentStop", "Stop"):
        ours = [c for c in cmds(ev) if MARKER in c]
        check(f"{ev}: exactly one `hook run --name` entry",
              len(ours) == 1 and "hook run --name" in ours[0], str(ours))
    check("PreToolUse entry matches Agent|Task", any(
        b.get("matcher") == "Agent|Task" and any("--name" in h["command"] for h in b["hooks"])
        for b in hk["PreToolUse"]))
    check("foreign hook untouched", "somebody-elses-hook" in cmds("PreToolUse"))
    r = run_cli(["hook", "install", "--roster", "--settings", sp], env_extra=ENV)
    data = json.load(open(sp, encoding="utf-8"))
    hk = data["hooks"]
    check("--roster is an alias; re-install is idempotent",
          r.returncode == 0 and all(len([c for c in cmds(ev) if MARKER in c]) == 1
                                    for ev in ("PreToolUse", "SubagentStart", "SubagentStop", "Stop")),
          str(hk))
    r = run_cli(["hook", "status", "--settings", sp, "--json"], env_extra=ENV)
    st = json.loads(r.stdout)
    check("status reports name_installed", st.get("name_installed") is True, r.stdout)
    check("status: no legacy false-positive", st.get("legacy_pretooluse") is False, r.stdout)
    check("status drops the roster keys", "retype_installed" not in st, r.stdout)
    r = run_cli(["hook", "status", "--settings", sp], env_extra=ENV)
    check("human status names the mode", "name mode" in r.stdout, r.stdout)

    r = run_cli(["hook", "install", "--settings", sp], env_extra=ENV)
    data = json.load(open(sp, encoding="utf-8"))
    hk = data["hooks"]
    check("plain install switches back: no --name entries left",
          not any("--name" in c for ev in hk for c in cmds(ev)), str(hk))
    r = run_cli(["hook", "install", "--name", "--settings", sp], env_extra=ENV)
    r = run_cli(["hook", "uninstall", "--settings", sp], env_extra=ENV)
    data = json.load(open(sp, encoding="utf-8"))
    hk = data["hooks"]
    check("uninstall removes all four name-mode entries",
          not any(MARKER in c for ev in hk for c in cmds(ev)), str(hk))
    check("uninstall keeps the foreign hook", "somebody-elses-hook" in cmds("PreToolUse"))

    section("plugin hooks stand down when a settings.json install exists")
    if PORT == "js":
        print("  [SKIP] the plugin runs the Python port only (hooks/run.py)")
    else:
        home = os.path.join(td, "home")
        os.makedirs(os.path.join(home, ".claude"), exist_ok=True)
        plug_env = dict(ENV, HOME=home)
        ev = {"hook_event_name": "PreToolUse", "tool_name": "Agent", "session_id": "plug",
              "tool_input": {"subagent_type": "general-purpose", "description": "t", "prompt": "p"}}
        r = run_cli(["hook", "run", "--name", "--plugin"], env_extra=plug_env,
                    stdin_data=json.dumps(ev))
        check("plugin names the dispatch when no settings install exists",
              '"name"' in r.stdout, r.stdout)
        with open(os.path.join(home, ".claude", "settings.json"), "w", encoding="utf-8") as fh:
            json.dump({"hooks": {"PreToolUse": [{"matcher": "Agent|Task", "hooks": [
                {"type": "command", "command": f"x hook run --name --managed-by {MARKER}"}]}]}}, fh)
        r = run_cli(["hook", "run", "--name", "--plugin"], env_extra=plug_env,
                    stdin_data=json.dumps(dict(ev, session_id="plug2")))
        check("plugin is silent when settings.json already has our hook",
              r.returncode == 0 and not r.stdout.strip(), r.stdout)

print()
if failures:
    print(f"FAILURES ({len(failures)}): " + ", ".join(failures))
    sys.exit(1)
print("ALL PASS")
