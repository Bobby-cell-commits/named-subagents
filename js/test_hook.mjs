/**
 * Tests for the auto-namer hook (JS port): `hook run` + `hook install|uninstall|status`.
 * Mirrors test_hook.py. Run:  node js/test_hook.mjs   (exits non-zero on any FAIL).
 *
 * Load-bearing property: FAIL-OPEN — `hook run` must NEVER exit non-zero and NEVER
 * crash on bad input; a broken hook would break every subagent dispatch.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { personaPreamble } from "./named_subagents.mjs";

const JS_DIR = dirname(fileURLToPath(import.meta.url));
const CLI = join(JS_DIR, "cli.mjs");
const SIG = "parallel agents in this run.";
const MARKER = "named-subagents-autonamer";

const failures = [];
function check(name, cond, detail = "") {
  console.log(`  [${cond ? "PASS" : "FAIL"}] ${name}` + (detail && !cond ? `  -- ${detail}` : ""));
  if (!cond) failures.push(name);
}
function section(t) { console.log(`\n== ${t} ==`); }

// A process-lifetime temp ledger so NO test writes the real default ledger
// (~/.local/state/named-subagents/hook-ledger.json). Explicit envExtra overrides it.
const SAFE_LEDGER = join(mkdtempSync(join(tmpdir(), "ns-hook-safe-")), "safe-led.json");

function runHook(stdin, args, envExtra = null) {
  const env = { ...process.env };
  delete env.NAMED_SUBAGENTS_CONFIG;
  delete env.NAMED_SUBAGENTS_HOOK_DISABLE;
  env.NAMED_SUBAGENTS_LEDGER = SAFE_LEDGER;
  if (envExtra) Object.assign(env, envExtra);   // explicit ledger/override wins
  return spawnSync(process.execPath, [CLI, "hook", ...args],
    { input: stdin, encoding: "utf8", env, timeout: 90000 });
}
function payload(toolName = "Agent", toolInput = {}) {
  return JSON.stringify({ tool_name: toolName, tool_input: toolInput });
}
function updatedInput(r) {
  if (!r.stdout || !r.stdout.trim()) return null;
  try { return JSON.parse(r.stdout).hookSpecificOutput.updatedInput; } catch { return null; }
}
function mkTmp() { return mkdtempSync(join(tmpdir(), "ns-hook-")); }

// --------------------------------------------------------------------------- //
section("idempotency signature coupled to personaPreamble (L3)");
check("SIG substring present in personaPreamble() output",
  personaPreamble("Testcallsign", "Explorers & navigators").includes(SIG));

// --------------------------------------------------------------------------- //
section("hook run — mutation on Agent");
{
  const d = mkTmp();
  const env = { NAMED_SUBAGENTS_LEDGER: join(d, "led.json") };
  const r = runHook(payload("Agent", {
    description: "map the auth module", prompt: "Do the thing.", subagent_type: "general-purpose",
  }), ["run"], env);
  check("exits 0 on Agent dispatch", r.status === 0, (r.stderr || "").slice(0, 300));
  const ui = updatedInput(r);
  check("emits updatedInput", ui !== null, (r.stdout || "").slice(0, 200));
  if (ui) {
    check("description keeps original text", (ui.description || "").endsWith("map the auth module"));
    check("description is prefixed (nickname added)", ui.description !== "map the auth module");
    check("prompt gets the persona preamble", (ui.prompt || "").includes(SIG));
    check("original prompt retained after preamble", (ui.prompt || "").endsWith("Do the thing."));
    check("subagent_type preserved", ui.subagent_type === "general-purpose");
  }
  let out = {};
  try { out = JSON.parse(r.stdout); } catch { /* */ }
  check("hookEventName == PreToolUse", (out.hookSpecificOutput || {}).hookEventName === "PreToolUse");
  check("does NOT force permissionDecision", !("permissionDecision" in (out.hookSpecificOutput || {})));
  rmSync(d, { recursive: true, force: true });
}

section("hook run — Task alias");
{
  const d = mkTmp();
  const r = runHook(payload("Task", { description: "x", prompt: "y", subagent_type: "general-purpose" }),
    ["run"], { NAMED_SUBAGENTS_LEDGER: join(d, "led.json") });
  check("mutates the Task alias too", updatedInput(r) !== null, (r.stdout || "").slice(0, 200));
  rmSync(d, { recursive: true, force: true });
}

section("hook run — passthrough on non-dispatch tools");
{
  const r = runHook(payload("Bash", { command: "ls -la" }), ["run"]);
  check("Bash tool -> exit 0", r.status === 0);
  check("Bash tool -> no mutation emitted", updatedInput(r) === null, (r.stdout || "").slice(0, 200));
}

