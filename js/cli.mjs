#!/usr/bin/env node
/**
 * named-subagents CLI (JS) — allocate themed, non-repeating subagent nicknames.
 * Byte-identical output to the Python reference CLI for identical inputs.
 *
 *   named-subagents categories
 *   named-subagents resolve --role Explore
 *   named-subagents allocate --category reflect --count 3
 *   named-subagents assign --role Explore --task "map the router" --count 4 --ledger .ledger.json
 *   named-subagents assign --task "audit auth" --format workflow --pin security=Argus
 *   named-subagents release --category explore --name Magellan --ledger .ledger.json
 *   named-subagents stats --ledger .ledger.json
 *   named-subagents doctor --ledger .ledger.json --json
 *   named-subagents bio Magellan
 */
import {
  closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync,
  renameSync, rmSync, statSync, unlinkSync, writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  Ledger, LEDGER_VERSION, PoolExhaustedError, Registry, VERSION,
  allocate, installedAgentNames, ledgerRecordIssue, ledgerStats, loadWithConfig,
  personaPreamble, planFanout, pyDumps, formatPyFloat, resolveCategory, stripGen,
  validName, toLabels, toSwarm, toTable, toWorkflow, _hasOwn as hasOwn,
} from "./named_subagents.mjs";

const JS_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(JS_DIR);

const STATS_FLOAT_KEYS = new Set(["pct_used"]);

// --------------------------------------------------------------------------- //
// argv parsing (mirrors the Python argparse surface)
// --------------------------------------------------------------------------- //
const BOOL_FLAGS = new Set(["json", "avoid-installed", "bio-in-prompt", "version", "cwd-config", "no-cwd-config", "explain", "cwd", "force"]);
const COMMANDS = new Set([
  "categories", "resolve", "allocate", "assign",
  "release", "retire", "unretire", "stats", "doctor", "bio", "init", "hook",
]);
const USAGE =
  "usage: named-subagents [--registry PATH] [--config PATH] "
  + "[--cwd-config|--no-cwd-config] [--version] "
  + "<categories|resolve|allocate|assign|release|retire|unretire|stats|doctor|bio> ...";

function parseArgs(argv) {
  let cmd = null;
  const opts = { pin: [], _pos: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      // Support both `--key value` and `--key=value` (argparse accepts both).
      let key = a.slice(2);
      let inlineVal = null;
      const eq = key.indexOf("=");
      if (eq !== -1) {
        inlineVal = key.slice(eq + 1);
        key = key.slice(0, eq);
      }
      if (BOOL_FLAGS.has(key)) {
        opts[key] = true; // store_true: an inline value (if any) is ignored, as argparse does
        continue;
      }
      if (key === "task") {
        // argparse nargs="+" action="extend": `--task a b` is greedy; `--task=a`
        // takes exactly one value (repeat APPENDS in both forms).
        let vals;
        if (inlineVal !== null) {
          vals = [inlineVal];
        } else {
          vals = [];
          while (i + 1 < argv.length && !argv[i + 1].startsWith("--")) vals.push(argv[++i]);
        }
        if (!vals.length) die(`argument --task: expected at least one argument`);
        opts.task = (opts.task || []).concat(vals);
        continue;
      }
      let val = inlineVal;
      if (val === null) {
        val = argv[++i];
        if (val === undefined) die(`argument --${key}: expected one argument`);
      }
      if (key === "pin") opts.pin.push(val);
      else opts[key] = val;
      continue;
    }
    if (cmd === null) cmd = a;
    else opts._pos.push(a);
  }
  return { cmd, opts };
}

/** argparse `type=int`: reject a non-integer with exit 2 (matches Python). */
function parseIntStrict(raw, flag, def) {
  if (raw === undefined || raw === null) return def;
  if (!/^[+-]?\d+$/.test(String(raw).trim())) {
    die(`argument --${flag}: invalid int value: '${raw}'`);
  }
  return parseInt(raw, 10);
}

function die(msg, code = 2) {
  console.error(USAGE);
  console.error(`named-subagents: error: ${msg}`);
  process.exit(code);
}

// --------------------------------------------------------------------------- //
// shared helpers
// --------------------------------------------------------------------------- //
function regCfg(opts) {
  // --no-cwd-config (false, wins) / --cwd-config (true) -> allowCwd, else null.
  let override = null;
  if (opts["no-cwd-config"]) override = false;
  else if (opts["cwd-config"]) override = true;
  return loadWithConfig(opts.registry || null, opts.config || null, override);
}

function ledgerOf(opts) {
  return opts.ledger ? new Ledger(opts.ledger) : new Ledger(null);
}

/** Config pins merged under repeatable --pin cat=Name flags (flags win). */
function pinsOf(opts, cfg) {
  const pins = { ...(cfg.pins || {}) };
  for (const item of opts.pin || []) {
    if (!item.includes("=")) {
      console.error(`--pin expects CATEGORY=Name, got '${item}'`);
      process.exit(1);
    }
    const idx = item.indexOf("=");
    pins[item.slice(0, idx).trim()] = item.slice(idx + 1).trim();
  }
  return pins;
}

