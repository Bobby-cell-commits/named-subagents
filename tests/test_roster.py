#!/usr/bin/env python3
"""Tests for roster mode (v0.5.0): `roster install|status|uninstall`, the
`hook run --retype` PreToolUse handler, and `hook install --roster` settings
management.

Run:  python tests/test_roster.py   (stdlib only, no pytest). Exit non-zero on any FAIL.

The load-bearing properties:
- retype rewrites `subagent_type` to a roster callsign (that is what makes the
  live task tree show the NAME — the tree label is the agent-definition name);
- concurrent siblings in one session never share a callsign; sessions recycle;
- everything degrades gracefully: unrostered base / exhausted roster -> the
  mutate path (description+prompt naming), never a broken dispatch;
- the two mechanisms never surface the same name side by side (avoid=roster).
"""
import json
import time
import os
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
PY = sys.executable
SIG = "parallel agents in this run."
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
    return subprocess.run([PY, "-m", "named_subagents"] + argv, cwd=ROOT,
                          input=stdin_data, capture_output=True, text=True, env=env)


def hook_run_retype(event, env_extra):
    r = run_cli(["hook", "run", "--retype"], env_extra=env_extra,
                stdin_data=json.dumps(event))
    out = None
    if r.stdout.strip():
        out = json.loads(r.stdout)["hookSpecificOutput"]
    return r.returncode, out


def dispatch_event(session="s1", subagent_type="general-purpose",
                   description="probe task", prompt="Do the probe."):
    return {"hook_event_name": "PreToolUse", "tool_name": "Agent",
            "session_id": session,
            "tool_input": {"subagent_type": subagent_type,
                           "description": description, "prompt": prompt}}


