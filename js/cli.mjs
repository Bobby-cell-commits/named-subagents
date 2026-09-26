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
const BOOL_FLAGS = new Set(["json", "avoid-installed", "bio-in-prompt", "version", "cwd-config", "no-cwd-config", "explain", "cwd", "force", "roster", "dry-run", "quiet"]);
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
      // `hook install --name` is a switch; everywhere else --name takes a value
      // (release/retire/unretire --name NAME).
      if (BOOL_FLAGS.has(key) || (key === "name" && cmd === "hook")) {
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
  let nameMode = false;
  for (const [, h] of iterOurHooks(sh.PreToolUse || [])) {
    if (isCaptureHook(h)) capture = true;       // the v0.4.3 task-capture entry, NOT legacy
    else if (isNameHook(h)) nameMode = true;    // name mode (or a 0.5/0.6 retype entry it now runs)
    else legacy = true;
  }
  const firstSS = iterOurHooks(sh.SubagentStart || []).next().value;
  if (firstSS && isNameHook(firstSS[1])) hooked = false;   // name mode's own SubagentStart entry
  if (nameMode) {
    const missing = NAME_EVENTS.filter((ev) => ![...iterOurHooks(sh[ev] || [])].some(([, h]) => isNameHook(h)));
    add("INFO", "hook-install",
      `name mode in ${sp}`
      + (missing.length ? `  ⚠ partial: not registered on ${missing.join(", ")} (no identity/release/`
        + "alerts there) — re-run `hook install --name`" : "")
      + ((hooked || capture) ? "  ⚠ auto-namer entries also present — re-run `hook install --name`" : ""));
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
    try {
      add(...nameSelftest());
    } catch (e) {
      add("FAIL", "name-selftest", `${e.name}: ${e.message}`);
    }
  }

  return checks;
}

/** Run the name-mode chain (PreToolUse -> SubagentStart -> SubagentStop -> Stop)
 * against throwaway state, then once more with the name dropped, so the alert
 * path is proven to fire. Returns [status, check, detail]. Mirrors the Python
 * _name_selftest. */