const padCp = (s, width) => s + " ".repeat(Math.max(width - [...s].length, 0));

// --------------------------------------------------------------------------- //
// commands
// --------------------------------------------------------------------------- //
function cmdCategories(opts) {
  const { registry: reg } = regCfg(opts);
  const cats = Object.keys(reg.categories);
  console.log(`${reg.totalNames()} names across ${cats.length} categories:\n`);
  for (const c of cats) {
    const spec = reg.categories[c];
    console.log(
      `  ${padCp(reg.emoji(c), 2)} ${padCp(c, 12)} `
      + `${String(reg.names(c).length).padStart(3)}  ${reg.theme(c)}`);
    console.log(`      ${spec.blurb || ""}`);
  }
  return 0;
}

function cmdResolve(opts) {
  const { registry: reg } = regCfg(opts);
  const task = taskStr(opts);
  const cat = resolveCategory(reg, { role: opts.role, task, category: opts.category });
  const out = { category: cat, theme: reg.theme(cat), emoji: reg.emoji(cat) };
  if (opts.explain) {
    const role = opts.role || null;
    let reason;
    if (opts.category && hasOwn(reg.categories, opts.category)) reason = "category";
    else if (role && reg.bySubagentType(role)) reason = "role";
    else if (task && reg.byKeyword(task)) reason = "keyword";
    else reason = "default";
    out.explain = {
      reason,
      role,
      role_match: role ? reg.bySubagentType(role) : null,
      keyword_matches: task ? reg.keywordMatches(task) : {},
      keyword_scores: task ? reg.keywordScores(task) : {},
    };
  }
  console.log(pyDumps(out));
  return 0;
}

// argparse's --task is nargs="+"; resolve/allocate take it as one string.
function taskStr(opts) {
  return Array.isArray(opts.task) ? opts.task.join(" ") : opts.task;
}

function cmdAllocate(opts) {
  const { registry: reg, config: cfg } = regCfg(opts);
  // Validate --count BEFORE touching the ledger (argparse exits 2 with no side effect).
  const count = parseIntStrict(opts.count, "count", 1);
  const cat = resolveCategory(reg, {
    role: opts.role, task: taskStr(opts), category: opts.category,
  });
  const avoid = opts["avoid-installed"] ? installedAgentNames() : null;
  const names = allocate(cat, count, reg, {
    ledger: ledgerOf(opts), pins: pinsOf(opts, cfg), avoid,
  });
  if (opts.json) console.log(pyDumps({ category: cat, nicknames: names }));
  else for (const n of names) console.log(n);
  return 0;
}

function cmdAssign(opts) {
  const { registry: reg, config: cfg } = regCfg(opts);
  if (!opts.task) die("the following arguments are required: --task");
  // Validate --format and --count BEFORE planFanout touches the ledger — argparse
  // (choices + type=int) rejects both with exit 2 and no side effect.
  const format = opts.format || "agent";
  if (!["agent", "labels", "workflow", "swarm", "table"].includes(format)) {
    die(`argument --format: invalid choice: '${format}' (choose from 'agent', 'labels', 'workflow', 'swarm', 'table')`);
  }
  const count = parseIntStrict(opts.count, "count", 0);
  let tasks = Array.isArray(opts.task) ? opts.task : [opts.task];
  if (count && count > tasks.length) {
    // replicate the single task N times (N parallel workers on the same job)
    if (tasks.length === 1) tasks = Array(count).fill(tasks[0]);
  }
  const plan = planFanout(tasks, reg, {
    ledger: ledgerOf(opts), role: opts.role, category: opts.category,
    subagentType: opts["subagent-type"], pins: pinsOf(opts, cfg),
    avoidInstalled: !!opts["avoid-installed"], withBio: !!opts["bio-in-prompt"],
  });
  if (format === "labels") {
    console.log(pyDumps(toLabels(plan), { indent: 2 }));
  } else if (format === "workflow") {
    console.log(toWorkflow(plan));
  } else if (format === "swarm") {
    console.log(toSwarm(plan));
  } else if (format === "table") {
    console.log(toTable(plan));
  } else { // agent
    // full Assignment JSON (agentKwargs is non-enumerable, so a spread drops it)
    console.log(pyDumps(plan.map((a) => ({ ...a })), { indent: 2 }));
  }
  return 0;
}

function requireLedgerCatName(opts, verb) {
  for (const f of ["category", "name", "ledger"]) {
    if (!opts[f]) die(`${verb}: the following arguments are required: --${f}`);
  }
}

/** CLI guard: the ledger verbs are permissive at the library level, but a
 * typo'd --name that isn't in the category's registry pool is almost always a
 * mistake. Reject it (exit 1) with a clear message. Honors --registry/--config. */
function requireNameInPool(opts) {
  const { registry: reg } = regCfg(opts);
  if (!hasOwn(reg.categories, opts.category)) {
    console.error(`error: unknown category '${opts.category}'`);
    return false;
  }
  if (!(reg.categories[opts.category].names || []).includes(stripGen(opts.name))) {
    console.error(`error: name '${opts.name}' is not in the '${opts.category}' pool`);
    return false;
  }
  return true;
}