section("hook run — FAIL-OPEN (never break a dispatch)");
const FAILOPEN = [
  ["garbage stdin", "not json {{{"],
  ["empty stdin", ""],
  ["whitespace stdin", "   \n  "],
  ["json array not object", "[1,2,3]"],
  ["json null", "null"],
  ["missing tool_input", JSON.stringify({ tool_name: "Agent" })],
  ["tool_input is a string", JSON.stringify({ tool_name: "Agent", tool_input: "nope" })],
  ["tool_input is null", JSON.stringify({ tool_name: "Agent", tool_input: null })],
  ["missing tool_name", JSON.stringify({ tool_input: { prompt: "x" } })],
  ["Agent with empty tool_input", JSON.stringify({ tool_name: "Agent", tool_input: {} })],
  ["prompt is not a string", JSON.stringify({ tool_name: "Agent", tool_input: { prompt: 5 } })],
];
for (const [label, stdin] of FAILOPEN) {
  const r = runHook(stdin, ["run"]);
  check(`fail-open [${label}] exits 0`, r.status === 0, `status=${r.status} err=${(r.stderr || "").slice(0, 160)}`);
  check(`fail-open [${label}] never exits 2 (would block)`, r.status !== 2);
}
{
  const d = mkTmp();
  const blocker = join(d, "iam-a-file");        // a regular file as the ledger's parent dir
  writeFileSync(blocker, "x");                  // -> mkdir(<file>/...) fails ENOTDIR, fast + caught
  const r = runHook(payload("Agent", { description: "x", prompt: "t", subagent_type: "Explore" }),
    ["run"], { NAMED_SUBAGENTS_LEDGER: join(blocker, "led.json") });
  check("fail-open on unwritable ledger dir -> exit 0", r.status === 0, (r.stderr || "").slice(0, 200));
  rmSync(d, { recursive: true, force: true });
}
// M1: unexpected argv on `hook run` must still exit 0 (never block). The TRAILING
// VALUELESS flag (`--managed-by` with no value) is the decisive case — a strict
// parser (argparse / this port's parseArgs) exit-2s when the value is missing.
{
  const d = mkTmp();
  const env = { NAMED_SUBAGENTS_LEDGER: join(d, "l.json") };
  for (const extra of [["--some-future-flag", "extra-token"], ["--managed-by"], ["--future-flag"]]) {
    const r = runHook(payload("Agent", { description: "map x", prompt: "t", subagent_type: "Explore" }),
      ["run", ...extra], env);
    check(`fail-open: hook run ${extra.join(" ")} exits 0 (never 2 = block)`, r.status === 0,
      `status=${r.status} err=${(r.stderr || "").slice(0, 160)}`);
    check(`fail-open: hook run ${extra.join(" ")} still yields a mutation`, updatedInput(r) !== null);
  }
  rmSync(d, { recursive: true, force: true });
}

section("hook run — kill switch");
{
  const r = runHook(payload("Agent", { description: "x", prompt: "t", subagent_type: "Explore" }),
    ["run"], { NAMED_SUBAGENTS_HOOK_DISABLE: "1" });
  check("NAMED_SUBAGENTS_HOOK_DISABLE -> passthrough", r.status === 0 && updatedInput(r) === null);
}

section("hook run — idempotency (no double-preamble)");
{
  const d = mkTmp();
  const env = { NAMED_SUBAGENTS_LEDGER: join(d, "led.json") };
  const r1 = runHook(payload("Agent", { description: "map auth", prompt: "task body", subagent_type: "general-purpose" }), ["run"], env);
  const ui1 = updatedInput(r1);
  check("first pass mutates", ui1 !== null);
  if (ui1) {
    const r2 = runHook(payload("Agent", {
      description: ui1.description, prompt: ui1.prompt, subagent_type: ui1.subagent_type,
    }), ["run"], env);
    check("re-run on already-named payload -> passthrough", updatedInput(r2) === null);
  }
  rmSync(d, { recursive: true, force: true });
}