function nameSelftest() {
  const hd = mkdtempSync(join(tmpdir(), "ns-name-"));
  const qd = join(hd, "q");
  const led = join(hd, "led.json");
  const tx = join(hd, "sess.jsonl");
  const prev = process.env.NAMED_SUBAGENTS_SESSIONS_DIR;
  process.env.NAMED_SUBAGENTS_SESSIONS_DIR = join(hd, "none");
  let r1;
  let r2;
  try {
    const chain = (aid, metaName) => {
      const pre = hookName({ hook_event_name: "PreToolUse", tool_name: "Agent",
        session_id: "selftest", tool_use_id: `t-${aid}`,
        tool_input: { description: "security audit", prompt: "Audit auth.",
          subagent_type: "general-purpose" } }, qd, led);
      const nm = pre.hookSpecificOutput.updatedInput.name;
      const st = hookName({ hook_event_name: "SubagentStart", session_id: "selftest",
        agent_id: aid, agent_type: "general-purpose", transcript_path: tx }, qd);
      const mp = join(hd, "sess", "subagents", `agent-${aid}.meta.json`);
      mkdirSync(dirname(mp), { recursive: true });
      const meta = { toolUseId: `t-${aid}` };
      if (metaName) meta.name = nm;
      writeFileSync(mp, JSON.stringify(meta));
      hookName({ hook_event_name: "SubagentStop", session_id: "selftest", agent_id: aid,
        agent_type: "general-purpose", transcript_path: tx }, qd);
      const alert = hookName({ hook_event_name: "Stop", session_id: "selftest" }, qd);
      const ctx = ((st || {}).hookSpecificOutput || {}).additionalContext || "";
      const live = liveNames(readBindings(bindingsPath("selftest", qd)), readQueue(queuePath("selftest", qd)));
      return { nm, ctx, alert, live };
    };
    r1 = chain("ok", true);
    r2 = chain("drop", false);
  } finally {
    if (prev === undefined) delete process.env.NAMED_SUBAGENTS_SESSIONS_DIR;
    else process.env.NAMED_SUBAGENTS_SESSIONS_DIR = prev;
    rmSync(hd, { recursive: true, force: true });
  }
  const ok = !!r1.nm && r1.ctx.includes(`\`[${r1.nm}]\``) && r1.alert === null && r1.live.size === 0;
  const ok2 = !!r2.alert && (r2.alert.systemMessage || "").includes(r2.nm);
  if (ok && ok2) {
    return ["PASS", "name-selftest",
      "name mode picks a name, injects its identity, releases it, and alerts on a dropped name"];
  }
  return ["FAIL", "name-selftest",
    `unexpected: name=${JSON.stringify(r1.nm)} alert=${JSON.stringify(r1.alert)} `
    + `live=${JSON.stringify([...r1.live].sort())} drop-alert=${JSON.stringify(r2.alert)}`];
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
    ? `${emoji} ${nickname} · ${description}`.trim()
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

// ---- name mode (v0.7.0): visible names via the Agent tool's `name` field --- //
// A PreToolUse `updatedInput` that sets `name` makes the live task tree's left
// column show that name (verified CC 2.1.283). It costs the main prompt nothing,
// unlike the v0.5/0.6 roster agent files. `name` is also the SendMessage /
// ListAgents address, so two LIVE agents must never share one. Mirrors the Python
// port (named_subagents/cli.py) — see the comments there for the event-pairing
// and resume rationale.
const ROSTER_MARKER = "named-subagents-roster v1";   // sentinel in 0.5/0.6 agent files
const STATE_TTL = 48 * 3600.0;                       // per-session state GC horizon
const DEFAULT_ROLE = "general-purpose";              // CC's type when subagent_type is omitted
const NAME_EVENTS = ["PreToolUse", "SubagentStart", "SubagentStop", "Stop"];

/** Where a 0.5/0.6 roster manifest lives (read only by `roster status|uninstall`
 * and doctor, to clean up or recognise leftover files). */
function rosterStatePath() {
  const env = process.env.NAMED_SUBAGENTS_ROSTER;
  if (env) return env;
  const base = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
  return join(base, "named-subagents", "roster.json");
}

/** Manifest object or null (malformed/missing -> null, never a crash). */
function loadRoster(path = null) {
  const p = path || rosterStatePath();
  if (!existsSync(p)) return null;
  let data;
  try { data = JSON.parse(readFileSync(p, "utf8")); } catch { return null; }
  if (!isObj(data) || !isObj(data.agents)) return null;
  if (!isObj(data.files)) data.files = {};
  return data;
}

function sessionFile(prefix, ext, sessionId, queueDir = null) {
  let sid = typeof sessionId === "string" ? sessionId : "";
  sid = sid.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 80) || "nosession";
  return join(queueDir || hookQueueDir(), `${prefix}-${sid}${ext}`);
}
const bindingsPath = (sid, qd = null) => sessionFile("b", ".json", sid, qd);
const alertsPath = (sid, qd = null) => sessionFile("a", ".jsonl", sid, qd);

/** Best-effort GC of per-session state older than STATE_TTL (sessions end
 * silently): binding and alert files, stale `.lock` files, and the u-/n- files
 * the 0.5/0.6 roster mode left behind. */
function pruneState(queueDir = null) {
  const qd = queueDir || hookQueueDir();
  try {
    const now = Date.now();
    for (const fn of readdirSync(qd)) {
      if ((/^[bun]-/.test(fn) && fn.endsWith(".json"))
          || (fn.startsWith("a-") && fn.endsWith(".jsonl")) || fn.endsWith(".lock")) {
        const p = join(qd, fn);
        try { if (now - statSync(p).mtimeMs > STATE_TTL * 1000) unlinkSync(p); } catch { /* raced away */ }
      }
    }
  } catch { /* dir absent */ }
}