function cmdRelease(opts) {
  requireLedgerCatName(opts, "release");
  if (!requireNameInPool(opts)) return 1;
  const led = new Ledger(opts.ledger);
  const ok = led.release(opts.category, opts.name);
  console.log(pyDumps({ released: ok, category: opts.category, name: opts.name },
    { ensureAscii: true }));
  return 0;
}

function cmdRetire(opts) {
  requireLedgerCatName(opts, "retire");
  if (!requireNameInPool(opts)) return 1;
  const led = new Ledger(opts.ledger);
  const ok = led.retire(opts.category, opts.name);
  console.log(pyDumps({ retired: ok, category: opts.category, name: opts.name },
    { ensureAscii: true }));
  return 0;
}

function cmdUnretire(opts) {
  requireLedgerCatName(opts, "unretire");
  if (!requireNameInPool(opts)) return 1;
  const led = new Ledger(opts.ledger);
  const ok = led.unretire(opts.category, opts.name);
  console.log(pyDumps({ unretired: ok, category: opts.category, name: opts.name },
    { ensureAscii: true }));
  return 0;
}

function cmdStats(opts) {
  const { registry: reg } = regCfg(opts);
  const stats = ledgerStats(reg, new Ledger(opts.ledger || null));
  if (opts.json) {
    console.log(pyDumps(stats, { indent: 2, floatKeys: STATS_FLOAT_KEYS }));
    return 0;
  }
  const hdr = "category".padEnd(14) + "pool".padStart(6) + "used".padStart(6)
    + "%used".padStart(7) + "gen".padStart(5) + "retired".padStart(9)
    + "lifetime".padStart(10) + "remaining".padStart(11);
  console.log(hdr);
  console.log("-".repeat(hdr.length));
  for (const [cat, row] of Object.entries(stats.categories)) {
    const flag = row.unknown ? " (unknown)" : "";
    console.log(
      cat.padEnd(14) + String(row.pool).padStart(6) + String(row.used).padStart(6)
      + formatPyFloat(row.pct_used).padStart(7) + String(row.generation).padStart(5)
      + String(row.retired).padStart(9) + String(row.total_allocated).padStart(10)
      + String(row.remaining).padStart(11) + flag);
  }
  const t = stats.totals;
  console.log("-".repeat(hdr.length));
  console.log(
    "TOTAL".padEnd(14) + String(t.pool).padStart(6) + String(t.used).padStart(6)
    + formatPyFloat(t.pct_used).padStart(7) + "".padStart(5)
    + String(t.retired).padStart(9) + String(t.total_allocated).padStart(10)
    + String(t.remaining).padStart(11));
  return 0;
}

function cmdBio(opts) {
  const { registry: reg } = regCfg(opts);
  const name = opts._pos[0];
  if (!name) die("bio: the following arguments are required: NAME");
  const base = stripGen(name);
  for (const cat of Object.keys(reg.categories)) {
    if ((reg.categories[cat].names || []).includes(base)) {
      console.log(reg.bio(cat, base));
      return 0;
    }
  }
  console.error(`name '${name}' not found in any category`);
  return 1;
}

// --------------------------------------------------------------------------- //
// doctor (D12)
// --------------------------------------------------------------------------- //
function isFileQuiet(p) {
  try {
    const st = statSync(p, { throwIfNoEntry: false });
    return !!st && st.isFile();
  } catch {
    return false;
  }
}
function isDirQuiet(p) {
  try {
    const st = statSync(p, { throwIfNoEntry: false });
    return !!st && st.isDirectory();
  } catch {
    return false;
  }
}

