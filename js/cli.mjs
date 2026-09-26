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
  appendFileSync, closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync,
  readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  Ledger, LEDGER_VERSION, PoolExhaustedError, Registry, VERSION,
  allocate, installedAgentNames, ledgerRecordIssue, ledgerStats, loadWithConfig,
  personaPreamble, planFanout, pyDumps, formatPyFloat, resolveCategory, resolveForHook,
  stripGen, validName, toLabels, toSwarm, toTable, toWorkflow, _hasOwn as hasOwn,
} from "./named_subagents.mjs";

const JS_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(JS_DIR);

const STATS_FLOAT_KEYS = new Set(["pct_used"]);

// --------------------------------------------------------------------------- //
// argv parsing (mirrors the Python argparse surface)
// --------------------------------------------------------------------------- //
const BOOL_FLAGS = new Set(["json", "avoid-installed", "bio-in-prompt", "version", "cwd-config", "no-cwd-config", "explain", "cwd", "force", "roster"]);
const COMMANDS = new Set([
  "categories", "resolve", "allocate", "assign",
  "release", "retire", "unretire", "stats", "doctor", "bio", "init", "hook", "roster",
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
      else if (key === "base") (opts.base = opts.base || []).push(val);   // repeatable
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
    // Our own roster callsign files are pool names by construction, not collisions.
    const own = new Set(Object.keys((loadRoster() || {}).files || {}).map((n) => n.toLowerCase()));
    const installedL = new Set([...installed].map((n) => n.toLowerCase()).filter((n) => !own.has(n)));
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
  const sh = isObj(sdata.hooks) ? sdata.hooks : {};
  let hooked = false;
  for (const _ of iterOurHooks(sh.SubagentStart || [])) hooked = true;
  let legacy = false;
  let capture = false;
  let retype = false;
  for (const [, h] of iterOurHooks(sh.PreToolUse || [])) {
    if (isCaptureHook(h)) capture = true;   // the v0.4.3 task-capture entry, NOT legacy
    else if (isRetypeHook(h)) retype = true; // the v0.5.0 roster-mode entry, NOT legacy
    else legacy = true;
  }
  if (retype) {
    add("INFO", "hook-install",
      `roster mode (PreToolUse retype) in ${sp}`
      + (loadRoster() ? "" : "  ⚠ no roster manifest — run `named-subagents roster install`")
      + ((hooked || capture) ? "  ⚠ auto-namer entries also present — re-run `hook install --roster`" : ""));
  } else if (hooked) {
    add("INFO", "hook-install",
      `registered (SubagentStart${capture ? " + task capture" : ""}) in ${sp}`
      + (capture ? "" : "  ⚠ task capture not registered — re-run `hook install` for task theming")
      + (legacy ? "  ⚠ legacy PreToolUse entry also present — re-run `hook install` to migrate" : ""));
  } else if (legacy) {
    add("INFO", "hook-install",
      `⚠ only a legacy PreToolUse entry in ${sp} (clobber-prone) — re-run \`hook install\` to migrate to SubagentStart`);
  } else {
    add("INFO", "hook-install",
      "not installed (run `named-subagents hook install` to enable auto-naming)");
  }
  if (process.env.NAMED_SUBAGENTS_HOOK_DISABLE) {
    // Kill switch is a documented, legitimate state — don't FAIL (or flip the exit code).
    add("INFO", "hook-selftest", "skipped — disabled via NAMED_SUBAGENTS_HOOK_DISABLE");
  } else {
    try {
      // Self-test against a THROWAWAY ledger so doctor never writes real state.
      // This exercises the hook's OUTPUT shape, NOT Claude Code's application of it
      // — end-to-end additionalContext delivery is verified live in the suite.
      const hd = mkdtempSync(join(tmpdir(), "ns-doctor-"));
      let out;
      let out2;
      try {
        out = hookSubagentStart(
          { hook_event_name: "SubagentStart", agent_type: "Explore" },
          join(hd, "led.json"), join(hd, "q"));
        // v0.4.3: the capture -> pop -> task-theming chain (a generic role with a
        // security task must theme by TASK, not fall to the role pool)
        hookPreCapture(
          { hook_event_name: "PreToolUse", tool_name: "Agent",
            session_id: "doctor-selftest",
            tool_input: { description: "security audit",
              prompt: "Audit auth for injection vulnerabilities.",
              subagent_type: "general-purpose" } },
          join(hd, "q"));
        out2 = hookSubagentStart(
          { hook_event_name: "SubagentStart", session_id: "doctor-selftest",
            agent_type: "general-purpose" },
          join(hd, "led.json"), join(hd, "q"));
      } finally {
        rmSync(hd, { recursive: true, force: true });
      }
      const ac = (out && out.additionalContext) || "";
      const ok = !!out && out.hookEventName === "SubagentStart" && ac.includes(PERSONA_SIG);
      const ac2 = (out2 && out2.additionalContext) || "";
      const ok2 = ac2.includes("guardians");   // task-themed, not the role's programmer pool
      add(ok && ok2 ? "PASS" : "FAIL", "hook-selftest",
        ok && ok2
          ? "`hook run` emits a valid SubagentStart nickname context (incl. task-themed capture)"
          : `unexpected output: ${JSON.stringify(ok ? out2 : out)}`);
    } catch (e) {
      add("FAIL", "hook-selftest", `${e.name}: ${e.message}`);
    }
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

// ---- task hand-off queue (v0.4.3) ------------------------------------------ //
// SubagentStart carries only `agent_type` — no task (and there is NO cross-event
// correlation key; probe 2026-07-13). An output-free PreToolUse hook captures each
// dispatch's task into a per-session FIFO; the SubagentStart hook pops the oldest
// ROLE-MATCHING entry. Returning nothing from the PRE hook keeps it immune to the
// multi-hook updatedInput clobber (claude-code#15897/#39814).
const QUEUE_TTL_SECONDS = 30.0;   // entries older than this are orphans (dispatch never started)

function hookQueueDir() {
  const env = process.env.NAMED_SUBAGENTS_QUEUE_DIR;
  if (env) return env;
  const base = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
  return join(base, "named-subagents", "queue");
}

function queuePath(sessionId, queueDir = null) {
  let sid = typeof sessionId === "string" ? sessionId : "";
  sid = sid.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 80) || "nosession";
  return join(queueDir || hookQueueDir(), `q-${sid}.jsonl`);
}

/** Push {role, task, skip, ts} for an Agent/Task dispatch onto the per-session
 * FIFO. ALWAYS returns null — this hook must stay output-free. A dispatch that is
 * already named (CLI `assign`, or a re-fire) pushes a TOMBSTONE (skip=true), never
 * nothing: SubagentStart fires unconditionally per dispatch, so a push-skip would
 * desync every sibling after it by one. */
function hookPreCapture(event, queueDir = null) {
  if (process.env.NAMED_SUBAGENTS_HOOK_DISABLE) return null;
  if (!isObj(event) || !DISPATCH_TOOLS.has(event.tool_name)) return null;
  const ti = event.tool_input;
  if (!isObj(ti)) return null;
  const str = (v) => (typeof v === "string" ? v : "");
  const prompt = str(ti.prompt);
  const description = str(ti.description);
  let skip = prompt.includes(PERSONA_SIG);
  if (!skip && !prompt && description) {
    const { registry: reg } = loadWithConfig(null, null, false);
    skip = Object.keys(reg.categories).some((c) => description.startsWith(reg.emoji(c)));
  }
  const entry = {
    role: str(ti.subagent_type),
    task: `${description}\n${prompt}`.trim(),
    skip,
    ts: Date.now() / 1000,
  };
  const qpath = queuePath(event.session_id, queueDir);
  mkdirSync(dirname(qpath) || ".", { recursive: true });
  withLedgerLock(qpath, () => {
    appendFileSync(qpath, JSON.stringify(entry) + "\n");
  });
  return null;
}

/** Pop the oldest entry whose role matches `agentType`, pruning stale orphans in
 * passing. A mismatched entry is NEVER stolen (it belongs to a sibling with a
 * different role); no match -> null (caller falls back to role theming). The file
 * is removed once drained so the state dir doesn't accumulate per-session files. */
function queuePop(sessionId, agentType, queueDir = null) {
  const qpath = queuePath(sessionId, queueDir);
  if (!existsSync(qpath)) return null;
  let popped = null;
  withLedgerLock(qpath, () => {
    let lines;
    try { lines = readFileSync(qpath, "utf8").split("\n"); } catch { return; }
    const now = Date.now() / 1000;
    const entries = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      let e;
      try { e = JSON.parse(line); } catch { continue; }
      if (isObj(e) && now - (Number(e.ts) || 0) <= QUEUE_TTL_SECONDS) entries.push(e);
    }
    const keep = [];
    for (const e of entries) {
      if (popped === null && e.role === agentType) popped = e;
      else keep.push(e);
    }
    if (keep.length) {
      const tmp = `${qpath}.${process.pid}.tmp`;
      try { unlinkSync(tmp); } catch { /* not present */ }
      const fd = openSync(tmp, "wx");
      try {
        writeFileSync(fd, keep.map((e) => JSON.stringify(e) + "\n").join(""));
        closeSync(fd);
        renameSync(tmp, qpath);
      } catch (err) {
        try { closeSync(fd); } catch { /* already closed */ }
        try { unlinkSync(tmp); } catch { /* nothing to clean */ }
        throw err;
      }
    } else {
      try { unlinkSync(qpath); } catch { /* already gone */ }
    }
  });
  return popped;
}

/** Map a PreToolUse event -> the hookSpecificOutput object to emit, or null to
 * pass the dispatch through. `avoid` excludes base names from the draw (the
 * roster fallback passes its callsigns so the two naming mechanisms can never
 * surface the same name side by side). May throw on internal error (caller
 * fails open). */
function hookMutate(event, ledgerPath = null, avoid = null) {
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
    const n = allocate(cat, 1, reg, { ledger: led, avoid })[0];
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

/** Map a SubagentStart event -> the hookSpecificOutput object to emit, or null
 * to pass through. This is the PRIMARY auto-namer path (v0.4.2): it delivers the
 * nickname via `additionalContext`, which is ADDITIVE and reaches the subagent's
 * own context — so it is immune to the multi-hook `updatedInput` clobber that
 * silently drops the Agent-tool PreToolUse path (claude-code#15897 / #39814).
 * v0.4.3: theming is TASK-first when the PreToolUse capture hook queued this
 * dispatch's task (see hookPreCapture); a tombstone (CLI-named dispatch) emits
 * nothing; queue empty / role mismatch / stale falls back to the v0.4.2 ROLE
 * theming. `ledgerPath`/`queueDir` override defaults (doctor passes temps). */
function hookSubagentStart(event, ledgerPath = null, queueDir = null) {
  if (process.env.NAMED_SUBAGENTS_HOOK_DISABLE) return null;
  if (!isObj(event)) return null;
  const agentType = typeof event.agent_type === "string" ? event.agent_type : "";

  const entry = queuePop(event.session_id, agentType, queueDir);
  if (entry && entry.skip) return null;   // CLI already named this dispatch

  // Never auto-load ./.named-subagents.json — the hook runs in arbitrary
  // (possibly untrusted) dirs and its output lands in the subagent's context.
  const { registry: reg } = loadWithConfig(null, null, false);
  const task = entry && typeof entry.task === "string" ? entry.task : null;
  const cat = task
    ? resolveForHook(reg, { role: agentType || null, task })
    : resolveCategory(reg, { role: agentType || null });

  const lp = ledgerPath !== null ? ledgerPath : hookLedgerPath();
  if (lp) mkdirSync(dirname(lp), { recursive: true });
  const nickname = withLedgerLock(lp, () => {
    const led = new Ledger(lp);           // loads fresh state under the lock
    const n = allocate(cat, 1, reg, { ledger: led })[0];
    led.save();
    return n;
  });

  const theme = reg.theme(cat);
  const bio = process.env.NAMED_SUBAGENTS_HOOK_BIO ? reg.bio(cat, stripGen(nickname)) : null;
  const context = personaPreamble(nickname, theme, bio, false);
  return { hookEventName: "SubagentStart", additionalContext: context };
}

// ---- roster mode (v0.5.0): visible names in the live task tree ------------- //
// Claude Code's task-tree label is the agent-definition NAME (hardcoded — no
// per-instance field exists; claude-code#9206 closed unplanned). Roster mode makes
// the name the definition: `roster install` generates persona agent files (clones
// of a base agent + persona preamble), and a PreToolUse hook rewrites
// `subagent_type` -> a free roster callsign via `updatedInput`, so the tree shows
// "Durga" where it showed "general-purpose". Viable since the Agent-tool
// updatedInput multi-hook clobber (claude-code#15897/#39814) was fixed upstream
// (verified live on CC 2.1.245, 2026-08-26 probe).
const ROSTER_MARKER = "named-subagents-roster v1";  // sentinel inside generated files
const ROSTER_USED_TTL = 48 * 3600.0;                // per-session used-files GC horizon
const ROSTER_GENERIC_BODY =
  "You are a capable general agent. Complete the dispatched task thoroughly "
  + "and return a clear, complete report of what you did and found.\n";

/** Where the roster manifest lives. NAMED_SUBAGENTS_ROSTER overrides; default is
 * per-user state (user-written only — the hook never reads project-local roster
 * state, same trust posture as the hook registry load). */
function rosterStatePath() {
  const env = process.env.NAMED_SUBAGENTS_ROSTER;
  if (env) return env;
  const base = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
  return join(base, "named-subagents", "roster.json");
}

/** Manifest object or null. Defensive: malformed/missing -> null (hook falls
 * back to the mutate path), never a crash. */
function loadRoster(path = null) {
  const p = path || rosterStatePath();
  if (!existsSync(p)) return null;
  let data;
  try { data = JSON.parse(readFileSync(p, "utf8")); } catch { return null; }
  if (!isObj(data) || !isObj(data.agents)) return null;
  if (!isObj(data.files)) data.files = {};
  return data;
}

function saveRoster(data, path = null) {
  const p = path || rosterStatePath();
  mkdirSync(dirname(p) || ".", { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  try { unlinkSync(tmp); } catch { /* not present */ }
  const fd = openSync(tmp, "wx");
  try {
    writeFileSync(fd, JSON.stringify(data, null, 2) + "\n");
    closeSync(fd);
    renameSync(tmp, p);
  } catch (e) {
    try { closeSync(fd); } catch { /* already closed */ }
    try { unlinkSync(tmp); } catch { /* nothing to clean */ }
    throw e;
  }
}

function rosterUsedPath(sessionId, queueDir = null) {
  let sid = typeof sessionId === "string" ? sessionId : "";
  sid = sid.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 80) || "nosession";
  return join(queueDir || hookQueueDir(), `u-${sid}.json`);
}

/** Best-effort GC of stale per-session used-files (sessions end silently), plus
 * their `.lock` sidecars and any other stale queue lock — nothing else deletes
 * those, so without this they accumulate one per session forever. */
function rosterPruneUsed(queueDir = null) {
  const qd = queueDir || hookQueueDir();
  try {
    const now = Date.now();
    for (const fn of readdirSync(qd)) {
      if ((fn.startsWith("u-") && fn.endsWith(".json")) || fn.endsWith(".lock")) {
        const p = join(qd, fn);
        try {
          if (now - statSync(p).mtimeMs > ROSTER_USED_TTL * 1000) unlinkSync(p);
        } catch { /* raced away */ }
      }
    }
  } catch { /* dir absent */ }
}

/** Pick a free roster callsign for `baseType`, preferring `category`, and record
 * it in the per-session used-file so concurrent siblings never share a name.
 * Names deliberately RECYCLE across sessions (a stable crew, not a one-shot pool
 * — unlike the global hook ledger). Returns [name, category] or [null, null]. */
function rosterPick(roster, baseType, category, sessionId, queueDir = null) {
  const perBase = (roster.agents || {})[baseType];
  if (!isObj(perBase)) return [null, null];
  const cats = (hasOwn(perBase, category) ? [category] : [])
    .concat(Object.keys(perBase).filter((c) => c !== category).sort());
  rosterPruneUsed(queueDir);
  const upath = rosterUsedPath(sessionId, queueDir);
  mkdirSync(dirname(upath) || ".", { recursive: true });
  let picked = [null, null];
  withLedgerLock(upath, () => {
    let used = new Set();
    try {
      const data = JSON.parse(readFileSync(upath, "utf8"));
      if (isObj(data)) used = new Set((data.used || []).filter((n) => typeof n === "string"));
    } catch { /* fresh session */ }
    for (const c of cats) {
      const names = Array.isArray(perBase[c]) ? perBase[c] : [];
      for (const n of names) {
        if (typeof n === "string" && n && !used.has(n)) {
          used.add(n);
          const tmp = `${upath}.${process.pid}.tmp`;
          try { unlinkSync(tmp); } catch { /* not present */ }
          const fd = openSync(tmp, "wx");
          try {
            writeFileSync(fd, JSON.stringify({ used: [...used].sort(), ts: Date.now() / 1000 }));
            closeSync(fd);
            renameSync(tmp, upath);
          } catch (e) {
            try { closeSync(fd); } catch { /* already closed */ }
            try { unlinkSync(tmp); } catch { /* nothing to clean */ }
            throw e;
          }
          picked = [n, c];
          return;
        }
      }
    }
  });
  return picked;
}

/** Return a finished callsign to this session's free pool. Without it a session
 * could name only one crew's worth of dispatches per base — every later dispatch
 * fell back to the description-prefix namer even with the whole crew idle.
 * Returns the released name, or null when `agentType` is not one of our
 * callsigns or was not held. */
function rosterRelease(roster, agentType, sessionId, queueDir = null) {
  if (!isObj(roster) || typeof agentType !== "string") return null;
  if (!hasOwn(roster.files || {}, agentType)) return null;
  const upath = rosterUsedPath(sessionId, queueDir);
  if (!existsSync(upath)) return null;
  let released = null;
  withLedgerLock(upath, () => {
    let used;
    try {
      const data = JSON.parse(readFileSync(upath, "utf8"));
      used = isObj(data) ? (data.used || []).filter((n) => typeof n === "string") : [];
    } catch { return; }
    const i = used.indexOf(agentType);
    if (i < 0) return;
    used.splice(i, 1);
    const tmp = `${upath}.${process.pid}.tmp`;
    try { unlinkSync(tmp); } catch { /* not present */ }
    const fd = openSync(tmp, "wx");
    try {
      writeFileSync(fd, JSON.stringify({ used: used.sort(), ts: Date.now() / 1000 }));
      closeSync(fd);
      renameSync(tmp, upath);
    } catch (e) {
      try { closeSync(fd); } catch { /* already closed */ }
      try { unlinkSync(tmp); } catch { /* nothing to clean */ }
      throw e;
    }
    released = agentType;
  });
  return released;
}

/** SubagentStop handler for roster mode: release the finished agent's callsign.
 * Output-free (a SubagentStop output can block the subagent from stopping), so
 * it always returns null; the release itself is the side effect. */
function hookSubagentStop(event, roster = null, queueDir = null) {
  if (process.env.NAMED_SUBAGENTS_HOOK_DISABLE) return null;
  if (!isObj(event)) return null;
  const ros = roster !== null ? roster : loadRoster();
  rosterRelease(ros, event.agent_type, event.session_id, queueDir);
  return null;
}

/** PreToolUse handler for roster mode: rewrite `subagent_type` to a free roster
 * callsign so the live task tree shows the NAME. Persona delivery is the roster
 * agent file itself (no SubagentStart queue involved). Falls back to hookMutate
 * (description+prompt naming) when no roster covers the dispatch, and passes
 * through (null) anything already named. */
function hookRetype(event, roster = null, queueDir = null, ledgerPath = null) {
  if (process.env.NAMED_SUBAGENTS_HOOK_DISABLE) return null;
  if (!isObj(event) || !DISPATCH_TOOLS.has(event.tool_name)) return null;
  const ti = event.tool_input;
  if (!isObj(ti)) return null;
  const str = (v) => (typeof v === "string" ? v : "");
  const prompt = str(ti.prompt);
  const description = str(ti.description);
  const subagentType = str(ti.subagent_type);
  if (prompt.includes(PERSONA_SIG)) return null;  // CLI `assign` already named this
  const ros = roster !== null ? roster : loadRoster();
  if (ros && hasOwn(ros.files || {}, subagentType)) {
    return null;                        // already retyped (a re-fire), or caller
  }                                     // dispatched a roster persona directly
  const rosterNames = Object.keys((ros || {}).files || {}).sort();
  if (!ros || !hasOwn(ros.agents || {}, subagentType)) {
    return hookMutate(event, ledgerPath,           // unrostered -> legacy naming
      rosterNames.length ? rosterNames : null);
  }
  const { registry: reg } = loadWithConfig(null, null, false);
  const task = `${description}\n${prompt}`.trim();
  const cat = resolveForHook(reg, { role: subagentType || null, task: task || null });
  const [name, usedCat] = rosterPick(ros, subagentType, cat, event.session_id, queueDir);
  if (!name) {
    return hookMutate(event, ledgerPath,           // roster fully live this session
      rosterNames.length ? rosterNames : null);
  }
  const emoji = reg.emoji(hasOwn(reg.categories, usedCat) ? usedCat : "default");
  const updated = { ...ti };
  updated.subagent_type = name;
  updated.description = description ? `${emoji} ${description}`.trim() : `${emoji} ${name}`;
  return { hookEventName: "PreToolUse", updatedInput: updated };
}

/** Split a Claude Code agent .md into [frontmatterLines, body]. Frontmatter
 * lines come back verbatim MINUS `name:`/`description:` (the roster clone owns
 * those); no YAML parse, so unknown keys (tools, model, ...) survive untouched.
 * Returns [null, text] when there is no leading frontmatter block. */
function agentMdSplit(text) {
  if (!text.startsWith("---\n")) return [null, text];
  const end = text.indexOf("\n---\n", 4);
  if (end < 0) return [null, text];
  const kept = text.slice(4, end).split("\n")
    .filter((ln) => !/^(name|description)\s*:/.test(ln));
  return [kept, text.slice(end + 5)];
}

/** Render one roster agent definition file. */
function rosterAgentMd(name, baseType, category, reg, baseFm, baseBody) {
  const emoji = reg.emoji(category);
  const theme = reg.theme(category);
  const desc = `${emoji} Roster callsign of ${baseType} (named-subagents). `
    + `Prefer dispatching '${baseType}' — the roster hook routes to a free `
    + "callsign automatically.";
  const fm = ["---", `name: ${name}`, `description: "${desc}"`]
    .concat((baseFm || []).filter((ln) => ln.trim()));
  fm.push("---");
  const persona = personaPreamble(name, theme, null, false);
  const body = (baseBody || "").trim() || ROSTER_GENERIC_BODY.trim();
  return `${fm.join("\n")}\n<!-- ${ROSTER_MARKER} base=${baseType} category=${category} -->\n`
    + `${persona}\n${body}\n`;
}

/** Locate an existing definition for `baseType` to clone (its own tools/model/
 * body), searching the target dir then the user agents dir. Built-in types
 * (general-purpose, Explore, ...) have no file -> generic body. */
function rosterFindBaseFile(baseType, agentsDir) {
  for (const c of [join(agentsDir, `${baseType}.md`),
                   join(homedir(), ".claude", "agents", `${baseType}.md`)]) {
    if (isFileQuiet(c)) return c;
  }
  return null;
}

function cmdRoster(opts) {
  const action = opts._pos[0];
  if (!action || !["install", "status", "uninstall"].includes(action)) {
    die(action
      ? `argument roster: invalid choice: '${action}' (choose from 'install', 'status', 'uninstall')`
      : "roster: a subcommand is required (install|status|uninstall)");
  }
  const rpath = opts.state || rosterStatePath();
  if (action === "status") {
    const ros = loadRoster(rpath);
    if (!ros) { console.log(`no roster installed (manifest: ${rpath})`); return 0; }
    const adir = ros.dir || "?";
    console.log(`manifest:  ${rpath}\nagents dir: ${adir}`);
    let missing = 0;
    for (const base of Object.keys(ros.agents || {}).sort()) {
      const cats = ros.agents[base];
      const names = Object.values(cats).flat();
      console.log(`  ${base}: ${names.length} callsigns (${Object.keys(cats).sort().join(", ")})`);
    }
    for (const nm of Object.keys(ros.files || {}).sort()) {
      if (!isFileQuiet(join(adir, ros.files[nm]))) {
        console.log(`  ⚠ missing file for ${nm}: ${ros.files[nm]}`);
        missing += 1;
      }
    }
    return missing ? 1 : 0;
  }
  if (action === "uninstall") {
    const ros = loadRoster(rpath);
    if (!ros) { console.log(`no roster installed (manifest: ${rpath})`); return 0; }
    const adir = ros.dir || "";
    let removed = 0;
    for (const nm of Object.keys(ros.files || {}).sort()) {
      const p = join(adir, ros.files[nm]);
      let ours = false;
      try { ours = readFileSync(p, "utf8").includes(ROSTER_MARKER); } catch { continue; }
      if (ours) { unlinkSync(p); removed += 1; }   // never delete a file we didn't generate
    }
    try { unlinkSync(rpath); } catch { /* already gone */ }
    console.log(`removed ${removed} roster agent file(s) from ${adir} and the manifest`);
    return 0;
  }
  // install
  const { registry: reg } = regCfg(opts);
  const bases = [...new Set(opts.base && opts.base.length ? opts.base : ["general-purpose"])];
  const adirRaw = opts.dir || join(homedir(), ".claude", "agents");
  const adir = adirRaw.startsWith("~") ? join(homedir(), adirRaw.slice(1)) : adirRaw;
  const count = Math.max(1, parseIntStrict(opts.count, "count", 8));
  let cats;
  if (opts.categories) {
    cats = opts.categories.split(",").map((c) => c.trim()).filter(Boolean);
    const bad = cats.filter((c) => !hasOwn(reg.categories, c));
    if (bad.length) {
      console.error(`error: unknown categories: ${bad.join(", ")} `
        + "(see `named-subagents categories`)");
      return 1;
    }
  } else {
    cats = Object.keys(reg.categories).filter((c) => c !== "default");
  }
  mkdirSync(adir, { recursive: true });
  const led = new Ledger(null);         // ephemeral: cross-base draws never collide
  const manifest = { version: 1, dir: adir, agents: {}, files: {} };
  const written = [];
  for (const base of bases) {
    const src = rosterFindBaseFile(base, adir);
    let baseFm = null;
    let baseBody = null;
    if (src) [baseFm, baseBody] = agentMdSplit(readFileSync(src, "utf8"));
    const perBase = {};
    let drawn = 0;
    for (let i = 0; i < count; i++) {   // round-robin across categories
      const c = cats[i % cats.length];
      let nm;
      try { nm = stripGen(allocate(c, 1, reg, { ledger: led })[0]); }
      catch (e) { if (e instanceof PoolExhaustedError) continue; throw e; }
      const fp = join(adir, `${nm}.md`);
      if (existsSync(fp) && !opts.force) {
        let ours = false;
        try { ours = readFileSync(fp, "utf8").includes(ROSTER_MARKER); } catch { /* unreadable */ }
        if (!ours) {
          console.log(`  skip ${nm}: ${fp} exists and is not a roster file (--force to overwrite)`);
          continue;
        }
      }
      writeFileSync(fp, rosterAgentMd(nm, base, c, reg, baseFm, baseBody));
      (perBase[c] = perBase[c] || []).push(nm);
      manifest.files[nm] = `${nm}.md`;
      written.push(nm);
      drawn += 1;
    }
    manifest.agents[base] = perBase;
    const origin = src ? `cloned from ${src}` : "generic body (built-in base)";
    console.log(`${base}: ${drawn} callsign(s) [${origin}]`);
  }
  saveRoster(manifest, rpath);
  console.log(`\nwrote ${written.length} agent file(s) to ${adir}\nmanifest: ${rpath}\n`
    + "Next: `named-subagents hook install --roster`, then start a NEW Claude\n"
    + "Code session (agent definitions load at session start). Fan-outs will\n"
    + "show callsigns in the live task tree instead of the base agent type.\n"
    + "Note: each roster agent adds one line to the model's agent list — keep\n"
    + "the roster small (default 8/base).");
  return 0;
}

function cmdHookRun(argv = null) {
  // FAIL-OPEN: read the event on stdin, emit the hookSpecificOutput, ALWAYS exit
  // 0. Routing: `--capture` (the v0.4.3 PreToolUse registration) -> the output-free
  // task-queue capture; a SubagentStart event -> additionalContext (the primary,
  // clobber-proof path); anything else -> hookMutate (kept so a lingering legacy
  // PreToolUse registration still functions — new installs register capture +
  // SubagentStart). Any error -> emit nothing -> the dispatch runs with its
  // original input. A broken namer must never break a fan-out, and must never exit
  // non-zero (2 would block).
  try {
    const capture = (argv || []).includes("--capture");
    const retype = (argv || []).includes("--retype");
    const event = JSON.parse(readFileSync(0, "utf8"));
    const ev = isObj(event) ? event.hook_event_name : null;
    const out = capture ? hookPreCapture(event)
      : ev === "SubagentStop" ? hookSubagentStop(event)
      : ev === "SubagentStart" ? hookSubagentStart(event)
      : retype ? hookRetype(event) : hookMutate(event);
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

function hookCommand(capture = false) {
  // Absolute node + absolute cli.mjs path (robust against the bin not being on the
  // hook's PATH). `--managed-by` is a real (ignored) arg marker, not a shell comment.
  // `capture=true` is the v0.4.3 PreToolUse task-capture registration; the flag also
  // distinguishes it from a LEGACY (pre-0.4.2, mutate-path) PreToolUse entry.
  const cli = fileURLToPath(import.meta.url);
  const cap = capture ? " --capture" : "";
  return `"${process.execPath}" "${cli}" hook run${cap} --managed-by ${HOOK_MARKER}`;
}

/** True for the v0.4.3 PreToolUse task-capture registration (ours + --capture);
 * a marker'd PreToolUse entry with NEITHER flag is a legacy (pre-0.4.2) mutate hook. */
function isCaptureHook(h) {
  const cmd = isObj(h) ? h.command || "" : "";
  return cmd.includes(HOOK_MARKER) && cmd.includes("--capture");
}

/** The roster-mode registration (v0.5.0): a single PreToolUse entry whose
 * updatedInput rewrites `subagent_type` to a roster callsign. */
function hookCommandRetype() {
  const cli = fileURLToPath(import.meta.url);
  return `"${process.execPath}" "${cli}" hook run --retype --managed-by ${HOOK_MARKER}`;
}

/** The roster-mode SubagentStop registration: frees a finished callsign. */
function hookCommandRelease() {
  const cli = fileURLToPath(import.meta.url);
  return `"${process.execPath}" "${cli}" hook run --release --managed-by ${HOOK_MARKER}`;
}

/** True for the roster-mode SubagentStop registration (ours + --release). */
function isReleaseHook(h) {
  const cmd = isObj(h) ? h.command || "" : "";
  return cmd.includes(HOOK_MARKER) && cmd.includes("--release");
}

/** True for the v0.5.0 roster-mode PreToolUse registration (ours + --retype). */
function isRetypeHook(h) {
  const cmd = isObj(h) ? h.command || "" : "";
  return cmd.includes(HOOK_MARKER) && cmd.includes("--retype");
}

/** Register roster mode: ONE PreToolUse retype entry. Prunes our SubagentStart +
 * capture + legacy entries — roster mode replaces them (persona now travels in
 * the roster agent definition, so an SS namer would double-name). */
function hookInstallRoster(opts) {
  const sp = settingsPath(opts);
  const { data, error } = readSettings(sp);
  if (error) {
    console.error(`error: ${sp} is not valid settings JSON (${error}); refusing to modify it.`);
    return 1;
  }
  if (data.hooks === undefined) data.hooks = {};
  if (!isObj(data.hooks)) { console.error(`error: ${sp} has a non-object 'hooks'; refusing to modify.`); return 1; }
  const existed = existsSync(sp);
  let removed = 0;
  for (const ev of ["SubagentStart", "PreToolUse"]) {
    const [newList, n] = pruneOurHooks(data.hooks[ev], (h) => !isRetypeHook(h));
    if (n) { data.hooks[ev] = newList; removed += n; }
  }
  if (data.hooks.PreToolUse === undefined) data.hooks.PreToolUse = [];
  if (!Array.isArray(data.hooks.PreToolUse)) {
    console.error(`error: ${sp} has a non-list 'hooks.PreToolUse'; refusing to modify.`); return 1;
  }
  const cmd = hookCommandRetype();
  let refreshed = false;
  for (const [, h] of iterOurHooks(data.hooks.PreToolUse)) {
    h.command = cmd;
    refreshed = true;
    break;
  }
  if (!refreshed) {
    data.hooks.PreToolUse.push({ matcher: "Agent|Task",
      hooks: [{ type: "command", command: cmd }] });
  }
  if (data.hooks.SubagentStop === undefined) data.hooks.SubagentStop = [];
  if (!Array.isArray(data.hooks.SubagentStop)) {
    console.error(`error: ${sp} has a non-list 'hooks.SubagentStop'; refusing to modify.`); return 1;
  }
  const rcmd = hookCommandRelease();
  let relPresent = false;
  for (const [, h] of iterOurHooks(data.hooks.SubagentStop)) {
    h.command = rcmd;
    relPresent = true;
    break;
  }
  if (!relPresent) data.hooks.SubagentStop.push({ hooks: [{ type: "command", command: rcmd }] });
  writeSettings(sp, data, existed);
  const mig = removed
    ? `\n  replaced ${removed} auto-namer entr${removed === 1 ? "y" : "ies"} (roster mode supersedes them)`
    : "";
  const rosLine = loadRoster()
    ? ""
    : "\n  ⚠ no roster installed yet — run `named-subagents roster install` "
      + "(until then, dispatches fall back to description+prompt naming)";
  console.log(`installed the roster retype hook in ${sp}\n`
    + `  event: PreToolUse   matcher: Agent|Task\n  command: ${cmd}\n`
    + "  event: SubagentStop (frees a finished agent's callsign)\n"
    + `  command: ${rcmd}${mig}${rosLine}\n`
    + "New Claude Code sessions will dispatch fan-outs under roster callsigns —\n"
    + "visible in the live task tree. Verify with `named-subagents hook status`.");
  return 0;
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

/** Strip our marker'd hooks from a hooks-array (a `hooks.<event>` list),
 * preserving every unrelated block. Returns [newEntries, removedCount]. A
 * non-array input passes straight through (nothing to prune). `only` narrows
 * which of OUR hooks are removed (a predicate over the hook entry). */
function pruneOurHooks(entries, only = null) {
  if (!Array.isArray(entries)) return [entries, 0];
  const ours = (h) => isObj(h) && (h.command || "").includes(HOOK_MARKER)
    && (only === null || only(h));
  let removed = 0;
  const next = [];
  for (const m of entries) {
    if (!isObj(m) || !Array.isArray(m.hooks)) { next.push(m); continue; }   // not a hooks block
    const hs = m.hooks;
    const kept = hs.filter((h) => !ours(h));
    if (kept.length === hs.length) { next.push(m); continue; }              // nothing ours -> untouched
    removed += hs.length - kept.length;
    if (kept.length) next.push({ ...m, hooks: kept });                      // keep block with survivors
    // else: the block held ONLY our hook(s) -> drop the now-empty matcher block
  }
  return [next, removed];
}

function cmdHookInstall(opts) {
  if (opts.roster) return hookInstallRoster(opts);
  const sp = settingsPath(opts);
  const { data, error } = readSettings(sp);
  if (error) {
    console.error(`error: ${sp} is not valid settings JSON (${error}); refusing to modify it.\n`
      + "Fix or remove that file, then re-run `named-subagents hook install`.");
    return 1;
  }
  if (data.hooks === undefined) data.hooks = {};
  if (!isObj(data.hooks)) { console.error(`error: ${sp} has a non-object 'hooks'; refusing to modify.`); return 1; }
  if (data.hooks.SubagentStart === undefined) data.hooks.SubagentStart = [];
  if (!Array.isArray(data.hooks.SubagentStart)) {
    console.error(`error: ${sp} has a non-list 'hooks.SubagentStart'; refusing to modify.`); return 1;
  }
  if (data.hooks.PreToolUse === undefined) data.hooks.PreToolUse = [];
  if (!Array.isArray(data.hooks.PreToolUse)) {
    console.error(`error: ${sp} has a non-list 'hooks.PreToolUse'; refusing to modify.`); return 1;
  }
  const existed = existsSync(sp);
  const cmd = hookCommand();
  const capCmd = hookCommand(true);
  // v0.4.2 migration: strip any LEGACY PreToolUse auto-namer entry (marker, no
  // --capture) — that mutate path is clobber-prone (claude-code#15897/#39814).
  // The v0.4.3 task-capture entry is output-free and NOT exposed to the clobber;
  // it must survive this pruning, hence the `only` predicate.
  const [preNew, preRemoved] = pruneOurHooks(data.hooks.PreToolUse, (h) => !isCaptureHook(h));
  if (preRemoved) data.hooks.PreToolUse = preNew;
  // Switching back from roster mode: its SubagentStop release entry has no job here.
  const [stopNew, stopRemoved] = pruneOurHooks(data.hooks.SubagentStop);
  if (stopRemoved) data.hooks.SubagentStop = stopNew;
  const migrated = preRemoved ? " (migrated the legacy PreToolUse entry)" : "";
  let refreshed = false;
  for (const [, h] of iterOurHooks(data.hooks.SubagentStart)) {
    h.command = cmd;                    // refresh (e.g. new interpreter path); idempotent
    refreshed = true;
  }
  let capPresent = false;
  for (const [, h] of iterOurHooks(data.hooks.PreToolUse)) {
    h.command = capCmd;
    capPresent = true;
    break;
  }
  if (!capPresent) {
    data.hooks.PreToolUse.push({ matcher: "Agent|Task",
      hooks: [{ type: "command", command: capCmd }] });
  }
  if (refreshed) {
    writeSettings(sp, data, existed);
    console.log(`auto-namer hook already installed — refreshed the commands in ${sp}${migrated}`);
    return 0;
  }
  data.hooks.SubagentStart.push({ matcher: "*", hooks: [{ type: "command", command: cmd }] });
  writeSettings(sp, data, existed);
  const migLine = preRemoved ? "\n  migrated the legacy PreToolUse entry" : "";
  console.log(`installed the auto-namer hooks in ${sp}\n`
    + `  event: SubagentStart   matcher: *\n  command: ${cmd}\n`
    + `  event: PreToolUse     matcher: Agent|Task   (task capture, output-free)\n`
    + `  command: ${capCmd}${migLine}\n`
    + "New Claude Code sessions will nickname every subagent dispatch, themed by\n"
    + "its task when available (else by role).\n"
    + "Verify with `named-subagents hook status`.");
  return 0;
}

function cmdHookUninstall(opts) {
  const sp = settingsPath(opts);
  if (!existsSync(sp)) { console.log(`nothing to remove: ${sp} does not exist`); return 0; }
  const { data, error } = readSettings(sp);
  if (error) { console.error(`error: ${sp} is not valid JSON (${error}); refusing to modify.`); return 1; }
  if (!isObj(data.hooks)) { console.log(`no auto-namer hook found in ${sp}`); return 0; }
  // Remove our entries from every event we register on.
  let total = 0;
  for (const ev of ["SubagentStart", "PreToolUse", "SubagentStop"]) {
    const [newList, removed] = pruneOurHooks(data.hooks[ev]);
    if (removed) { data.hooks[ev] = newList; total += removed; }
  }
  if (total) {
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
  let legacy = false;
  let capture = false;
  let retype = false;
  const hk = isObj(data.hooks) ? data.hooks : {};
  for (const [, h] of iterOurHooks(hk.SubagentStart || [])) { installed = true; cmd = h.command; }
  let release = false;
  for (const [, h] of iterOurHooks(hk.SubagentStop || [])) if (isReleaseHook(h)) release = true;
  for (const [, h] of iterOurHooks(hk.PreToolUse || [])) {
    if (isCaptureHook(h)) { capture = true; continue; }   // the v0.4.3 task-capture entry
    if (isRetypeHook(h)) {               // the v0.5.0 roster-mode entry
      retype = true;
      if (!installed) cmd = h.command;
      continue;
    }
    legacy = true;                       // a pre-0.4.2 (clobber-prone) registration lingers
    if (!installed) cmd = h.command;
  }
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
      ledger_path: lp, ledger_exists: ledExists, total_allocated: allocated,
      disabled, legacy_pretooluse: legacy, capture_installed: capture,
      retype_installed: retype, release_installed: release, roster_path: rosterStatePath(),
      roster_installed: !!loadRoster(),
    }, { indent: 2 }));
    return 0;
  }
  console.log(`settings:   ${sp}${error ? "  ⚠ MALFORMED JSON" : ""}`);
  const mode = retype
    ? "yes  (roster mode — PreToolUse retype: callsigns in the live task tree)"
    : installed ? "yes  (event: SubagentStart)" : "no";
  console.log(`installed:  ${mode}`);
  if (retype) {
    const ros = loadRoster();
    console.log(`  roster:   ${rosterStatePath()}  `
      + `(${ros ? "installed" : "⚠ NOT installed — run `named-subagents roster install`"})`);
    console.log("  release:  " + (release ? "yes  (SubagentStop frees finished callsigns)"
      : "⚠ no — callsigns are never freed within a session; re-run `hook install --roster`"));
    if (installed || capture) {
      console.log("  ⚠ mixed:  auto-namer entries are also present — "
        + "re-run `hook install --roster` to prune them");
    }
  }
  if (cmd) console.log(`  command:  ${cmd}`);
  if (installed) {
    console.log(`  capture:  ${capture
      ? "yes  (PreToolUse task capture — task-themed nicknames)"
      : "no  (role-themed only; re-run `hook install` to enable task theming)"}`);
  }
  if (legacy) {
    console.log("  ⚠ legacy:  a pre-0.4.2 PreToolUse entry is still present (clobber-prone);"
      + " re-run `hook install` to migrate it, or `hook uninstall` to clear it");
  }
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
  roster: cmdRoster,
};

function main() {
  const raw = process.argv.slice(2);
  // FAIL-OPEN fast path: `hook run` must NEVER exit non-zero on ANY argv. parseArgs
  // die()s (process.exit(2)) on a trailing valueless flag, and exit 2 would BLOCK the
  // dispatch — the one thing the contract forbids. Route it straight to the handler.
  if (raw[0] === "hook" && raw[1] === "run") return cmdHookRun(raw.slice(2));
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