function readJson(path, fallback) {
  try {
    const d = JSON.parse(readFileSync(path, "utf8"));
    return (Array.isArray(fallback) ? Array.isArray(d) : isObj(d)) ? d : fallback;
  } catch { return fallback; }
}

function writeAtomic(path, text) {
  const tmp = `${path}.${process.pid}.tmp`;
  try { unlinkSync(tmp); } catch { /* not present */ }
  const fd = openSync(tmp, "wx");
  try {
    writeFileSync(fd, text);
    closeSync(fd);
    renameSync(tmp, path);
  } catch (e) {
    try { closeSync(fd); } catch { /* already closed */ }
    try { unlinkSync(tmp); } catch { /* nothing to clean */ }
    throw e;
  }
}

/** Unexpired queue entries (orphans older than QUEUE_TTL_SECONDS dropped). */
function readQueue(qpath) {
  let lines;
  try { lines = readFileSync(qpath, "utf8").split("\n"); } catch { return []; }
  const now = Date.now() / 1000;
  const out = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (isObj(e) && now - (Number(e.ts) || 0) <= QUEUE_TTL_SECONDS) out.push(e);
  }
  return out;
}

function writeQueue(qpath, entries) {
  if (!entries.length) { try { unlinkSync(qpath); } catch { /* already gone */ } return; }
  writeAtomic(qpath, entries.map((e) => JSON.stringify(e) + "\n").join(""));
}

function readBindings(bpath) {
  const agents = readJson(bpath, {}).agents;
  if (!isObj(agents)) return {};
  return Object.fromEntries(Object.entries(agents).filter(([, v]) => isObj(v)));
}

/** Names held by live agents plus names queued for a Start that hasn't fired. */
function liveNames(bindings, queue) {
  const names = new Set();
  for (const r of Object.values(bindings)) if (r.live && typeof r.name === "string" && r.name) names.add(r.name);
  for (const e of queue) if (!e.skip && typeof e.name === "string" && e.name) names.add(e.name);
  return names;
}

/** Titles of local Claude Code sessions (~/.claude/sessions/<pid>.json `name`);
 * they share SendMessage's address space with subagent names. */
function peerSessionTitles() {
  const d = process.env.NAMED_SUBAGENTS_SESSIONS_DIR || join(homedir(), ".claude", "sessions");
  const titles = new Set();
  let entries;
  try { entries = readdirSync(d); } catch { return titles; }
  for (const fn of entries) {
    if (!fn.endsWith(".json")) continue;
    const p = join(d, fn);
    try {
      const st = statSync(p);
      if (!st.isFile() || st.size > 65536) continue;
    } catch { continue; }
    const t = readJson(p, {}).name;
    if (typeof t === "string" && t) titles.add(t);
  }
  return titles;
}

/** PreToolUse: pick a name unique among the session's live agents; emit it in
 * `name` plus the `<emoji> Name · task` label. The prompt is untouched (identity
 * arrives via SubagentStart). A model-supplied `name` and a CLI-assigned dispatch
 * pass through but are still queued, so pairing with SubagentStart stays in step. */
