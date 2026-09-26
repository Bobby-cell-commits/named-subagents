#!/usr/bin/env python3
"""Tests for name mode (v0.7.0): `hook run --name` on PreToolUse / SubagentStart /
SubagentStop. The Agent tool's `name` field makes the live task tree show the
name, so no agent files are needed.

Run:  python tests/test_name_mode.py   (stdlib only, no pytest). Exit non-zero on any FAIL.
      NAMED_SUBAGENTS_TEST_PORT=js python tests/test_name_mode.py   runs it against the JS port.

The load-bearing properties:
- a dispatch gets a bare pool name in `name` + the `<emoji> Name · task` label;
- a name is never handed out while another live agent in the session holds it
  (duplicate live names break ListAgents/SendMessage routing), nor when it
  equals a peer-session title;
- a model-supplied `name` is left alone (but still counts as live);
- SubagentStart binds name -> agent_id and injects the identity block;
- SubagentStop releases BY agent_id, so a resume's extra Start/Stop cannot free
  a name another live agent holds;
- SubagentStop reads the subagent's meta.json and surfaces a missing or wrong
  name as a `systemMessage` (the owner sees it), never just a log line.
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
SIG = "parallel agents in this run."

from named_subagents import cli  # noqa: E402

failures = []


def check(name, cond, detail=""):
    print(f"  [{'PASS' if cond else 'FAIL'}] {name}" + (f"  -- {detail}" if detail and not cond else ""))
    if not cond:
        failures.append(name)


def section(title):
    print(f"\n== {title} ==")


def run(event, env, flag="--name", extra=()):
    e = dict(os.environ)
    e.update(env)
    r = subprocess.run(CLI + ["hook", "run", flag, *extra], cwd=ROOT,
                       input=json.dumps(event) if not isinstance(event, str) else event,
                       capture_output=True, text=True, env=e)
    out = json.loads(r.stdout) if r.stdout.strip() else None
    return r.returncode, out


_tuid = [0]


def pre(session="s1", subagent_type="general-purpose", description="probe task",
        prompt="Do the probe.", name=None, tool="Agent", tool_use_id=None):
    ti = {"description": description, "prompt": prompt}
    if subagent_type is not None:
        ti["subagent_type"] = subagent_type
    if name is not None:
        ti["name"] = name
    if tool_use_id is None:
        _tuid[0] += 1
        tool_use_id = f"toolu_{_tuid[0]}"
    return {"hook_event_name": "PreToolUse", "tool_name": tool, "session_id": session,
            "tool_use_id": tool_use_id, "tool_input": ti}


TX = None          # the session transcript path; set once the temp dir exists


def meta_file(aid):
    """Where CC keeps agent <aid>'s meta.json, relative to the session transcript."""
    return os.path.join(TX[:-len(".jsonl")], "subagents", f"agent-{aid}.meta.json")


def write_meta(aid, meta):
    os.makedirs(os.path.dirname(meta_file(aid)), exist_ok=True)
    with open(meta_file(aid), "w", encoding="utf-8") as fh:
        json.dump(meta, fh)


def start(aid, session="s1", agent_type="general-purpose"):
    return {"hook_event_name": "SubagentStart", "session_id": session, "transcript_path": TX,
            "agent_id": aid, "agent_type": agent_type}


def stop(aid, session="s1", agent_type="general-purpose", meta=None, td=None):
    ev = {"hook_event_name": "SubagentStop", "session_id": session,
          "agent_id": aid, "agent_type": agent_type}
    if td is not None:
        tp = os.path.join(td, "subagents", f"agent-{aid}.jsonl")
        os.makedirs(os.path.dirname(tp), exist_ok=True)
        ev["agent_transcript_path"] = tp
        if meta is not None:
            with open(tp[:-len(".jsonl")] + ".meta.json", "w", encoding="utf-8") as fh:
                json.dump(meta, fh)
    return ev


def name_of(out):
    return ((out or {}).get("hookSpecificOutput") or {}).get("updatedInput", {}).get("name")