function doctorChecks(opts) {
  const checks = [];
  const add = (status, check, detail = "") => checks.push({ status, check, detail });

  // 1. registry loads + valid (uniqueness, sanitization, bios ⊆ names)
  let reg = null;
  let cfg = {};
  try {
    ({ registry: reg, config: cfg } = regCfg(opts));
    add("PASS", "registry",
      `${reg.totalNames()} names / ${Object.keys(reg.categories).length} categories, all valid`);
  } catch (e) {
    add("FAIL", "registry", `${e.name || "Error"}: ${e.message}`);
  }

  // 2. bios ⊆ names (validate() enforces it; recompute so the line is explicit)
  if (reg === null) {
    add("SKIP", "bios", "registry failed to load");
  } else {
    const strays = [];
    let nBios = 0;
    for (const c of Object.keys(reg.categories)) {
      const names = new Set(reg.categories[c].names || []);
      for (const b of Object.keys(reg.categories[c].bios || {})) {
        nBios += 1;
        if (!names.has(b)) strays.push(`${c}:${b}`);
      }
    }
    if (strays.length) add("FAIL", "bios", "bios for unknown names: " + strays.join(", "));
    else add("PASS", "bios", `${nBios} bios, all keys ⊆ names`);
  }

  // 3. js/registry.json byte-equal to the canonical copy (repo layout only)
  const jsReg = join(JS_DIR, "registry.json");
  const canonical = join(REPO_ROOT, "named_subagents", "registry.json");
  if (!isDirQuiet(join(REPO_ROOT, "named_subagents"))) {
    add("SKIP", "js-registry-sync", "no named_subagents/ sibling (installed layout)");
  } else if (!isFileQuiet(jsReg)) {
    add("SKIP", "js-registry-sync", "js/registry.json absent (placed by npm prepack)");
  } else if (readFileSync(jsReg).equals(readFileSync(canonical))) {
    add("PASS", "js-registry-sync", "byte-equal to named_subagents/registry.json");
  } else {
    add("FAIL", "js-registry-sync",
      "js/registry.json differs from canonical (stale prepack artifact)");
  }

  // 4. ledger
  if (!opts.ledger) {
    add("SKIP", "ledger", "no --ledger given");
  } else {
    const lp = opts.ledger;
    try {
      if (isFileQuiet(lp)) {
        const raw = readFileSync(lp, "utf8");
        let loaded = null;
        try {
          loaded = JSON.parse(raw);
        } catch {
          loaded = null;
        }
        if (!(loaded !== null && typeof loaded === "object" && !Array.isArray(loaded))) {
          add("INFO", "ledger-readable",
            "file exists but is corrupt — will be reset to fresh on next write");
          loaded = {};
        } else {
          add("PASS", "ledger-readable", `${Buffer.byteLength(raw)} bytes`);
        }
        const v = loaded._v;
        if (v === undefined || v === null) {
          add("PASS", "ledger-version", "v1 (no _v marker; upgraded on first write)");
        } else if (v === LEDGER_VERSION) {
          add("PASS", "ledger-version", `_v=${v}`);
        } else {
          add("FAIL", "ledger-version", `unknown ledger version _v=${JSON.stringify(v)}`);
        }
        const overlaps = [];
        for (const [cat, rec] of Object.entries(loaded)) {
          if (cat.startsWith("_")) continue;
          // A wrong-typed record must FAIL-report, never pass silently (parity
          // with the Python doctor).
          const issue = ledgerRecordIssue(rec);
          if (issue !== null) {
            add("FAIL", "ledger-record-malformed", `record '${cat}' malformed: ${issue}`);
            continue;
          }
          const retired = new Set(rec.retired || []);
          const both = (rec.used || []).filter((u) => retired.has(u)).sort();
          if (both.length) overlaps.push(`${cat}: [${both.map((b) => `'${b}'`).join(", ")}]`);
        }
        if (overlaps.length) {
          add("INFO", "ledger-used-retired-overlap",
            "transient + harmless (never re-drawn; next generation skips): "
            + overlaps.join("; "));
        }
      } else {
        add("PASS", "ledger-readable", "no file yet (fresh ledger will be created)");
      }
      // writable probe: save to a temp sibling, then remove it
      const probe = lp + ".doctor-probe.tmp";
      try {
        const probeLed = new Ledger(null);
        probeLed.path = probe;
        probeLed.save();
        unlinkSync(probe);
        add("PASS", "ledger-writable", "temp-save probe succeeded");
      } catch (e) {
        add("FAIL", "ledger-writable", `${e.code || e.name}: ${e.message}`);
      }
    } catch (e) {
      add("FAIL", "ledger-readable", `${e.code || e.name}: ${e.message}`);
    }
  }

  // 5. pins (from config)
  const pins = { ...(cfg.pins || {}) };
  const pinEntries = Object.entries(pins);
  if (!pinEntries.length) {
    add("SKIP", "pins", "no pins in config");
  } else {
    const bad = pinEntries.filter(([, n]) => !validName(n));
    if (bad.length) {
      add("FAIL", "pins",
        "pins failing name sanitization: {"
        + bad.map(([c, n]) => `'${c}': '${n}'`).join(", ") + "}");
    } else {
      add("PASS", "pins", `${pinEntries.length} pin(s), all sanitization-valid`);
    }
  }

  // 6. pool ∩ installed-agents overlap
  const installed = installedAgentNames();
  add("INFO", "installed-agents",
    installed.size
      ? `${installed.size} installed agent name(s): [${[...installed].sort().map((n) => `'${n}'`).join(", ")}]`
      : "no installed agent definitions found");
  if (reg !== null) {
    const installedL = new Set([...installed].map((n) => n.toLowerCase()));
    const clash = Object.keys(reg.categories)
      .flatMap((c) => reg.names(c))
      .filter((n) => installedL.has(n.toLowerCase()))
      .sort();
    if (clash.length) {
      add("FAIL", "pool-agent-collision",
        "pool names case-fold-equal to installed agents: " + clash.join(", "));
    } else {
      add("PASS", "pool-agent-collision", "no pool name collides with an installed agent");
    }
  }

  // 7. version triple-check (repo layout only): VERSION = package.json =
  //    pyproject.toml = named_subagents/__init__.py
  const pyproject = join(REPO_ROOT, "pyproject.toml");
  if (!isFileQuiet(pyproject)) {
    add("SKIP", "version", "no pyproject.toml sibling (installed layout)");
  } else {
    const versions = { VERSION };
    const pyMatch = /^version\s*=\s*"([^"]+)"/m.exec(readFileSync(pyproject, "utf8"));
    versions["pyproject.toml"] = pyMatch ? pyMatch[1] : null;
    const initPy = join(REPO_ROOT, "named_subagents", "__init__.py");
    if (isFileQuiet(initPy)) {
      const m = /^__version__\s*=\s*"([^"]+)"/m.exec(readFileSync(initPy, "utf8"));
      versions["named_subagents/__init__.py"] = m ? m[1] : null;
    }
    const pkgJson = join(JS_DIR, "package.json");
    if (isFileQuiet(pkgJson)) {
      try {
        versions["js/package.json"] = JSON.parse(readFileSync(pkgJson, "utf8")).version ?? null;
      } catch {
        versions["js/package.json"] = null;
      }
    }
    if (new Set(Object.values(versions)).size === 1) {
      add("PASS", "version", `all at ${VERSION}`);
    } else {
      add("FAIL", "version",
        "mismatch: {" + Object.entries(versions).map(([k, v]) => `'${k}': ${v === null ? "None" : `'${v}'`}`).join(", ") + "}");
    }
  }

  // 8. JS/Python parity probe (reverse of the Python doctor's node probe)
  const pyCli = join(REPO_ROOT, "named_subagents", "cli.py");
  if (!isFileQuiet(pyCli)) {
    add("SKIP", "parity", "python port not present");
  } else {
    try {
      const out = spawnSync("python3",
        ["-m", "named_subagents.cli", "allocate", "--category", "default", "--count", "3", "--json"],
        { cwd: REPO_ROOT, encoding: "utf8", timeout: 30000 });
      if (out.error || out.status !== 0) {
        add("SKIP", "parity",
          out.error
            ? `probe not comparable (${out.error.code || out.error.message})`
            : `python cli exited ${out.status} (interface mismatch or missing --json)`);
      } else {
        const pyNames = JSON.parse(out.stdout).nicknames;
        const jsNames = allocate("default", 3, Registry.load()); // bundled, no ledger
        if (JSON.stringify(pyNames) === JSON.stringify(jsNames)) {
          add("PASS", "parity", `both ports allocate [${jsNames.map((n) => `'${n}'`).join(", ")}]`);
        } else {
          add("FAIL", "parity",
            `python=${JSON.stringify(pyNames)} js=${JSON.stringify(jsNames)}`);
        }
      }
    } catch (e) {
      add("SKIP", "parity", `probe not comparable (${e.name}: ${e.message})`);
    }
  }

  // 9. auto-namer hook — install status (informational) + a live self-test
  const sp = settingsPath(opts);
  const { data: sdata } = readSettings(sp);
  let hooked = false;
  for (const _ of iterOurHooks((isObj(sdata.hooks) && sdata.hooks.PreToolUse) || [])) hooked = true;
  add("INFO", "hook-install",
    hooked ? `registered in ${sp}`
      : `not installed (run \`named-subagents hook install\` to enable auto-naming)`);
  try {
    // Self-test against a THROWAWAY ledger so doctor never writes real state.
    const hd = mkdtempSync(join(tmpdir(), "ns-doctor-"));
    let out;
    try {
      out = hookMutate(
        { tool_name: "Agent", tool_input: { description: "map auth", prompt: "go", subagent_type: "Explore" } },
        join(hd, "led.json"));
    } finally {
      rmSync(hd, { recursive: true, force: true });
    }
    const ui = (out && out.updatedInput) || {};
    const ok = (ui.description || "").endsWith("map auth")
      && ui.description !== "map auth"
      && (ui.prompt || "").includes(PERSONA_SIG);
    add(ok ? "PASS" : "FAIL", "hook-selftest",
      ok ? "`hook run` produces a valid nicknamed dispatch"
        : `unexpected mutation: ${JSON.stringify(out)}`);
  } catch (e) {
    add("FAIL", "hook-selftest", `${e.name}: ${e.message}`);
  }

  return checks;
}