function namePre(event, queueDir = null, ledgerPath = null) {
  if (!isObj(event) || !DISPATCH_TOOLS.has(event.tool_name)) return null;
  const ti = event.tool_input;
  if (!isObj(ti)) return null;
  const str = (v) => (typeof v === "string" ? v : "");
  const prompt = str(ti.prompt);
  const description = str(ti.description);
  const role = str(ti.subagent_type) || DEFAULT_ROLE;
  const given = str(ti.name).trim();
  const { registry: reg } = loadWithConfig(null, null, false);
  const entry = { role, ts: Date.now() / 1000 };
  if (typeof event.tool_use_id === "string" && event.tool_use_id) {
    entry.tuid = event.tool_use_id;       // == meta.json toolUseId: SubagentStop's exact key
  }
  if (given) {
    entry.name = given;
    entry.own = false;
  } else if (prompt.includes(PERSONA_SIG) || (!prompt && description
      && Object.keys(reg.categories).some((c) => description.startsWith(reg.emoji(c))))) {
    entry.skip = true;
  } else {
    entry.category = resolveForHook(reg, { role, task: `${description}\n${prompt}`.trim() || null });
  }
  const sid = event.session_id;
  const qpath = queuePath(sid, queueDir);
  mkdirSync(dirname(qpath) || ".", { recursive: true });
  pruneState(queueDir);
  withLedgerLock(qpath, () => {
    const queue = readQueue(qpath);
    const live = liveNames(readBindings(bindingsPath(sid, queueDir)), queue);
    if (given && live.has(given)) {
      recordAlert(sid, queueDir, `named-subagents: the model dispatched a new agent named ${given}, `
        + `but a live agent already holds that name — SendMessage(to: ${given}) will reach `
        + "only the newest.");
    }
    if (entry.category !== undefined) {
      try {
        const avoid = new Set(live);
        for (const t of peerSessionTitles()) avoid.add(t);
        for (const t of installedAgentNames()) avoid.add(t);   // a name must not read as an agent type
        const lp = ledgerPath !== null ? ledgerPath : hookLedgerPath();
        if (lp) mkdirSync(dirname(lp), { recursive: true });
        const drawn = withLedgerLock(lp, () => {
          const led = new Ledger(lp);
          const n = allocate(entry.category, 1, reg, { ledger: led, avoid: [...avoid] })[0];
          led.save();
          return n;
        });
        entry.name = stripGen(drawn);
        entry.own = true;
      } catch (e) { // recorded + shown; the dispatch runs unnamed
        // Queue a placeholder anyway: SubagentStart fires for this dispatch
        // regardless, and a missing entry would shift every later sibling by one.
        delete entry.category;
        entry.skip = true;
        recordAlert(sid, queueDir, `named-subagents: could not pick a name for a ${role} dispatch `
          + `(${(e && e.name) || "Error"}: ${(e && e.message) || e}); it ran unnamed.`);
      }
    }
    queue.push(entry);
    writeQueue(qpath, queue);
  });
  if (!entry.own) return null;
  const updated = { ...ti };
  if (!process.env.NAMED_SUBAGENTS_FAULT_DROP_NAME) updated.name = entry.name;   // break-it-on-purpose switch
  const emoji = reg.emoji(hasOwn(reg.categories, entry.category) ? entry.category : "default");
  updated.description = description
    ? `${emoji} ${entry.name} · ${description}`.trim()
    : `${emoji} ${entry.name}`;
  return { hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: updated } };
}

/** SubagentStart: bind the oldest queued dispatch of this role to agent_id and
 * inject the identity block. A known agent_id is a SendMessage resume: mark it
 * live again, inject nothing, leave the queue alone. */