section("hook run — no double-prefix on empty-prompt re-fire (L2)");
{
  const d = mkTmp();
  const env = { NAMED_SUBAGENTS_LEDGER: join(d, "led.json") };
  const r1 = runHook(payload("Agent", { description: "map billing", prompt: "", subagent_type: "code" }), ["run"], env);
  const ui1 = updatedInput(r1);
  check("empty-prompt dispatch still gets a description prefix",
    ui1 && ui1.description !== "map billing", JSON.stringify(ui1));
  if (ui1) {
    const r2 = runHook(payload("Agent", { description: ui1.description, prompt: "", subagent_type: "code" }), ["run"], env);
    check("emoji-prefixed description -> passthrough (no double-prefix)", updatedInput(r2) === null);
  }
  // LOW-1: a NORMAL (prompted) dispatch whose description starts with a category
  // emoji must STILL be named — the emoji probe is empty-prompt-only.
  const r3 = runHook(payload("Agent", { description: "📊 quarterly revenue chart", prompt: "Build the chart.", subagent_type: "data" }), ["run"], env);
  const ui3 = updatedInput(r3);
  check("emoji-led description WITH a prompt is still named (no false idempotency)",
    ui3 && (ui3.prompt || "").includes(SIG), JSON.stringify(ui3));
  rmSync(d, { recursive: true, force: true });
}

section("hook run — distinct, non-repeating names");
{
  const d = mkTmp();
  const env = { NAMED_SUBAGENTS_LEDGER: join(d, "led.json") };
  const descs = [];
  for (let i = 0; i < 5; i++) {
    const r = runHook(payload("Agent", { description: `map module ${i}`, prompt: "t", subagent_type: "Explore" }), ["run"], env);
    const ui = updatedInput(r);
    if (ui) descs.push(ui.description);
  }
  check("5 sequential dispatches -> 5 distinct descriptions", new Set(descs).size === 5, JSON.stringify(descs));
  rmSync(d, { recursive: true, force: true });
}

section("hook run — concurrency (flock: no duplicate names)");
{
  const d = mkTmp();
  const env = { NAMED_SUBAGENTS_LEDGER: join(d, "led.json") };
  // Launch 8 hook processes concurrently (async spawn), then collect.
  const { spawn } = await import("node:child_process");
  const procs = [];
  for (let i = 0; i < 8; i++) {
    procs.push(new Promise((resolve) => {
      const p = spawn(process.execPath, [CLI, "hook", "run"], { env: { ...process.env, ...env } });
      let out = "";
      p.stdout.on("data", (c) => (out += c));
      p.on("close", () => {
        try { resolve(JSON.parse(out).hookSpecificOutput.updatedInput.description); }
        catch { resolve(null); }
      });
      p.stdin.write(payload("Agent", { description: `m${i}`, prompt: "t", subagent_type: "Explore" }));
      p.stdin.end();
    }));
  }
  const got = (await Promise.all(procs)).filter(Boolean);
  check("8 concurrent dispatches -> 8 results", got.length === 8, String(got.length));
  check("8 concurrent dispatches -> 8 DISTINCT names (flock held)", new Set(got).size === 8, JSON.stringify(got.sort()));
  rmSync(d, { recursive: true, force: true });
}

// --------------------------------------------------------------------------- //
section("hook install / status / uninstall");
{
  const d = mkTmp();
  const sp = join(d, "settings.json");
  let r = runHook("", ["install", "--settings", sp]);
  check("install into absent settings -> exit 0", r.status === 0, (r.stderr || "").slice(0, 300));
  check("install created the settings file", existsSync(sp));
  let data = JSON.parse(readFileSync(sp, "utf8"));
  let pre = (data.hooks || {}).PreToolUse || [];
  let ours = pre.filter((m) => (m.hooks || []).some((h) => (h.command || "").includes(MARKER)));
  check("install registered exactly one auto-namer hook", ours.length === 1, JSON.stringify(pre).slice(0, 300));
  if (ours.length) check("matcher targets Agent|Task", ours[0].matcher.includes("Agent") && ours[0].matcher.includes("Task"));

  r = runHook("", ["status", "--settings", sp]);
  check("status exit 0 + reports installed", r.status === 0 && r.stdout.toLowerCase().includes("install"), (r.stdout || "").slice(0, 200));

  r = runHook("", ["install", "--settings", sp]);           // idempotent re-install
  data = JSON.parse(readFileSync(sp, "utf8"));
  ours = data.hooks.PreToolUse.filter((m) => (m.hooks || []).some((h) => (h.command || "").includes(MARKER)));
  check("re-install is idempotent (still exactly one)", ours.length === 1);
  check("re-install of an existing file wrote a .bak", existsSync(sp + ".bak"));

  r = runHook("", ["uninstall", "--settings", sp]);
  data = JSON.parse(readFileSync(sp, "utf8"));
  ours = ((data.hooks || {}).PreToolUse || []).filter((m) => (m.hooks || []).some((h) => (h.command || "").includes(MARKER)));
  check("uninstall removed our hook", ours.length === 0);
  rmSync(d, { recursive: true, force: true });
}