with tempfile.TemporaryDirectory() as td:
    AGENTS = os.path.join(td, "agents")
    STATE = os.path.join(td, "roster.json")
    ENV = {"NAMED_SUBAGENTS_ROSTER": STATE,
           "NAMED_SUBAGENTS_QUEUE_DIR": os.path.join(td, "q"),
           "NAMED_SUBAGENTS_LEDGER": os.path.join(td, "led.json")}

    section("roster install — generation")
    # A custom base file: its tools/model frontmatter and body must survive the clone.
    os.makedirs(AGENTS, exist_ok=True)
    with open(os.path.join(AGENTS, "research-subagent.md"), "w", encoding="utf-8") as fh:
        fh.write("---\nname: research-subagent\ndescription: base desc\n"
                 "tools: Read, Grep\nmodel: sonnet\n---\nBase body line.\n")
    r = run_cli(["roster", "install", "--dir", AGENTS, "--state", STATE,
                 "--count", "3", "--base", "general-purpose",
                 "--base", "research-subagent"])
    check("install exits 0", r.returncode == 0, r.stderr)
    man = json.load(open(STATE, encoding="utf-8"))
    names = sorted(man["files"])
    check("manifest holds 6 callsigns (3 per base)", len(names) == 6, str(names))
    check("both bases in manifest agents",
          set(man["agents"]) == {"general-purpose", "research-subagent"})
    files_on_disk = [n for n in names if os.path.isfile(os.path.join(AGENTS, f"{n}.md"))]
    check("every manifest callsign has a file", files_on_disk == names)

    cloned = None
    for cat_names in man["agents"]["research-subagent"].values():
        for n in cat_names:
            cloned = open(os.path.join(AGENTS, f"{n}.md"), encoding="utf-8").read()
            break
        if cloned:
            break
    check("clone keeps base tools frontmatter", cloned is not None and "tools: Read, Grep" in cloned)
    check("clone keeps base model frontmatter", cloned is not None and "model: sonnet" in cloned)
    check("clone keeps base body", cloned is not None and "Base body line." in cloned)
    check("clone drops base name/description",
          cloned is not None and "name: research-subagent" not in cloned
          and "base desc" not in cloned)
    check("clone carries the roster marker", cloned is not None and ROSTER_MARKER in cloned)
    check("clone carries the persona preamble", cloned is not None and SIG in cloned)

    gp_name = next(n for ns_ in man["agents"]["general-purpose"].values() for n in ns_)
    gp_md = open(os.path.join(AGENTS, f"{gp_name}.md"), encoding="utf-8").read()
    check("built-in base gets a generic body", "capable general agent" in gp_md)
    fm_desc = [ln for ln in gp_md.splitlines() if ln.startswith("description:")]
    check("generated description is one valid quoted line",
          len(fm_desc) == 1 and fm_desc[0].count('"') == 2)

    section("roster status / uninstall")
    r = run_cli(["roster", "status", "--state", STATE])
    check("status exits 0 with intact files", r.returncode == 0, r.stdout + r.stderr)
    os.unlink(os.path.join(AGENTS, f"{gp_name}.md"))
    r = run_cli(["roster", "status", "--state", STATE])
    check("status exits 1 + flags a missing file",
          r.returncode == 1 and "missing file" in r.stdout, r.stdout)
    # regenerate for the retype tests below
    r = run_cli(["roster", "install", "--dir", AGENTS, "--state", STATE,
                 "--count", "3", "--base", "general-purpose",
                 "--base", "research-subagent"])
    check("re-install exits 0 (idempotent over own files)", r.returncode == 0, r.stderr)

    section("hook run --retype — the visible-name rewrite")
    rc, out = hook_run_retype(dispatch_event(), ENV)
    check("exit 0", rc == 0)
    ui = (out or {}).get("updatedInput") or {}
    got1 = ui.get("subagent_type") or "??"
    check("subagent_type rewritten to a roster callsign",
          got1 in man["files"], str(out))
    check("original base no longer the type", got1 != "general-purpose")
    check("description carries the callsign in the label ('<emoji> Name · task')",
          (ui.get("description") or "").endswith(f"{got1} · probe task"), ui.get("description"))
    check("prompt untouched (persona lives in the definition)",
          ui.get("prompt") == "Do the probe.")

    rc, out2 = hook_run_retype(dispatch_event(description="second probe"), ENV)
    got2 = ((out2 or {}).get("updatedInput") or {}).get("subagent_type")
    check("sibling in the same session gets a DIFFERENT callsign",
          got2 in man["files"] and got2 != got1, f"{got1} vs {got2}")

    rc, out3 = hook_run_retype(dispatch_event(session="s2"), ENV)
    got3 = ((out3 or {}).get("updatedInput") or {}).get("subagent_type")
    check("a NEW session recycles the roster (names are a stable crew)",
          got3 == got1, f"{got3} vs {got1}")

    section("retype — theming preference")
    # research-subagent is a non-generic role -> role-first resolution; its roster
    # categories were drawn round-robin, so just assert the pick is one of ITS names.
    rc, out = hook_run_retype(dispatch_event(session="s3", subagent_type="research-subagent"), ENV)
    got = ((out or {}).get("updatedInput") or {}).get("subagent_type")
    rs_names = {n for ns_ in man["agents"]["research-subagent"].values() for n in ns_}
    check("rostered custom base draws from its OWN callsigns", got in rs_names, str(got))

    section("retype — pass-through and fallbacks")
    rc, out = hook_run_retype(dispatch_event(session="s4", subagent_type=got1), ENV)
    check("re-fire of a retyped dispatch is silent", rc == 0 and out is None, str(out))
    rc, out = hook_run_retype(
        dispatch_event(session="s4", prompt=f"You are **X** ... {SIG}\ntask"), ENV)
    check("SIG-carrying (CLI-assigned) dispatch is silent", rc == 0 and out is None, str(out))

    rc, out = hook_run_retype(dispatch_event(session="s4", subagent_type="Explore"), ENV)
    ui = (out or {}).get("updatedInput") or {}
    check("unrostered base falls back to mutate (type preserved)",
          ui.get("subagent_type") == "Explore", str(out))
    check("mutate fallback names in prompt+description", SIG in (ui.get("prompt") or ""))
    mutate_name = (ui.get("description") or "").split(":")[0]
    check("mutate fallback avoids roster callsigns",
          all(n not in mutate_name for n in man["files"]), mutate_name)

    # exhaustion: 6 callsigns for general-purpose? no — 3; burn the remaining one
    rc, _ = hook_run_retype(dispatch_event(description="third"), ENV)
    rc, out = hook_run_retype(dispatch_event(description="fourth"), ENV)
    ui = (out or {}).get("updatedInput") or {}
    check("exhausted roster falls back to mutate (type preserved)",
          ui.get("subagent_type") == "general-purpose", str(out))

    section("SubagentStop — a finished callsign returns to the pool")

    def stop_event(agent_type, session="s1"):
        return {"hook_event_name": "SubagentStop", "session_id": session,
                "agent_id": "a1", "agent_type": agent_type}

    def hook_run_release(event, env_extra):
        r = run_cli(["hook", "run", "--release"], env_extra=env_extra,
                    stdin_data=json.dumps(event))
        return r.returncode, r.stdout

    rc, so = hook_run_release(stop_event(got1), ENV)
    check("release: exit 0, output-free (output could block the stop)",
          rc == 0 and not so.strip(), so)
    rc, out = hook_run_retype(dispatch_event(description="after release"), ENV)
    got5 = ((out or {}).get("updatedInput") or {}).get("subagent_type")
    check("released callsign is reused instead of falling back", got5 == got1,
          f"{got1} vs {got5}")
    rc, so = hook_run_release(stop_event("general-purpose"), ENV)
    check("stop of a non-callsign type: silent no-op", rc == 0 and not so.strip())
    rc, so = hook_run_release(stop_event(got2, session="s-other"), ENV)
    rc, out = hook_run_retype(dispatch_event(description="still held"), ENV)
    ui = (out or {}).get("updatedInput") or {}
    check("another session's stop does not free this session's name",
          ui.get("subagent_type") == "general-purpose", str(out))
    r = run_cli(["hook", "run", "--release"], env_extra=ENV, stdin_data="{nope")
    check("release fail-open on garbage", r.returncode == 0 and not r.stdout.strip())

    qd = ENV["NAMED_SUBAGENTS_QUEUE_DIR"]
    stale = os.path.join(qd, "u-dead-session.json.lock")
    open(stale, "w").close()
    os.utime(stale, (time.time() - 72 * 3600,) * 2)
    hook_run_retype(dispatch_event(session="s-gc"), ENV)
    check("stale .lock sidecars are garbage-collected", not os.path.exists(stale))

    section("retype — fail-open on garbage")
    for label, payload in (("empty stdin", ""), ("non-JSON", "{nope"),
                           ("wrong tool", json.dumps({"hook_event_name": "PreToolUse",
                                                      "tool_name": "Bash",
                                                      "tool_input": {}}))):
        r = run_cli(["hook", "run", "--retype"], env_extra=ENV, stdin_data=payload)
        check(f"{label}: exit 0, no output", r.returncode == 0 and not r.stdout.strip())

    section("retype — no roster manifest -> mutate")
    env2 = dict(ENV)
    env2["NAMED_SUBAGENTS_ROSTER"] = os.path.join(td, "absent.json")
    rc, out = hook_run_retype(dispatch_event(session="s9"), env2)
    ui = (out or {}).get("updatedInput") or {}
    check("no manifest: mutate path (type preserved, prompt named)",
          ui.get("subagent_type") == "general-purpose" and SIG in (ui.get("prompt") or ""),
          str(out))

    section("hook install --roster — settings management")
    sp = os.path.join(td, "settings.json")
    # pre-seed an auto-namer install (SS + capture) plus a foreign hook that must survive
    with open(sp, "w", encoding="utf-8") as fh:
        json.dump({"hooks": {
            "SubagentStart": [
                {"matcher": "*", "hooks": [{"type": "command",
                                            "command": f"x hook run --managed-by {MARKER}"}]}],
            "PreToolUse": [
                {"matcher": "Agent|Task", "hooks": [
                    {"type": "command", "command": f"x hook run --capture --managed-by {MARKER}"},
                    {"type": "command", "command": "somebody-elses-hook"}]}],
        }}, fh)
    r = run_cli(["hook", "install", "--roster", "--settings", sp])
    check("install --roster exits 0", r.returncode == 0, r.stderr)
    data = json.load(open(sp, encoding="utf-8"))
    ss = data["hooks"].get("SubagentStart") or []
    check("SubagentStart auto-namer pruned (roster mode supersedes)",
          not any(MARKER in (h.get("command") or "")
                  for m in ss for h in m.get("hooks", [])), str(ss))
    pre_cmds = [h.get("command") or ""
                for m in data["hooks"]["PreToolUse"] for h in m.get("hooks", [])]
    check("capture entry pruned", not any("--capture" in c for c in pre_cmds))
    check("retype entry registered", any("--retype" in c and MARKER in c for c in pre_cmds))
    check("foreign hook untouched", any(c == "somebody-elses-hook" for c in pre_cmds))
    r = run_cli(["hook", "install", "--roster", "--settings", sp])
    data = json.load(open(sp, encoding="utf-8"))
    pre_cmds = [h.get("command") or ""
                for m in data["hooks"]["PreToolUse"] for h in m.get("hooks", [])]
    check("re-install is idempotent (one retype entry)",
          sum(1 for c in pre_cmds if "--retype" in c) == 1, str(pre_cmds))
    stop_cmds = [h.get("command") or ""
                 for m in data["hooks"].get("SubagentStop", []) for h in m.get("hooks", [])]
    check("release entry registered once on SubagentStop",
          sum(1 for c in stop_cmds if "--release" in c and MARKER in c) == 1, str(stop_cmds))

    r = run_cli(["hook", "status", "--settings", sp, "--json"], env_extra=ENV)
    st = json.loads(r.stdout)
    check("status reports retype_installed", st.get("retype_installed") is True, r.stdout)
    check("status reports roster_installed", st.get("roster_installed") is True, r.stdout)
    check("status reports release_installed", st.get("release_installed") is True, r.stdout)
    check("status: no legacy false-positive", st.get("legacy_pretooluse") is False, r.stdout)

    # switching back: plain install must replace the retype entry with SS + capture
    r = run_cli(["hook", "install", "--settings", sp])
    check("plain install exits 0", r.returncode == 0, r.stderr)
    data = json.load(open(sp, encoding="utf-8"))
    pre_cmds = [h.get("command") or ""
                for m in data["hooks"]["PreToolUse"] for h in m.get("hooks", [])]
    ss_cmds = [h.get("command") or ""
               for m in data["hooks"]["SubagentStart"] for h in m.get("hooks", [])]
    check("mode switch: retype pruned by plain install",
          not any("--retype" in c for c in pre_cmds), str(pre_cmds))
    check("mode switch: SS + capture registered",
          any(MARKER in c for c in ss_cmds) and any("--capture" in c for c in pre_cmds))
    check("foreign hook still untouched", any(c == "somebody-elses-hook" for c in pre_cmds))
    check("mode switch: release entry pruned by plain install",
          not any(MARKER in (h.get("command") or "")
                  for m in data["hooks"].get("SubagentStop", []) for h in m.get("hooks", [])))
    run_cli(["hook", "install", "--roster", "--settings", sp])
    run_cli(["hook", "uninstall", "--settings", sp])
    data = json.load(open(sp, encoding="utf-8"))
    check("uninstall removes the release entry too",
          not any(MARKER in (h.get("command") or "")
                  for m in data["hooks"].get("SubagentStop", []) for h in m.get("hooks", [])))

    section("roster ensure — what the plugin runs at SessionStart")
    ens_state = os.path.join(td, "ens.json")
    ens_dir = os.path.join(td, "ens-agents")
    ens_env = dict(ENV, NAMED_SUBAGENTS_ROSTER=ens_state)
    r = subprocess.run([PY, "-m", "named_subagents", "roster", "ensure", "--quiet",
                        "--dir", ens_dir], cwd=ROOT, capture_output=True, text=True,
                       input=json.dumps({"hook_event_name": "SessionStart",
                                         "session_id": "fresh"}),
                       env=dict(os.environ, **ens_env))
    check("ensure --quiet: exit 0, prints nothing (stdout would enter context)",
          r.returncode == 0 and not r.stdout.strip(), r.stdout + r.stderr)
    ens = json.load(open(ens_state, encoding="utf-8"))
    check("ensure installs the default crew when none exists",
          len(ens.get("files") or {}) == 8, str(ens.get("files")))
    rc, out = hook_run_retype(dispatch_event(session="fresh"), ens_env)
    ui = (out or {}).get("updatedInput") or {}
    check("the installing session is NOT retyped (its agent list predates the files)",
          ui.get("subagent_type") == "general-purpose" and SIG in (ui.get("prompt") or ""),
          str(out))
    rc, out = hook_run_retype(dispatch_event(session="later"), ens_env)
    ui = (out or {}).get("updatedInput") or {}
    check("a later session is retyped to a callsign",
          ui.get("subagent_type") in (ens.get("files") or {}), str(out))

    # drift: editing the base agent must reach its callsigns
    rs_state = os.path.join(td, "rs.json")
    rs_env = dict(ENV, NAMED_SUBAGENTS_ROSTER=rs_state)
    run_cli(["roster", "install", "--dir", AGENTS, "--state", rs_state, "--count", "2",
             "--base", "research-subagent"])
    rs = json.load(open(rs_state, encoding="utf-8"))
    base_md = os.path.join(AGENTS, "research-subagent.md")
    with open(base_md, "w", encoding="utf-8") as fh:
        fh.write("---\nname: research-subagent\ndescription: base desc\n"
                 "tools: Read, Grep, WebFetch\nmodel: sonnet\n---\nEdited body.\n")
    later = time.time() + 5
    os.utime(base_md, (later, later))
    r = run_cli(["roster", "ensure", "--state", rs_state], env_extra=rs_env)
    check("ensure reports the refresh", "refreshed 2" in r.stdout, r.stdout + r.stderr)
    clone = open(os.path.join(AGENTS, sorted(rs["files"])[0] + ".md"), encoding="utf-8").read()
    check("an edited base reaches its clones (tools + body)",
          "WebFetch" in clone and "Edited body." in clone and ROSTER_MARKER in clone, clone[:200])
    r = run_cli(["roster", "ensure", "--state", rs_state], env_extra=rs_env)
    check("ensure is idempotent when nothing changed", "refreshed 0" in r.stdout, r.stdout)

    section("plugin hooks stand down when a settings.json install exists")
    home = os.path.join(td, "home")
    os.makedirs(os.path.join(home, ".claude"), exist_ok=True)
    plug_env = dict(ENV, HOME=home)
    ev = dispatch_event(session="plug")
    r = run_cli(["hook", "run", "--retype", "--plugin"], env_extra=plug_env,
                stdin_data=json.dumps(ev))
    check("plugin retype acts when no settings install exists", '"updatedInput"' in r.stdout,
          r.stdout)
    with open(os.path.join(home, ".claude", "settings.json"), "w", encoding="utf-8") as fh:
        json.dump({"hooks": {"PreToolUse": [{"matcher": "Agent|Task", "hooks": [
            {"type": "command", "command": f"x hook run --retype --managed-by {MARKER}"}]}]}}, fh)
    r = run_cli(["hook", "run", "--retype", "--plugin"], env_extra=plug_env,
                stdin_data=json.dumps(dispatch_event(session="plug2")))
    check("plugin retype is silent when settings.json already has our hook",
          r.returncode == 0 and not r.stdout.strip(), r.stdout)

    section("roster uninstall")
    r = run_cli(["roster", "uninstall", "--state", STATE])
    check("uninstall exits 0", r.returncode == 0, r.stderr)
    left = [f for f in os.listdir(AGENTS) if f.endswith(".md")]
    check("only the non-roster base file survives", left == ["research-subagent.md"], str(left))
    check("manifest removed", not os.path.exists(STATE))

print()
if failures:
    print(f"FAILURES ({len(failures)}): " + ", ".join(failures))
    sys.exit(1)
print("ALL PASS")