function cmdDoctor(opts) {
  const checks = doctorChecks(opts);
  const failCount = checks.filter((c) => c.status === "FAIL").length;
  if (opts.json) {
    console.log(pyDumps({ checks, fail_count: failCount, version: VERSION }, { indent: 2 }));
  } else {
    for (const c of checks) {
      const detail = c.detail ? `  ${c.detail}` : "";
      console.log(`[${c.status}] ${c.check}${detail}`);
    }
    console.log(`\n${checks.length} checks, ${failCount} failed`);
  }
  return failCount ? 1 : 0;
}

// --------------------------------------------------------------------------- //
// init — scaffold a starter config
// --------------------------------------------------------------------------- //
const INIT_TEMPLATE = {
  pins: { security: "Argus" },
  extend: { explore: { names: ["Kupe"] } },
  categories: {
    starships: {
      theme: "Star systems",
      emoji: "🚀",
      keywords: ["fleet", "deploy", "orchestrate"],
      names: ["Enterprise", "Rocinante", "Serenity", "Nostromo"],
    },
  },
};

function initPath(opts) {
  if (opts.path) return opts.path;
  if (opts.cwd) return join(process.cwd(), ".named-subagents.json");
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "named-subagents", "config.json");
}

function cmdInit(opts) {
  const path = initPath(opts);
  if (existsSync(path) && !opts.force) {
    console.error(`error: ${path} already exists — pass --force to overwrite.`);
    return 1;
  }
  // Validate the template loads cleanly before writing (catches an edit that trips
  // the config validator, e.g. a name colliding with the bundled registry).
  const tmp = mkdtempSync(join(tmpdir(), "ns-init-"));
  try {
    const probe = join(tmp, "config.json");
    writeFileSync(probe, JSON.stringify(INIT_TEMPLATE));
    loadWithConfig(null, probe, false);          // throws on an invalid config
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  mkdirSync(dirname(path) || ".", { recursive: true });
  writeFileSync(path, JSON.stringify(INIT_TEMPLATE, null, 2) + "\n");
  const hint = opts.path ? `load it with \`--config ${path}\`.`
    : opts.cwd ? "enable it per-project with `--cwd-config`."
      : "the home config is picked up automatically.";
  console.log(`wrote a starter config to ${path}\n`
    + "  It pins a security nickname (Argus), extends the explore pool, and adds a\n"
    + `  custom 'starships' category. Edit it to taste — ${hint}`);
  return 0;
}

// --------------------------------------------------------------------------- //
// Auto-namer hook — install once; nickname every subagent dispatch.
// Twin of the Python cli.py hook section; `hook run` output is parity-identical.
// --------------------------------------------------------------------------- //
const HOOK_MARKER = "named-subagents-autonamer";      // sentinel in the registered command
const PERSONA_SIG = "parallel agents in this run.";   // idempotency probe (from personaPreamble)
const DISPATCH_TOOLS = new Set(["Agent", "Task"]);    // Task -> Agent rename (CC 2.1.63; alias kept)
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

function hookLedgerPath() {
  const env = process.env.NAMED_SUBAGENTS_LEDGER;
  if (env) return env;
  const base = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
  return join(base, "named-subagents", "hook-ledger.json");
}

function sleepMs(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* ignore */ }
}