section("hook install — merge safety");
{
  const d = mkTmp();
  const sp = join(d, "settings.json");
  writeFileSync(sp, JSON.stringify({
    hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo hi" }] }] },
    permissions: { allow: ["Bash"] },
  }));
  let r = runHook("", ["install", "--settings", sp]);
  check("install into populated settings -> exit 0", r.status === 0, (r.stderr || "").slice(0, 300));
  let data = JSON.parse(readFileSync(sp, "utf8"));
  check("preserves the pre-existing Bash hook", data.hooks.PreToolUse.some((m) => m.matcher === "Bash"));
  check("preserves unrelated top-level keys", JSON.stringify(data.permissions) === JSON.stringify({ allow: ["Bash"] }));
  runHook("", ["uninstall", "--settings", sp]);
  data = JSON.parse(readFileSync(sp, "utf8"));
  check("uninstall leaves the unrelated Bash hook intact", data.hooks.PreToolUse.some((m) => m.matcher === "Bash"));
  rmSync(d, { recursive: true, force: true });
}

section("hook install — refuses to clobber malformed settings");
{
  const d = mkTmp();
  const sp = join(d, "settings.json");
  writeFileSync(sp, "{ this is not valid json ");
  const r = runHook("", ["install", "--settings", sp]);
  check("install on malformed JSON -> non-zero exit", r.status !== 0, (r.stdout || "").slice(0, 200));
  check("install did NOT modify the malformed file", readFileSync(sp, "utf8") === "{ this is not valid json ");
  rmSync(d, { recursive: true, force: true });
}

// --------------------------------------------------------------------------- //
function runCli(args, envExtra = null) {
  const env = { ...process.env };
  delete env.NAMED_SUBAGENTS_CONFIG;
  env.NAMED_SUBAGENTS_LEDGER = SAFE_LEDGER;
  if (envExtra) Object.assign(env, envExtra);
  return spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env, timeout: 90000 });
}

section("doctor knows the auto-namer (item 1)");
{
  const r = runCli(["doctor"]);
  check("doctor exits 0 when clean", r.status === 0, (r.stderr || "").slice(0, 200));
  check("doctor reports [PASS] hook-selftest", (r.stdout || "").includes("[PASS] hook-selftest"),
    (r.stdout || "").slice(-400));
  check("doctor reports hook-install status", (r.stdout || "").includes("hook-install"));
  // review fix: the kill switch is a legitimate, documented state — never a FAIL / non-zero exit
  const rk = runCli(["doctor"], { NAMED_SUBAGENTS_HOOK_DISABLE: "1" });
  check("doctor with kill-switch set -> exit 0 (not a FAIL)", rk.status === 0, (rk.stderr || "").slice(0, 200));
  check("doctor kill-switch -> hook-selftest is not a FAIL",
    !(rk.stdout || "").includes("[FAIL] hook-selftest"), (rk.stdout || "").slice(-300));
}

section("init scaffolds a valid, usable config (item 10)");
{
  const d = mkTmp();
  const cfg = join(d, "config.json");
  let r = runCli(["init", "--path", cfg]);
  check("init exits 0 + writes the file", r.status === 0 && existsSync(cfg), (r.stderr || "").slice(0, 200));
  let ok = false;
  try { ok = typeof JSON.parse(readFileSync(cfg, "utf8")) === "object"; } catch { ok = false; }
  check("init writes valid JSON", ok);
  r = runCli(["allocate", "--category", "starships", "--count", "2", "--config", cfg]);
  check("scaffolded config is usable (allocate from the custom category)",
    r.status === 0 && r.stdout.trim().split(/\s+/).length === 2, (r.stderr || "").slice(0, 200));
  r = runCli(["init", "--path", cfg]);
  check("init refuses overwrite without --force", r.status !== 0);
  r = runCli(["init", "--path", cfg, "--force"]);
  check("init --force overwrites", r.status === 0, (r.stderr || "").slice(0, 200));
  rmSync(d, { recursive: true, force: true });
}

section("assign --format table (item 10)");
{
  const r = runCli(["assign", "--role", "Explore", "--task", "map the router", "--count", "3", "--format", "table"]);
  check("assign --format table exits 0", r.status === 0, (r.stderr || "").slice(0, 200));
  check("table has the header + a themed nickname row",
    (r.stdout || "").includes("subagent_type") && (r.stdout || "").includes("Explore"),
    (r.stdout || "").slice(0, 200));
}

// --------------------------------------------------------------------------- //
if (failures.length) {
  console.log(`\nRESULT: ${failures.length} FAILED -> ${JSON.stringify(failures)}`);
  process.exit(1);
}
console.log("\nRESULT: ALL PASS");