with tempfile.TemporaryDirectory() as td:
    TX = os.path.join(td, "tx", "sess.jsonl")
    QD = os.path.join(td, "q")
    SESS = os.path.join(td, "sessions")
    os.makedirs(SESS)
    n = [0]

    def env(fresh_ledger=False):
        """fresh_ledger=True gives a brand-new non-repeat ledger, so the draw is
        the deterministic FIRST pick: the only thing that can make it differ is
        the live-name / peer-title exclusion under test."""
        if fresh_ledger:
            n[0] += 1
            led = os.path.join(td, f"led-{n[0]}.json")
        else:
            led = os.path.join(td, "led.json")
        return {"NAMED_SUBAGENTS_QUEUE_DIR": QD, "NAMED_SUBAGENTS_LEDGER": led,
                "NAMED_SUBAGENTS_SESSIONS_DIR": SESS}

    def live(session="s1"):
        return cli._name_live(session, QD)

    section("PreToolUse — sets `name` and the label")
    rc, out = run(pre(), env())
    nm1 = name_of(out)
    ui = ((out or {}).get("hookSpecificOutput") or {}).get("updatedInput") or {}
    check("exit 0", rc == 0)
    check("sets a bare pool name", isinstance(nm1, str) and nm1.isalpha(), str(out))
    check("label is '<emoji> Name · task'",
          (ui.get("description") or "").endswith(f"{nm1} · probe task")
          and not (ui.get("description") or "").startswith(nm1), ui.get("description"))
    check("prompt untouched (identity arrives via SubagentStart)", ui.get("prompt") == "Do the probe.")
    check("subagent_type untouched (no retype)", ui.get("subagent_type") == "general-purpose")
    check("the picked name is pending-live", nm1 in live(), str(live()))

    section("PreToolUse — unique among live agents")
    rc, out_a = run(pre(session="u1"), env(fresh_ledger=True))
    rc, out_b = run(pre(session="u1"), env(fresh_ledger=True))
    check("a colliding first pick is skipped while the first is live",
          name_of(out_a) and name_of(out_b) and name_of(out_a) != name_of(out_b),
          f"{name_of(out_a)} vs {name_of(out_b)}")
    rc, out_c = run(pre(session="u2"), env(fresh_ledger=True))
    check("another session's live names don't constrain this one",
          name_of(out_c) == name_of(out_a), f"{name_of(out_c)} vs {name_of(out_a)}")

    section("PreToolUse — peer-session titles are skipped")
    first = name_of(run(pre(session="p0"), env(fresh_ledger=True))[1])
    with open(os.path.join(SESS, "123.json"), "w", encoding="utf-8") as fh:
        json.dump({"pid": 123, "name": first.lower()}, fh)
    got = name_of(run(pre(session="p1"), env(fresh_ledger=True))[1])
    check("a name equal to a peer-session title (any case) is not picked",
          got and got != first, f"{got} vs {first}")
    os.unlink(os.path.join(SESS, "123.json"))
    with open(os.path.join(SESS, "bad.json"), "w", encoding="utf-8") as fh:
        fh.write("{not json")
    rc, out = run(pre(session="p2"), env(fresh_ledger=True))
    check("an unreadable session file is ignored", rc == 0 and name_of(out), str(out))
    os.unlink(os.path.join(SESS, "bad.json"))

    section("PreToolUse — installed agent names are skipped")
    first = name_of(run(pre(session="ia0"), env(fresh_ledger=True))[1])
    home = os.path.join(td, "home-ia")
    os.makedirs(os.path.join(home, ".claude", "agents"))
    with open(os.path.join(home, ".claude", "agents", "x.md"), "w", encoding="utf-8") as fh:
        fh.write(f"---\nname: {first}\ndescription: d\n---\nbody\n")
    e = env(fresh_ledger=True)
    e["HOME"] = home
    got = name_of(run(pre(session="ia1"), e)[1])
    check("a name equal to an installed agent type is not picked", got and got != first,
          f"{got} vs {first}")

    section("PreToolUse — pass-through")
    rc, out = run(pre(session="m1", name="Zed"), env())
    check("model-supplied name is left alone (no output)", rc == 0 and out is None, str(out))
    check("model-supplied name counts as live", "Zed" in live("m1"), str(live("m1")))
    rc, out = run(pre(session="m1", prompt=f"You are **X** ... {SIG}\nDo it."), env())
    check("CLI-assigned (persona in prompt) dispatch is left alone", rc == 0 and out is None)
    rc, out = run(pre(session="m1", tool="Task"), env())
    check("Task alias is named too", name_of(out), str(out))
    rc, out = run({"hook_event_name": "PreToolUse", "tool_name": "Bash", "session_id": "m1",
                   "tool_input": {"command": "ls"}}, env())
    check("non-dispatch tool passes through", rc == 0 and out is None)
    for label, ev in (("garbage stdin", "not json"), ("list", "[]"),
                      ("no tool_input", {"hook_event_name": "PreToolUse", "tool_name": "Agent"})):
        rc, out = run(ev, env())
        check(f"fail-open on {label}", rc == 0 and out is None, str(out))
    e = env()
    e["NAMED_SUBAGENTS_HOOK_DISABLE"] = "1"
    rc, out = run(pre(session="m2"), e)
    check("kill switch", rc == 0 and out is None)

    section("SubagentStart — binds and injects identity")
    rc, o = run(pre(session="b1", description="alpha"), env())
    na = name_of(o)
    rc, o = run(pre(session="b1", description="beta"), env())
    nb = name_of(o)
    rc, out = run(start("a1", session="b1"), env())
    ac = ((out or {}).get("hookSpecificOutput") or {}).get("additionalContext") or ""
    check("first Start gets the first dispatch's identity",
          f"`[{na}]`" in ac and SIG in ac, ac[:120])
    check("event name is SubagentStart",
          ((out or {}).get("hookSpecificOutput") or {}).get("hookEventName") == "SubagentStart")
    rc, out = run(start("a2", session="b1"), env())
    ac = ((out or {}).get("hookSpecificOutput") or {}).get("additionalContext") or ""
    check("second Start gets the second identity", f"`[{nb}]`" in ac, ac[:120])
    check("both names live after Start", {na, nb} <= live("b1"), str(live("b1")))

    rc, o = run(pre(session="r1", subagent_type="Explore", description="scan"), env())
    n_ex = name_of(o)
    rc, o = run(pre(session="r1", subagent_type=None, description="gp"), env())
    n_gp = name_of(o)
    rc, out = run(start("g1", session="r1", agent_type="general-purpose"), env())
    ac = ((out or {}).get("hookSpecificOutput") or {}).get("additionalContext") or ""
    check("Start pairs by role (skips an older Explore entry)", f"`[{n_gp}]`" in ac, ac[:120])
    check("an omitted subagent_type pairs as general-purpose", f"`[{n_gp}]`" in ac)
    rc, out = run(start("e1", session="r1", agent_type="Explore"), env())
    ac = ((out or {}).get("hookSpecificOutput") or {}).get("additionalContext") or ""
    check("Explore Start gets the Explore name", f"`[{n_ex}]`" in ac, ac[:120])

    run(pre(session="m3", name="Zed"), env())
    rc, out = run(start("z1", session="m3"), env())
    check("model-named agent: Start injects nothing", rc == 0 and out is None, str(out))
    check("model-named agent is bound live", "Zed" in live("m3"))
    rc, out = run(start("x9", session="empty"), env())
    check("Start with no queued dispatch: no output", rc == 0 and out is None, str(out))

    section("SubagentStop — release by agent_id")
    rc, out = run(stop("a1", session="b1"), env(), extra=())
    check("Stop exits 0", rc == 0)
    check("Stop frees exactly that agent's name", na not in live("b1") and nb in live("b1"),
          str(live("b1")))
    rc, out = run(stop("nobody", session="b1"), env())
    check("Stop of an unknown agent: silent no-op", rc == 0 and out is None)
    rc, out = run(stop("a2", session="b1"), env(), flag="--release")
    check("legacy --release flag routes to name-mode release", nb not in live("b1"), str(live("b1")))

    section("resume — Start/Stop without PreToolUse")
    s = "rs"
    first = name_of(run(pre(session=s), env(fresh_ledger=True))[1])
    run(start("A", session=s), env())
    run(stop("A", session=s), env())
    check("released after the first Stop", first not in live(s))
    rc, out = run(start("A", session=s), env())
    check("resume Start injects nothing", rc == 0 and out is None, str(out))
    check("resume Start makes the name live again", first in live(s), str(live(s)))
    got = name_of(run(pre(session=s), env(fresh_ledger=True))[1])
    check("a new dispatch avoids the resumed agent's name", got and got != first, got)
    run(start("B", session=s), env())
    run(stop("A", session=s), env())
    check("resume Stop frees only the resumed agent", first not in live(s) and got in live(s),
          str(live(s)))
    run(stop("A", session=s), env())
    check("a duplicate Stop cannot free another agent's name", got in live(s), str(live(s)))

    rs2 = "rs2"
    q_name = name_of(run(pre(session=rs2, description="sib"), env())[1])
    run(start("K", session=rs2), env())            # binds q_name to K
    q2 = name_of(run(pre(session=rs2, description="sib2"), env())[1])
    run(stop("K", session=rs2), env())
    rc, out = run(start("K", session=rs2), env())  # resume of K while q2 is queued
    check("resume Start does not steal a queued sibling's entry", out is None, str(out))
    rc, out = run(start("L", session=rs2), env())
    ac = ((out or {}).get("hookSpecificOutput") or {}).get("additionalContext") or ""
    check("the sibling still gets its own name", f"`[{q2}]`" in ac, ac[:120])

    section("fail loud — meta.json check at SubagentStop, shown at the main Stop")
    # CC 2.1.283 renders a systemMessage from PreToolUse/PostToolUse/Stop but
    # drops one from SubagentStart/SubagentStop, so SubagentStop only RECORDS the
    # alert and the main agent's Stop hook shows it to the owner.
    md = os.path.join(td, "meta")
    s = "fl"

    def main_stop(session=s):
        return run({"hook_event_name": "Stop", "session_id": session}, env())

    good = name_of(run(pre(session=s), env())[1])
    run(start("m1", session=s), env())
    rc, out = run(stop("m1", session=s, meta={"agentType": "general-purpose", "name": good}, td=md), env())
    check("SubagentStop never emits output (it would be dropped, or could block)",
          rc == 0 and out is None, str(out))
    rc, out = main_stop()
    check("matching meta name: main Stop stays quiet", rc == 0 and out is None, str(out))

    dropped = name_of(run(pre(session=s), env())[1])
    run(start("m2", session=s), env())
    rc, out = run(stop("m2", session=s, meta={"agentType": "general-purpose"}, td=md), env())
    check("SubagentStop records instead of emitting", out is None, str(out))
    rc, out = main_stop()
    msg = (out or {}).get("systemMessage") or ""
    check("meta without name -> main Stop systemMessage naming the agent",
          dropped in msg and "name" in msg, str(out))
    check("the alarm never blocks the stop", "decision" not in (out or {}))
    rc, out = main_stop()
    check("an alert is shown once per broken dispatch (then cleared)", out is None, str(out))

    wrong = name_of(run(pre(session=s), env())[1])
    run(start("m3", session=s), env())
    run(stop("m3", session=s, meta={"name": "Somebody"}, td=md), env())
    lost = name_of(run(pre(session=s), env())[1])
    run(start("m4", session=s), env())
    run(stop("m4", session=s, td=md), env())
    rc, out = main_stop()
    msg = (out or {}).get("systemMessage") or ""
    check("a different meta name is reported with both names", wrong in msg and "Somebody" in msg, msg)
    check("a missing meta.json is reported (the detector says it is blind)",
          lost in msg and "meta.json" in msg, msg)
    rc, out = main_stop(session="other")
    check("another session's Stop does not show this session's alerts", out is None, str(out))

    run(pre(session=s, name="Zed"), env())
    run(start("m5", session=s), env())
    run(stop("m5", session=s, meta={"name": "Zed"}, td=md), env())
    rc, out = main_stop()
    check("model-named agent with matching meta: no alert", out is None, str(out))

    section("hardening — a failed pick still queues a placeholder")
    s = "hf"
    bad = env()
    bad["NAMED_SUBAGENTS_LEDGER"] = os.path.join(td, "ledger-is-a-dir")
    os.makedirs(bad["NAMED_SUBAGENTS_LEDGER"])
    rc, out = run(pre(session=s, description="first"), bad)
    check("a failing pick fails open (exit 0, dispatch unchanged)", rc == 0 and out is None, str(out))
    nb2 = name_of(run(pre(session=s, description="second"), env())[1])
    rc, out = run(start("hf1", session=s), env())
    check("the failed dispatch's Start pairs with its placeholder (no identity)",
          out is None, str(out))
    rc, out = run(start("hf2", session=s), env())
    ac = ((out or {}).get("hookSpecificOutput") or {}).get("additionalContext") or ""
    check("the next sibling still gets its own identity", f"`[{nb2}]`" in ac, ac[:120])

    section("hardening — a Start whose meta.json exists is a resume")
    s = "hr"
    q1 = name_of(run(pre(session=s, description="sib"), env())[1])
    write_meta("hrK", {"name": "Somebody", "toolUseId": "toolu_old"})
    rc, out = run(start("hrK", session=s), env())
    check("resume of an agent with no binding does not steal a sibling's entry",
          out is None and q1 in live(s), str(out))
    check("the resumed agent's recorded name counts as live", "Somebody" in live(s), str(live(s)))
    rc, out = run(start("hrL", session=s), env())
    ac = ((out or {}).get("hookSpecificOutput") or {}).get("additionalContext") or ""
    check("the sibling still gets its own name", f"`[{q1}]`" in ac, ac[:120])

    section("hardening — Stop repairs a swapped pairing via toolUseId")
    s = "sw"
    na_ = name_of(run(pre(session=s, description="a", tool_use_id="tA"), env())[1])
    nb_ = name_of(run(pre(session=s, description="b", tool_use_id="tB"), env())[1])
    run(start("sw1", session=s), env())             # FIFO binds sw1 -> A
    run(start("sw2", session=s), env())             # and sw2 -> B, but really swapped:
    write_meta("sw1", {"name": nb_, "toolUseId": "tB"})
    run({**stop("sw1", session=s), "transcript_path": TX}, env())
    check("after the swapped agent stops, its TRUE name is free and the other stays live",
          live(s) == {na_}, f"live={live(s)} a={na_} b={nb_}")
    write_meta("sw2", {"name": na_, "toolUseId": "tA"})
    run({**stop("sw2", session=s), "transcript_path": TX}, env())
    check("the partner's Stop then releases the other name", live(s) == set(), str(live(s)))
    rc, out = run({"hook_event_name": "Stop", "session_id": s}, env())
    msg = (out or {}).get("systemMessage") or ""
    check("the mix-up is reported once, naming both", "mix-up" in msg and na_ in msg and nb_ in msg
          and msg.count("mix-up") == 1, msg)

    section("hardening — Stop drops a denied dispatch's stale entry")
    s = "dn"
    nden = name_of(run(pre(session=s, description="denied", tool_use_id="tD"), env())[1])
    nok = name_of(run(pre(session=s, description="ok", tool_use_id="tO"), env())[1])
    run(start("dn1", session=s), env())             # pops the DENIED entry by FIFO
    write_meta("dn1", {"name": nok, "toolUseId": "tO"})
    run({**stop("dn1", session=s), "transcript_path": TX}, env())
    check("the denied name and the agent's true name are both free", live(s) == set(),
          f"live={live(s)} denied={nden} ok={nok}")
    rc, out = run(start("dn2", session=s), env())
    check("the agent's own queue entry was removed (it cannot mispair a later Start)",
          out is None, str(out))
    run(start("dn1", session=s), env())             # SendMessage resume of the repaired agent
    check("a resume after the repair holds the agent's TRUE name, not the denied one",
          live(s) == {nok}, f"live={live(s)} denied={nden} ok={nok}")

    section("hardening — the repair holds for an agent that ran past the queue TTL")
    s = "dnl"
    nden = name_of(run(pre(session=s, description="denied", tool_use_id="tDL"), env())[1])
    nok = name_of(run(pre(session=s, description="ok", tool_use_id="tOL"), env())[1])
    run(start("dnl1", session=s), env())            # pops the DENIED entry by FIFO
    qp = cli._queue_path(s, QD)                     # the agent runs 40s: its entry expires
    with open(qp, encoding="utf-8") as fh:
        aged = [dict(json.loads(ln), ts=json.loads(ln)["ts"] - 40) for ln in fh if ln.strip()]
    with open(qp, "w", encoding="utf-8") as fh:
        fh.writelines(json.dumps(e) + "\n" for e in aged)
    write_meta("dnl1", {"name": nok, "toolUseId": "tOL"})
    run({**stop("dnl1", session=s), "transcript_path": TX}, env())
    run(start("dnl1", session=s), env())            # SendMessage resume
    check("a resume after a >30s run holds the TRUE name (from meta.json)",
          live(s) == {nok}, f"live={live(s)} denied={nden} ok={nok}")

    section("hardening — a model-supplied name that duplicates a live one is reported")
    s = "dup"
    held = name_of(run(pre(session=s), env())[1])
    run(start("du1", session=s), env())
    rc, out = run(pre(session=s, name=held), env())
    check("the model's name is still left alone", out is None, str(out))
    rc, out = run({"hook_event_name": "Stop", "session_id": s}, env())
    msg = (out or {}).get("systemMessage") or ""
    check("the duplicate is reported at the main Stop", held in msg and "already" in msg, msg)

    section("fail loud — break it on purpose (NAMED_SUBAGENTS_FAULT_DROP_NAME)")
    e = env()
    e["NAMED_SUBAGENTS_FAULT_DROP_NAME"] = "1"
    rc, out = run(pre(session="fx"), e)
    ui = ((out or {}).get("hookSpecificOutput") or {}).get("updatedInput") or {}
    check("fault injection drops `name` but keeps the label",
          "name" not in ui and " · probe task" in (ui.get("description") or ""), str(ui))

    section("session locks stay fresh while in use")
    if PORT != "js":                          # the JS port's lock is create/delete per use
        lp = cli._queue_path("lk", QD) + ".lock"
        with open(lp, "w"):
            pass
        os.utime(lp, (1, 1))
        with cli._queue_lock(cli._queue_path("lk", QD)):
            fresh = os.path.getmtime(lp) > 1000
        check("acquiring a lock refreshes its mtime (so GC never deletes a live lock)", fresh)

    section("state stays bounded")
    ages = os.path.join(QD, "b-old.json")
    with open(ages, "w", encoding="utf-8") as fh:
        json.dump({"agents": {}}, fh)
    os.utime(ages, (1, 1))
    run(pre(session="gc"), env())
    check("stale per-session binding files are garbage-collected", not os.path.exists(ages))

    section("plugin hooks.json — name mode only")
    hj = json.load(open(os.path.join(ROOT, "hooks", "hooks.json"), encoding="utf-8"))["hooks"]
    cmds = {ev: [h["command"] for b in blocks for h in b["hooks"]] for ev, blocks in hj.items()}
    check("no SessionStart roster ensure", "SessionStart" not in cmds, str(list(cmds)))
    for ev in ("PreToolUse", "SubagentStart", "SubagentStop", "Stop"):
        check(f"{ev} runs `hook run --name --plugin`",
              any("hook run --name --plugin" in c for c in cmds.get(ev, [])), str(cmds.get(ev)))
    check("no --retype anywhere", not any("--retype" in c for cs in cmds.values() for c in cs))

print("\nRESULT:", "ALL PASS" if not failures else f"{len(failures)} FAIL: {failures}")
sys.exit(1 if failures else 0)