function nameStart(event, queueDir = null) {
  const aid = event.agent_id;
  if (typeof aid !== "string" || !aid) return null;
  const atype = typeof event.agent_type === "string" && event.agent_type ? event.agent_type : DEFAULT_ROLE;
  const sid = event.session_id;
  const qpath = queuePath(sid, queueDir);
  const bpath = bindingsPath(sid, queueDir);
  mkdirSync(dirname(qpath) || ".", { recursive: true });
  let entry = null;
  withLedgerLock(qpath, () => {
    const bindings = readBindings(bpath);
    if (hasOwn(bindings, aid)) {
      Object.assign(bindings[aid], { live: true, ts: Date.now() / 1000 });
      writeAtomic(bpath, JSON.stringify({ agents: bindings }));
      return;
    }
    // CC writes meta.json just after an agent's FIRST SubagentStart, so a Start
    // that finds it is a resume of an agent we never bound: take its name from
    // meta.json, never the queue.
    const mp = metaPath(event, aid);
    if (mp && isFileQuiet(mp)) {
      const meta = readJson(mp, {});
      if (typeof meta.name === "string" && meta.name) {
        bindings[aid] = { name: meta.name, live: true, own: false, category: null,
          tuid: typeof meta.toolUseId === "string" ? meta.toolUseId : null, ts: Date.now() / 1000 };
        writeAtomic(bpath, JSON.stringify({ agents: bindings }));
      }
      return;
    }
    const queue = readQueue(qpath);
    const idx = queue.findIndex((e) => e.role === atype);
    if (idx < 0) return;
    const e = queue.splice(idx, 1)[0];
    writeQueue(qpath, queue);
    if (e.skip || typeof e.name !== "string") return;
    bindings[aid] = { name: e.name, live: true, own: !!e.own,
      category: e.category === undefined ? null : e.category,
      tuid: e.tuid === undefined ? null : e.tuid, ts: Date.now() / 1000 };
    writeAtomic(bpath, JSON.stringify({ agents: bindings }));
    entry = e;
  });
  if (!entry || !entry.own) return null;
  const { registry: reg } = loadWithConfig(null, null, false);
  const cat = hasOwn(reg.categories, entry.category) ? entry.category : "default";
  const bio = process.env.NAMED_SUBAGENTS_HOOK_BIO ? reg.bio(entry.category, entry.name) : null;
  const context = personaPreamble(entry.name, reg.theme(cat), bio, false);
  return { hookSpecificOutput: { hookEventName: "SubagentStart", additionalContext: context } };
}

/** The subagent's meta.json: next to agent_transcript_path, else derived from
 * the session transcript_path. */
function metaPath(event, aid) {
  const atp = event.agent_transcript_path;
  if (typeof atp === "string" && atp.endsWith(".jsonl")) return atp.slice(0, -6) + ".meta.json";
  const tp = event.transcript_path;
  if (typeof tp === "string" && tp.endsWith(".jsonl")) {
    return join(tp.slice(0, -6), "subagents", `agent-${aid}.meta.json`);
  }
  return null;
}

/** Queue an alert for the main agent's Stop hook to show (nameMainStop). */
function recordAlert(sessionId, queueDir, msg) {
  appendFileSync(alertsPath(sessionId, queueDir), JSON.stringify({ msg, ts: Date.now() / 1000 }) + "\n");
}

/** SubagentStop: release by agent_id (a not-live agent is a no-op), then check it
 * against meta.json, whose `toolUseId` is the dispatch's PreToolUse tool_use_id.
 * A differing toolUseId means Start paired the wrong entry: swap back with the
 * live agent that holds it, else drop this agent's own (still-queued) entry.
 * Alerts are RECORDED for the main Stop (CC drops SubagentStop systemMessage).
 * Mirrors the Python _name_stop. Always returns null. */