/** Serialize a load->allocate->save critical section across processes with an
 * O_EXCL lockfile (Node has no flock; this mirrors the Python Ledger.lock()).
 * A stale lock (>15s, e.g. a crashed writer) is stolen so it can't wedge dispatches. */
function withLedgerLock(path, fn) {
  if (!path) return fn();
  const lock = path + ".lock";
  let fd = null;
  const start = Date.now();
  for (;;) {
    try { fd = openSync(lock, "wx"); break; } catch (e) {
      if (e.code !== "EEXIST") throw e;
      try {
        if (Date.now() - statSync(lock).mtimeMs > 15000) {
          // Atomic steal: rename is atomic, so exactly ONE racer removes the stale
          // lock; the losers get ENOENT and fall through to keep waiting. A blind
          // unlink+recreate could let two processes both enter the section.
          const stolen = `${lock}.stale-${process.pid}`;
          try { renameSync(lock, stolen); unlinkSync(stolen); } catch { /* another racer won the steal */ }
          continue;
        }
      } catch { /* lock vanished between open and stat */ }
      if (Date.now() - start > 10000) throw new Error("ledger lock timeout");
      sleepMs(5);
    }
  }
  try { return fn(); }
  finally {
    try { closeSync(fd); } catch { /* */ }
    try { unlinkSync(lock); } catch { /* */ }
  }
}

/** Map a PreToolUse event -> the hookSpecificOutput object to emit, or null to
 * pass the dispatch through. May throw on internal error (caller fails open). */
function hookMutate(event, ledgerPath = null) {
  if (process.env.NAMED_SUBAGENTS_HOOK_DISABLE) return null;
  if (!isObj(event) || !DISPATCH_TOOLS.has(event.tool_name)) return null;
  const ti = event.tool_input;
  if (!isObj(ti)) return null;
  const str = (v) => (typeof v === "string" ? v : "");
  const prompt = str(ti.prompt);
  const description = str(ti.description);
  const subagentType = str(ti.subagent_type);

  // Never auto-load ./.named-subagents.json — the hook runs in arbitrary
  // (possibly untrusted) dirs and its output lands in agent prompts.
  const { registry: reg } = loadWithConfig(null, null, false);
  // Idempotency: two signals so an empty-prompt dispatch can't double-prefix —
  // the persona preamble in the prompt, or a description already led by our emoji.
  if (prompt.includes(PERSONA_SIG)) return null;
  // Fall back to a description-emoji probe ONLY when there's no prompt (a rare
  // empty-prompt re-fire). A prompted dispatch is governed by the SIG above, so a
  // legit description like "📊 Q3 chart" isn't wrongly treated as already-named.
  if (!prompt && description
      && Object.keys(reg.categories).some((c) => description.startsWith(reg.emoji(c)))) {
    return null;
  }
  const cat = resolveCategory(reg, { role: subagentType || null, task: description || null });

  const lp = ledgerPath !== null ? ledgerPath : hookLedgerPath();
  if (lp) mkdirSync(dirname(lp), { recursive: true });
  const nickname = withLedgerLock(lp, () => {
    const led = new Ledger(lp);           // loads fresh state under the lock
    const n = allocate(cat, 1, reg, { ledger: led })[0];
    led.save();
    return n;
  });

  const emoji = reg.emoji(cat);
  const theme = reg.theme(cat);
  const bio = process.env.NAMED_SUBAGENTS_HOOK_BIO ? reg.bio(cat, stripGen(nickname)) : null;
  const updated = { ...ti };
  updated.description = description
    ? `${emoji} ${nickname}: ${description}`.trim()
    : `${emoji} ${nickname}`;
  if (prompt) updated.prompt = personaPreamble(nickname, theme, bio) + prompt;
  return { hookEventName: "PreToolUse", updatedInput: updated };
}