function nameStop(event, queueDir = null) {
  const aid = event.agent_id;
  if (typeof aid !== "string" || !aid) return null;
  const sid = event.session_id;
  const qpath = queuePath(sid, queueDir);
  const bpath = bindingsPath(sid, queueDir);
  if (!existsSync(bpath)) return null;
  withLedgerLock(qpath, () => {
    const bindings = readBindings(bpath);
    const rec = bindings[aid];
    if (!hasOwn(bindings, aid) || !rec.live) return;
    const told = rec.name;
    const mp = metaPath(event, aid);
    const meta = mp && isFileQuiet(mp) ? readJson(mp, {}) : null;
    const got = meta && typeof meta.name === "string" && meta.name ? meta.name : null;
    const mt = meta ? meta.toolUseId : null;
    let alert = null;
    if (typeof mt === "string" && mt && rec.tuid && mt !== rec.tuid) {
      const other = Object.entries(bindings)
        .find(([k, r]) => k !== aid && r.live && r.tuid === mt);
      if (other) {
        const keys = ["name", "own", "category", "tuid"];
        const mine = Object.fromEntries(keys.map((k) => [k, rec[k] === undefined ? null : rec[k]]));
        for (const k of keys) rec[k] = other[1][k] === undefined ? null : other[1][k];
        Object.assign(other[1], mine);
      } else {
        writeQueue(qpath, readQueue(qpath).filter((e) => e.tuid !== mt));
      }
      alert = `named-subagents: identity mix-up — the agent shown as ${got || rec.name} `
        + `was told it is ${told}. Its [Name] report line will not match the tree.`;
    } else if (meta === null) {
      alert = `named-subagents: cannot verify ${told}'s name — its meta.json is `
        + `missing (${mp || "no transcript path in the SubagentStop event"}). `
        + "Claude Code may have changed how it records subagents.";
    } else if (got === null) {
      alert = `named-subagents: ${told} was dispatched with \`name\` but Claude Code `
        + "did not record it — the task tree likely showed the agent type instead. "
        + "`name` may no longer be honored; the label still carries the name.";
    } else if (got !== told) {
      alert = `named-subagents: identity mix-up — the agent shown as ${got} was told `
        + `it is ${told}. Its [Name] report line will not match the tree.`;
    }
    Object.assign(rec, { live: false, ts: Date.now() / 1000 });
    writeAtomic(bpath, JSON.stringify({ agents: bindings }));
    if (alert) recordAlert(sid, queueDir, alert);
  });
  return null;
}

/** Main-agent Stop: show the session's recorded alerts as one systemMessage,
 * then clear them. */
function nameMainStop(event, queueDir = null) {
  const sid = event.session_id;
  const apath = alertsPath(sid, queueDir);
  if (!existsSync(apath)) return null;
  let lines = null;
  withLedgerLock(queuePath(sid, queueDir), () => {
    try {
      lines = readFileSync(apath, "utf8").split("\n");
      unlinkSync(apath);
    } catch { lines = null; }
  });
  if (!lines) return null;
  const msgs = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    let m;
    try { m = JSON.parse(line).msg; } catch { continue; }
    if (typeof m === "string" && m && !msgs.includes(m)) msgs.push(m);
  }
  return msgs.length ? { systemMessage: msgs.join("\n") } : null;
}

/** `hook run --name`: route one hook event; returns the full hook output object. */
function hookName(event, queueDir = null, ledgerPath = null) {
  if (process.env.NAMED_SUBAGENTS_HOOK_DISABLE || !isObj(event)) return null;
  const ev = event.hook_event_name;
  if (ev === "SubagentStart") return nameStart(event, queueDir);
  if (ev === "SubagentStop") return nameStop(event, queueDir);
  if (ev === "Stop") return nameMainStop(event, queueDir);
  return namePre(event, queueDir, ledgerPath);
}

/** [agentsDir, paths] of 0.5/0.6 roster agent files still on disk: manifest-listed
 * files carrying the roster marker, else (no manifest for that dir) every *.md in
 * the agents dir that carries it. Never returns a file we didn't write. */
function rosterLeftovers(adirArg = null) {
  const ros = loadRoster();
  const adir = adirArg || (ros || {}).dir || join(homedir(), ".claude", "agents");
  let cands = [];
  if (ros && adir === ros.dir) {
    cands = Object.values(ros.files || {}).sort().map((rel) => join(adir, rel));
  } else {
    try { cands = readdirSync(adir).filter((f) => f.endsWith(".md")).sort().map((f) => join(adir, f)); }
    catch { cands = []; }
  }
  const found = [];
  for (const p of cands) {
    try { if (readFileSync(p, "utf8").slice(0, 8192).includes(ROSTER_MARKER)) found.push(p); }
    catch { /* unreadable */ }
  }
  return [adir, found];
}

/** Roster mode was removed in 0.7.0. What remains is the migration: `status`
 * lists leftover roster files, `uninstall` deletes them and the manifest, and
 * `ensure` is a silent no-op so a stale SessionStart registration never fails. */