function cmdHookRun() {
  // FAIL-OPEN: read the event on stdin, emit updatedInput, ALWAYS exit 0. Any
  // error -> emit nothing -> the dispatch runs with its original input. A broken
  // namer must never break a fan-out, and must never exit non-zero (2 would block).
  try {
    const event = JSON.parse(readFileSync(0, "utf8"));
    const out = hookMutate(event);
    if (out !== null) process.stdout.write(pyDumps({ hookSpecificOutput: out }));
  } catch { /* fail-open by design */ }
  return 0;
}

// ---- settings.json management (install / uninstall / status) --------------- //
function settingsPath(opts) {
  if (opts.settings) return opts.settings;
  if (opts.project) return join(opts.project, ".claude", "settings.json");
  return join(homedir(), ".claude", "settings.json");
}

function hookCommand() {
  // Absolute node + absolute cli.mjs path (robust against the bin not being on the
  // hook's PATH). `--managed-by` is a real (ignored) arg marker, not a shell comment.
  const cli = fileURLToPath(import.meta.url);
  return `"${process.execPath}" "${cli}" hook run --managed-by ${HOOK_MARKER}`;
}

function readSettings(sp) {
  // { data, error }: data is ALWAYS an object ({} when absent/unreadable); error is
  // set when the file exists but can't be parsed, so callers refuse to clobber it.
  if (!existsSync(sp)) return { data: {}, error: null };
  let data;
  try { data = JSON.parse(readFileSync(sp, "utf8")); }
  catch (e) { return { data: {}, error: e.message }; }
  if (!isObj(data)) return { data: {}, error: "top-level JSON is not an object" };
  return { data, error: null };
}

function writeSettings(sp, data, backup = false) {
  mkdirSync(dirname(sp) || ".", { recursive: true });
  if (backup && existsSync(sp)) copyFileSync(sp, sp + ".bak");
  // 'wx' (O_EXCL) + a unique name: a pre-planted `<settings>.tmp` symlink can't
  // redirect the write (same discipline as Ledger.save()).
  const tmp = `${sp}.${process.pid}.tmp`;
  try { unlinkSync(tmp); } catch { /* not present */ }
  const fd = openSync(tmp, "wx");
  try {
    writeFileSync(fd, JSON.stringify(data, null, 2) + "\n");   // std serializer for arbitrary settings
    closeSync(fd);
    renameSync(tmp, sp);                                       // atomic
  } catch (e) {
    try { closeSync(fd); } catch { /* already closed */ }
    try { unlinkSync(tmp); } catch { /* nothing to clean */ }  // never leave a stray temp
    throw e;
  }
}

function* iterOurHooks(pre) {
  for (const m of Array.isArray(pre) ? pre : []) {
    if (!isObj(m)) continue;
    for (const h of m.hooks || []) {
      if (isObj(h) && (h.command || "").includes(HOOK_MARKER)) yield [m, h];
    }
  }
}

function cmdHookInstall(opts) {
  const sp = settingsPath(opts);
  const { data, error } = readSettings(sp);
  if (error) {
    console.error(`error: ${sp} is not valid settings JSON (${error}); refusing to modify it.\n`
      + "Fix or remove that file, then re-run `named-subagents hook install`.");
    return 1;
  }
  if (data.hooks === undefined) data.hooks = {};
  if (!isObj(data.hooks)) { console.error(`error: ${sp} has a non-object 'hooks'; refusing to modify.`); return 1; }
  if (data.hooks.PreToolUse === undefined) data.hooks.PreToolUse = [];
  if (!Array.isArray(data.hooks.PreToolUse)) {
    console.error(`error: ${sp} has a non-list 'hooks.PreToolUse'; refusing to modify.`); return 1;
  }
  const existed = existsSync(sp);
  const cmd = hookCommand();
  for (const [, h] of iterOurHooks(data.hooks.PreToolUse)) {
    h.command = cmd;                    // refresh (e.g. new interpreter path); idempotent
    writeSettings(sp, data, existed);
    console.log(`auto-namer hook already installed — refreshed the command in ${sp}`);
    return 0;
  }
  data.hooks.PreToolUse.push({ matcher: "Agent|Task", hooks: [{ type: "command", command: cmd }] });
  writeSettings(sp, data, existed);
  console.log(`installed the auto-namer hook in ${sp}\n  matcher: Agent|Task\n  command: ${cmd}\n`
    + "New Claude Code sessions will nickname every subagent dispatch.\n"
    + "Verify with `named-subagents hook status`.");
  return 0;
}