function cmdRoster(opts) {
  const action = opts._pos[0];
  if (!action || !["status", "uninstall", "ensure"].includes(action)) {
    die(action
      ? `argument roster_cmd: invalid choice: '${action}' (choose from 'status', 'uninstall')`
      : "roster: a subcommand is required (status|uninstall)");
  }
  if (opts.state) process.env.NAMED_SUBAGENTS_ROSTER = opts.state;
  const rpath = opts.state || rosterStatePath();
  if (action === "ensure") return 0;
  const [adir, files] = rosterLeftovers(opts.dir || null);
  if (action === "status") {
    if (!files.length) { console.log(`no roster agent files in ${adir} — nothing to migrate`); return 0; }
    console.log(`${files.length} leftover roster agent file(s) in ${adir} `
      + "(roster mode was removed in 0.7.0):");
    for (const p of files) console.log(`  ${p.split(/[\\/]/).pop()}`);
    console.log("Remove them with `named-subagents roster uninstall` (add --dry-run to preview).");
    return 1;
  }
  const dry = !!opts["dry-run"];
  for (const p of files) {
    if (dry) console.log(`would remove ${p}`);
    else unlinkSync(p);
  }
  if (dry) {
    console.log(`dry run: ${files.length} roster agent file(s) in ${adir}`
      + (existsSync(rpath) ? `; manifest ${rpath}` : ""));
    return 0;
  }
  try { unlinkSync(rpath); } catch { /* already gone */ }
  console.log(`removed ${files.length} roster agent file(s) from ${adir} and the manifest. `
    + "Start a new Claude Code session so its agent list drops them.");
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
    const args = argv || [];
    const capture = args.includes("--capture");
    // --retype/--release are the 0.5/0.6 roster registrations; they now run name
    // mode, so a lingering settings.json install keeps naming.
    const nameMode = ["--name", "--retype", "--release"].some((f) => args.includes(f));
    const event = JSON.parse(readFileSync(0, "utf8"));
    const ev = isObj(event) ? event.hook_event_name : null;
    if (nameMode) {
      const top = hookName(event);
      if (top !== null) process.stdout.write(pyDumps(top));
      return 0;
    }
    const out = capture ? hookPreCapture(event)
      : ev === "SubagentStop" ? null                  // only name mode acts on SubagentStop
      : ev === "SubagentStart" ? hookSubagentStart(event)
      : hookMutate(event);
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

/** The name-mode registration (v0.7.0): the same command on every NAME_EVENTS
 * event; `hook run --name` routes by event. */
function hookCommandName() {
  const cli = fileURLToPath(import.meta.url);
  return `"${process.execPath}" "${cli}" hook run --name --managed-by ${HOOK_MARKER}`;
}

/** True for a name-mode registration (ours + --name), or a 0.5/0.6 roster one
 * (--retype/--release), which `hook run` now also routes to name mode. */
function isNameHook(h) {
  const cmd = isObj(h) ? h.command || "" : "";
  return cmd.includes(HOOK_MARKER) && ["--name", "--retype", "--release"].some((f) => cmd.includes(f));
}

/** Register name mode: one `hook run --name` entry on each of NAME_EVENTS
 * (PreToolUse matched to Agent|Task). Prunes every other entry of ours. */
function hookInstallName(opts) {
  const sp = settingsPath(opts);
  const { data, error } = readSettings(sp);
  if (error) {
    console.error(`error: ${sp} is not valid settings JSON (${error}); refusing to modify it.`);
    return 1;
  }
  if (data.hooks === undefined) data.hooks = {};
  if (!isObj(data.hooks)) { console.error(`error: ${sp} has a non-object 'hooks'; refusing to modify.`); return 1; }
  for (const ev of NAME_EVENTS) {
    if (data.hooks[ev] === undefined) data.hooks[ev] = [];
    if (!Array.isArray(data.hooks[ev])) {
      console.error(`error: ${sp} has a non-list 'hooks.${ev}'; refusing to modify.`); return 1;
    }
  }
  const existed = existsSync(sp);
  const cmd = hookCommandName();
  let removed = 0;
  for (const ev of NAME_EVENTS) {
    const [newList, n] = pruneOurHooks(data.hooks[ev]);
    data.hooks[ev] = newList;
    removed += n;
    const block = { hooks: [{ type: "command", command: cmd }] };
    data.hooks[ev].push(ev === "PreToolUse" ? { matcher: "Agent|Task", ...block } : block);
  }
  writeSettings(sp, data, existed);
  const mig = removed ? `\n  replaced ${removed} earlier entr${removed === 1 ? "y" : "ies"} of ours` : "";
  const [, left] = rosterLeftovers();
  const leftLine = left.length
    ? `\n  ⚠ ${left.length} roster agent file(s) from 0.5/0.6 remain — remove them `
      + "with `named-subagents roster uninstall`"
    : "";
  console.log(`installed name mode in ${sp}\n`
    + "  events: PreToolUse (Agent|Task), SubagentStart, SubagentStop, Stop\n"
    + `  command: ${cmd}${mig}${leftLine}\n`
    + "New Claude Code sessions will show each subagent's name in the live task tree.\n"
    + "Verify with `named-subagents hook status`.");
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
  if (opts.name || opts.roster) return hookInstallName(opts);
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
  for (const ev of ["SubagentStop", "Stop"]) {   // name mode's release + alert entries
    const [evNew, evRemoved] = pruneOurHooks(data.hooks[ev]);
    if (evRemoved) data.hooks[ev] = evNew;
  }
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
  for (const ev of ["SubagentStart", "PreToolUse", "SubagentStop", "Stop"]) {
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
  const hk = isObj(data.hooks) ? data.hooks : {};
  const nameEvents = NAME_EVENTS.filter((ev) => [...iterOurHooks(hk[ev] || [])].some(([, h]) => isNameHook(h)));
  const nameMode = nameEvents.includes("PreToolUse");
  for (const [, h] of iterOurHooks(hk.SubagentStart || [])) {
    if (!isNameHook(h)) { installed = true; cmd = h.command; }
  }
  for (const [, h] of iterOurHooks(hk.PreToolUse || [])) {
    if (isCaptureHook(h)) capture = true;          // the v0.4.3 task-capture entry
    else if (isNameHook(h)) cmd = h.command;       // name mode (or a 0.5/0.6 retype entry)
    else {
      legacy = true;                               // a pre-0.4.2 (clobber-prone) registration lingers
      if (!installed) cmd = h.command;
    }
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
  const [adir, leftovers] = rosterLeftovers();
  if (opts.json) {
    console.log(pyDumps({
      settings_path: sp, settings_malformed: !!error, installed, command: cmd,
      ledger_path: lp, ledger_exists: ledExists, total_allocated: allocated,
      disabled, legacy_pretooluse: legacy, capture_installed: capture,
      name_installed: nameMode, name_events: nameEvents, roster_leftover_files: leftovers.length,
    }, { indent: 2 }));
    return 0;
  }
  console.log(`settings:   ${sp}${error ? "  ⚠ MALFORMED JSON" : ""}`);
  const mode = nameMode
    ? "yes  (name mode — names in the live task tree)"
    : installed ? "yes  (event: SubagentStart)" : "no";
  console.log(`installed:  ${mode}`);
  if (nameMode && nameEvents.length < NAME_EVENTS.length) {
    console.log(`  ⚠ partial: name mode is registered only on ${nameEvents.join(", ")} `
      + `(identity, release and alerts need all ${NAME_EVENTS.length}) — re-run \`hook install --name\``);
  }
  if (nameMode && (installed || capture)) {
    console.log("  ⚠ mixed:  auto-namer entries are also present — "
      + "re-run `hook install --name` to prune them");
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
  if (leftovers.length) {
    console.log(`  ⚠ roster: ${leftovers.length} agent file(s) from 0.5/0.6 remain in ${adir} `
      + "— `named-subagents roster uninstall` removes them");
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