function cmdHookUninstall(opts) {
  const sp = settingsPath(opts);
  if (!existsSync(sp)) { console.log(`nothing to remove: ${sp} does not exist`); return 0; }
  const { data, error } = readSettings(sp);
  if (error) { console.error(`error: ${sp} is not valid JSON (${error}); refusing to modify.`); return 1; }
  const pre = isObj(data.hooks) ? data.hooks.PreToolUse : undefined;
  if (!Array.isArray(pre)) { console.log(`no auto-namer hook found in ${sp}`); return 0; }
  let removed = 0;
  const newPre = [];
  for (const m of pre) {
    if (!isObj(m) || !Array.isArray(m.hooks)) { newPre.push(m); continue; }  // leave non-hooks blocks as-is
    const hs = m.hooks;
    const kept = hs.filter((h) => !(isObj(h) && (h.command || "").includes(HOOK_MARKER)));
    if (kept.length === hs.length) { newPre.push(m); continue; }             // nothing ours -> untouched
    removed += hs.length - kept.length;
    if (kept.length) newPre.push({ ...m, hooks: kept });                     // else drop the emptied block
  }
  if (removed) {
    data.hooks.PreToolUse = newPre;
    writeSettings(sp, data, true);
    console.log(`removed the auto-namer hook from ${sp}`);
  } else {
    console.log(`no auto-namer hook found in ${sp}`);
  }
  return 0;
}

function cmdHookStatus(opts) {
  const sp = settingsPath(opts);
  const { data, error } = readSettings(sp);
  let installed = false;
  let cmd = null;
  const pre = isObj(data.hooks) ? data.hooks.PreToolUse : [];
  for (const [, h] of iterOurHooks(pre || [])) { installed = true; cmd = h.command; }
  const lp = hookLedgerPath();
  const ledExists = existsSync(lp);
  let allocated = null;
  if (ledExists) {
    try {
      const { registry: reg } = loadWithConfig(null, null, false);
      allocated = ledgerStats(reg, new Ledger(lp)).totals.total_allocated;
    } catch { allocated = null; }
  }
  const disabled = !!process.env.NAMED_SUBAGENTS_HOOK_DISABLE;
  if (opts.json) {
    console.log(pyDumps({
      settings_path: sp, settings_malformed: !!error, installed, command: cmd,
      ledger_path: lp, ledger_exists: ledExists, total_allocated: allocated, disabled,
    }, { indent: 2 }));
    return 0;
  }
  console.log(`settings:   ${sp}${error ? "  ⚠ MALFORMED JSON" : ""}`);
  console.log(`installed:  ${installed ? "yes" : "no"}`);
  if (cmd) console.log(`  command:  ${cmd}`);
  console.log(`ledger:     ${lp}  (${ledExists ? "exists" : "not created yet"}`
    + (allocated !== null ? `, ${allocated} names allocated` : "") + ")");
  if (disabled) console.log("note:       NAMED_SUBAGENTS_HOOK_DISABLE is set — hook is a no-op in this env");
  return 0;
}

function cmdHook(opts) {
  const sub = opts._pos[0];
  const handlers = {
    run: cmdHookRun, install: cmdHookInstall, uninstall: cmdHookUninstall, status: cmdHookStatus,
  };
  if (!sub || !(sub in handlers)) {
    die(sub
      ? `argument hook: invalid choice: '${sub}' (choose from 'run', 'install', 'uninstall', 'status')`
      : "hook: a subcommand is required (run|install|uninstall|status)");
  }
  return handlers[sub](opts);
}

// --------------------------------------------------------------------------- //
const HANDLERS = {
  categories: cmdCategories,
  resolve: cmdResolve,
  allocate: cmdAllocate,
  assign: cmdAssign,
  release: cmdRelease,
  retire: cmdRetire,
  unretire: cmdUnretire,
  stats: cmdStats,
  doctor: cmdDoctor,
  bio: cmdBio,
  init: cmdInit,
  hook: cmdHook,
};

function main() {
  const raw = process.argv.slice(2);
  // FAIL-OPEN fast path: `hook run` must NEVER exit non-zero on ANY argv. parseArgs
  // die()s (process.exit(2)) on a trailing valueless flag, and exit 2 would BLOCK the
  // dispatch — the one thing the contract forbids. Route it straight to the handler.
  if (raw[0] === "hook" && raw[1] === "run") return cmdHookRun();
  const { cmd, opts } = parseArgs(raw);
  if (opts.version) {
    console.log(`named-subagents ${VERSION}`);
    return 0;
  }
  if (!cmd || !COMMANDS.has(cmd)) {
    die(cmd ? `argument cmd: invalid choice: '${cmd}'` : "a subcommand is required");
  }
  try {
    return HANDLERS[cmd](opts);
  } catch (e) {
    if (e instanceof PoolExhaustedError) {
      console.error(`PoolExhaustedError: ${e.message}`);
      return 1;
    }
    // A bad ledger dir (ENOENT), a non-regular/oversized registry path, etc.
    // surface as a clean one-line error + exit 1 instead of a raw stack trace.
    if (e && (e.code || /is not a regular file|too large/.test(e.message || ""))) {
      console.error(`error: ${e.message}`);
      return 1;
    }
    throw e;
  }
}

process.exit(main());
