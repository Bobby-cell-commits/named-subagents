/**
 * named_subagents — themed, non-repeating nicknames for Claude Code subagents.
 *
 * JS/ESM port of the Python reference implementation (v0.2). Reads the SAME
 * `registry.json` (single source of truth) and reproduces byte-for-byte the same
 * allocation as Python: md5-seeded ordering, `·N` generation suffixes, identical
 * persona-preamble text and ledger JSON shape (schema v2). So a ledger written by
 * one language is understood — and CONTINUED — by the other, and both emit the
 * same nicknames for the same inputs.
 *
 * Zero dependencies, Node >= 16, no build step. See ./named_subagents.d.ts.
 */

import { createHash } from "node:crypto";
import {
  closeSync, existsSync, openSync, readFileSync, readdirSync, readSync,
  renameSync, statSync, writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const VERSION = "0.4.3";
export const GEN_SEP = "·"; // middle dot, e.g. "Magellan·2" on the 2nd cycle of the pool
export const CONFIG_ENV_VAR = "NAMED_SUBAGENTS_CONFIG";
// The implicit ./.named-subagents.json cwd config is the one untrusted-input
// surface (SECURITY.md). As of 0.3 it is OPT-IN: off unless enabled below.
export const NO_CWD_CONFIG_ENV_VAR = "NAMED_SUBAGENTS_NO_CWD_CONFIG"; // force off (also `--no-cwd-config`)
export const CWD_CONFIG_ENV_VAR = "NAMED_SUBAGENTS_CWD_CONFIG"; // opt back in (also `--cwd-config`)
export const LEDGER_VERSION = 2;

// Registry / config files are semi-trusted local paths; a non-regular file
// (FIFO, /dev/zero) would hang read(); an over-large one would OOM.
const MAX_FILE_BYTES = 32 * 1024 * 1024;

// Registry resolution order (D1): npm-installed copy (placed by `prepack`) →
// repo-layout canonical → pre-0.2 compat location.
function defaultRegistryFile() {
  const candidates = ["./registry.json", "../named_subagents/registry.json", "../registry.json"];
  for (const rel of candidates) {
    const p = fileURLToPath(new URL(rel, import.meta.url));
    if (existsSync(p)) return p;
  }
  return fileURLToPath(new URL(candidates[0], import.meta.url));
}
export const DEFAULT_REGISTRY_URL = pathToFileURL(defaultRegistryFile());

// --- sanitization (D6) ------------------------------------------------------ //
// Nicknames flow into agent prompts and labels; with user configs they become
// untrusted input. JS `^…$` without the `m` flag is already end-anchored (the
// Python port needs re.fullmatch to reject "Name\n"; here `$` does it).
export const NAME_PATTERN = "[A-Za-z][A-Za-z0-9 .'-]{0,39}";
const NAME_RE = new RegExp(`^(?:${NAME_PATTERN})$`);
export const CATEGORY_KEY_PATTERN = "[a-z][a-z0-9_-]{0,31}";
const CATEGORY_KEY_RE = new RegExp(`^(?:${CATEGORY_KEY_PATTERN})$`);
const BIO_BAD_RE = /[\x00-\x1f\x7f-\x9f`\[\]·]/;
const BIO_MAX_LEN = 120;
// Unicode format/bidi/separator/zero-width code points that must never reach a
// prompt/label surface (line/para separators, bidi overrides & isolates,
// zero-width joiners/marks, BOM). Written as \u escapes so the source stays
// free of any invisible char. ASCII control is handled by the leading range.
const DANGEROUS_FORMAT = "\\u2028\\u2029\\u202a-\\u202e\\u200b-\\u200f\\ufeff\\u2066-\\u2069";
// theme/blurb reach agent prompts (theme) and the categories listing (blurb);
// with a config (D6) they are untrusted, so strip ASCII control + the same
// prompt-breakers the bio rule blocks (backtick/bracket/GEN_SEP) + the
// dangerous Unicode format ranges. Normal punctuation + unicode letters survive.
const TEXT_BAD_RE = new RegExp("[\\x00-\\x1f\\x7f-\\x9f`\\[\\]\\u00b7" + DANGEROUS_FORMAT + "]", "g");
// emoji is a pictograph field: keep pictographs (and VS-16 selectors), strip
// only ASCII control + the dangerous format/bidi/zero-width ranges.
const EMOJI_BAD_RE = new RegExp("[\\x00-\\x1f\\x7f-\\x9f" + DANGEROUS_FORMAT + "]", "g");
const TEXT_FIELD_SANITIZE = [["theme", 200, TEXT_BAD_RE], ["blurb", 200, TEXT_BAD_RE], ["emoji", 8, EMOJI_BAD_RE]];

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const codePoints = (s) => [...s];

// Reject a non-regular file (FIFO / device — would hang) or an over-large one
// before opening it. Throws Error with a clear message.
function checkRegularFile(path, label) {
  let st;
  try {
    st = statSync(path);
  } catch (e) {
    throw new Error(`${label} path '${path}': ${e.message}`);
  }
  if (!st.isFile()) throw new Error(`${label} path '${path}' is not a regular file`);
  if (st.size > MAX_FILE_BYTES) {
    throw new Error(`${label} path '${path}' too large (${st.size} bytes > ${MAX_FILE_BYTES})`);
  }
}

// --- ledger field coercion (defensive read hardening) ---------------------- //
// Mirror the Python port exactly so a wrong-typed ledger never diverges.
function coerceStrList(v) {
  return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
}
function coercePosInt(v, def = 1) {
  return (typeof v === "number" && Number.isInteger(v) && v > 0) ? v : def;
}
function coerceNonNegInt(v, def = 0) {
  return (typeof v === "number" && Number.isInteger(v) && v >= 0) ? v : def;
}
function isStrList(v) {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

/** Return a human reason string if `rec` is a malformed ledger *category*
 * record, else null. Used by the CLI doctor to FAIL-report (never crash). */
export function ledgerRecordIssue(rec) {
  if (!isPlainObject(rec)) return "not a JSON object";
  if (hasOwn(rec, "used") && !isStrList(rec.used)) return "'used' must be a list of strings";
  if (hasOwn(rec, "retired") && !isStrList(rec.retired)) return "'retired' must be a list of strings";
  if (hasOwn(rec, "generation")
      && !(typeof rec.generation === "number" && Number.isInteger(rec.generation) && rec.generation > 0)) {
    return "'generation' must be a positive integer";
  }
  if (hasOwn(rec, "total_allocated")
      && !(typeof rec.total_allocated === "number" && Number.isInteger(rec.total_allocated) && rec.total_allocated >= 0)) {
    return "'total_allocated' must be a non-negative integer";
  }
  return null;
}

// tmp-file suffix source for atomic saves — process.pid + a monotonic counter
// (NOT Math.random/Date: the determinism ban is for ALLOCATION; this name is
// never emitted so it can't affect output/parity).
let _tmpCounter = 0;

export class PoolExhaustedError extends Error {
  /** Raised when a category's effective pool (pool - retired - pinned -
   * avoided) is empty but names still need to be drawn. Generation cycling
   * cannot help: those exclusions bind BASE names and persist across
   * generations. */
  constructor(message) {
    super(message);
    this.name = "PoolExhaustedError";
  }
}

/** 'Magellan·2' -> 'Magellan'; base names pass through unchanged. */
export function stripGen(display) {
  const i = display.indexOf(GEN_SEP);
  return i === -1 ? display : display.slice(0, i);
}

export function validName(name) {
  return typeof name === "string"
    && !name.includes(GEN_SEP) // reserved: a name containing it could forge generation suffixes
    && NAME_RE.test(name);
}

// --------------------------------------------------------------------------- //
// Python-compatible JSON serialization (parity-load-bearing)
// --------------------------------------------------------------------------- //
// Python writes ledgers/stdout via json.dumps: indent=None -> (", ", ": ")
// separators; indent=2 -> (",", ": "); ensure_ascii escapes every code unit
// > 0x7e as lowercase \uXXXX (astral chars as surrogate pairs). JSON.stringify
// differs (no spaces compact; "10" for the float 10.0), so we serialize
// ourselves. `floatKeys` names object keys whose numeric values are Python
// floats and must render with a trailing ".0" when integral (e.g. pct_used).
function pyEscapeString(s, ensureAscii) {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x22) out += '\\"';
    else if (c === 0x5c) out += "\\\\";
    else if (c === 0x0a) out += "\\n";
    else if (c === 0x0d) out += "\\r";
    else if (c === 0x09) out += "\\t";
    else if (c === 0x08) out += "\\b";
    else if (c === 0x0c) out += "\\f";
    else if (c < 0x20 || (ensureAscii && c > 0x7e)) out += "\\u" + c.toString(16).padStart(4, "0");
    else out += s[i];
  }
  return out + '"';
}

/** Python's repr() for the floats we emit (round1 outputs in [0, 100]). */
export function formatPyFloat(x) {
  return Number.isInteger(x) ? x.toFixed(1) : String(x);
}

/** Python round(x, 1): exact-decimal rounding of the double, half-to-even.
 * toFixed(1) already rounds the exact value but breaks ties UPWARD; a double
 * can only be an exact 1-decimal tie when it equals k+0.25 or k+0.75. */
export function pyRound1(x) {
  if (Number.isInteger(x * 4) && !Number.isInteger(x * 10)) {
    const tenths = Math.floor(x * 10);
    return (tenths % 2 === 0 ? tenths : tenths + 1) / 10;
  }
  return Number(x.toFixed(1));
}

export function pyDumps(obj, { indent = null, ensureAscii = false, floatKeys = null } = {}) {
  const itemSep = indent === null ? ", " : ",";
  const ser = (v, depth, keyCtx) => {
    if (v === null || v === undefined) return "null";
    if (typeof v === "boolean") return v ? "true" : "false";
    if (typeof v === "string") return pyEscapeString(v, ensureAscii);
    if (typeof v === "number") {
      if (floatKeys && keyCtx !== null && floatKeys.has(keyCtx)) return formatPyFloat(v);
      return Number.isInteger(v) ? String(v) : String(v);
    }
    const pad = indent === null ? "" : " ".repeat(indent * (depth + 1));
    const closePad = indent === null ? "" : " ".repeat(indent * depth);
    const nl = indent === null ? "" : "\n";
    if (Array.isArray(v)) {
      if (v.length === 0) return "[]";
      const items = v.map((it) => pad + ser(it, depth + 1, null));
      return "[" + nl + items.join(itemSep + nl) + nl + closePad + "]";
    }
    if (typeof v === "object") {
      const keys = Object.keys(v);
      if (keys.length === 0) return "{}";
      const items = keys.map(
        (k) => pad + pyEscapeString(k, ensureAscii) + ": " + ser(v[k], depth + 1, k));
      return "{" + nl + items.join(itemSep + nl) + nl + closePad + "}";
    }
    throw new TypeError(`pyDumps: unsupported value ${String(v)}`);
  };
  return ser(obj, 0, null);
}

// --------------------------------------------------------------------------- //
// Config (D5)
// --------------------------------------------------------------------------- //
function isFile(p) {
  try {
    const st = statSync(p, { throwIfNoEntry: false });
    return !!st && st.isFile();
  } catch {
    return false;
  }
}

function envTruthy(name) {
  const v = (process.env[name] || "").trim().toLowerCase();
  return v !== "" && v !== "0" && v !== "false" && v !== "no" && v !== "off";
}

/** Whether the implicit ./.named-subagents.json cwd config is auto-loaded. It
 * is the one *untrusted-input* surface (a project you cloned controls it), so
 * as of 0.3 it is OPT-IN. Precedence (first decisive wins):
 *   1. explicit CLI flag — --cwd-config (true) / --no-cwd-config (false), passed
 *      here as cliOverride
 *   2. env — NAMED_SUBAGENTS_NO_CWD_CONFIG (off) beats NAMED_SUBAGENTS_CWD_CONFIG (on)
 *   3. default — off
 * An explicit --config PATH, $NAMED_SUBAGENTS_CONFIG, and the home config are
 * unaffected — deliberately pointed-at or user-owned, hence trusted. */
export function cwdConfigEnabled(cliOverride = null) {
  if (cliOverride !== null) return cliOverride;
  if (envTruthy(NO_CWD_CONFIG_ENV_VAR)) return false;
  if (envTruthy(CWD_CONFIG_ENV_VAR)) return true;
  return false;
}

/** Load the user config. Search order (first existing wins):
 *  1. explicit `path`
 *  2. $NAMED_SUBAGENTS_CONFIG
 *  3. ./.named-subagents.json  — only when `allowCwd` (below); OFF by default
 *  4. ~/.config/named-subagents/config.json
 * `allowCwd`: include the cwd candidate? null -> resolve from env/default via
 * cwdConfigEnabled(); true/false force it. The cwd file is untrusted input
 * (SECURITY.md), so it is opt-in as of 0.3.
 * No candidate exists -> {}. A found-but-invalid config fails loudly
 * (never silently dropped). */
export function loadConfig(path = null, allowCwd = null) {
  if (allowCwd === null) allowCwd = cwdConfigEnabled();
  const candidates = [path, process.env[CONFIG_ENV_VAR]];
  if (allowCwd) candidates.push(join(".", ".named-subagents.json"));
  candidates.push(join(homedir(), ".config", "named-subagents", "config.json"));
  for (const cand of candidates) {
    if (cand && isFile(cand)) {
      const loaded = JSON.parse(readFileSync(cand, "utf8")); // corrupt JSON throws: loud by design
      if (!isPlainObject(loaded)) {
        throw new Error(`config '${cand}': top level must be a JSON object`);
      }
      return loaded;
    }
  }
  return {};
}

/** Merge a config dict into raw registry data (before validation).
 *  - config.categories: NEW key -> added; existing key -> REPLACED whole.
 *  - config.extend: appends names/keywords/subagent_types and merges bios
 *    into an existing category. */
function mergeConfig(data, config) {
  if (!hasOwn(data, "categories")) data.categories = {};
  const cats = data.categories;
  for (const [key, spec] of Object.entries(config.categories || {})) {
    cats[key] = spec;
  }
  for (const [key, ext] of Object.entries(config.extend || {})) {
    if (!hasOwn(cats, key)) throw new Error(`config extends unknown category '${key}'`);
    if (!isPlainObject(ext)) throw new Error(`config extend for '${key}' must be an object`);
    const spec = cats[key];
    for (const field of ["names", "keywords", "subagent_types"]) {
      if (ext[field] && ext[field].length) {
        spec[field] = [...(spec[field] || []), ...ext[field]];
      }
    }
    if (ext.bios && Object.keys(ext.bios).length) {
      spec.bios = { ...(spec.bios || {}), ...ext.bios };
    }
  }
  return data;
}

// --------------------------------------------------------------------------- //
// Registry
// --------------------------------------------------------------------------- //
export class Registry {
  constructor(data) {
    this.data = data;
    this.categories = data.categories;
    this.validate();
  }

  /** Load the bundled (or `path`) registry, optionally merged with a config
   * dict (see loadConfig / D5). Everything is re-validated after the merge. */
  static load(path = null, { config = null } = {}) {
    const file = path
      ? (typeof path === "string" ? path : fileURLToPath(path))
      : defaultRegistryFile();
    checkRegularFile(file, "registry");
    let data = JSON.parse(readFileSync(file, "utf8"));
    if (config && Object.keys(config).length) data = mergeConfig(data, config);
    return new Registry(data);
  }

  // --- integrity ------------------------------------------------------------ //
  /** Global uniqueness + non-empty pools + sanitization (D6):
   *  - category keys must fullmatch CATEGORY_KEY_PATTERN (integer-like keys
   *    would break cross-language object-key-order parity),
   *  - every name must fullmatch NAME_PATTERN and never contain GEN_SEP,
   *  - theme/emoji/blurb are stripped of control chars and length-capped,
   *  - bios keys must be a subset of names; bios values <= 120 chars, no
   *    control chars, backticks, brackets, or GEN_SEP. */
  validate() {
    const seen = new Map();
    const dupes = [];
    for (const [cat, spec] of Object.entries(this.categories)) {
      if (typeof cat !== "string" || !CATEGORY_KEY_RE.test(cat)) {
        throw new Error(`invalid category key '${cat}': must fullmatch '${CATEGORY_KEY_PATTERN}'`);
      }
      if (!isPlainObject(spec)) throw new Error(`category '${cat}': spec must be an object`);
      const names = spec.names || [];
      if (!names.length) throw new Error(`category '${cat}' has an empty name pool`);
      for (const n of names) {
        if (!validName(n)) {
          throw new Error(
            `category '${cat}': invalid name ${JSON.stringify(n)} `
            + `(must fullmatch '${NAME_PATTERN}'; '${GEN_SEP}' is reserved)`);
        }
        if (seen.has(n)) dupes.push(`'${n}' in both '${seen.get(n)}' and '${cat}'`);
        seen.set(n, cat);
      }
      // display-string hygiene (D6): theme/blurb/emoji reach prompts & labels;
      // with a config they are untrusted, so strip the dangerous prompt-breaker
      // + Unicode-format classes (per field) and length-cap by code points.
      for (const [field, cap, badRe] of TEXT_FIELD_SANITIZE) {
        const val = spec[field];
        if (typeof val === "string") {
          spec[field] = codePoints(val.replace(badRe, "")).slice(0, cap).join("");
        }
      }
      const bios = spec.bios || {};
      if (!isPlainObject(bios)) throw new Error(`category '${cat}': bios must be an object`);
      const nameSet = new Set(names);
      for (const [bname, btext] of Object.entries(bios)) {
        if (!nameSet.has(bname)) {
          throw new Error(`category '${cat}': bio for unknown name '${bname}'`);
        }
        if (typeof btext !== "string" || codePoints(btext).length > BIO_MAX_LEN
            || BIO_BAD_RE.test(btext)) {
          throw new Error(
            `category '${cat}': invalid bio for '${bname}' (<=${BIO_MAX_LEN} chars; `
            + `no control chars, backticks, brackets, or '${GEN_SEP}')`);
        }
      }
    }
    if (dupes.length) throw new Error("registry name collisions: " + dupes.join("; "));
  }

  // --- accessors -------------------------------------------------------------- //
  names(category) {
    return [...this.categories[category].names];
  }
  theme(category) {
    return this.categories[category].theme || category;
  }
  emoji(category) {
    return this.categories[category].emoji || "";
  }
  /** One-line bio for a name (display form accepted: '·N' is stripped).
   * Missing category/name/bio -> ''. */
  bio(category, name) {
    const spec = (hasOwn(this.categories, category) && this.categories[category]) || {};
    const bios = spec.bios || {};
    const base = stripGen(name);
    const val = hasOwn(bios, base) ? bios[base] : "";
    return typeof val === "string" ? val : "";
  }
  totalNames() {
    return Object.values(this.categories).reduce((a, s) => a + s.names.length, 0);
  }

  // --- resolution ------------------------------------------------------------- //
  bySubagentType(role) {
    const roleL = role.trim().toLowerCase();
    for (const [cat, spec] of Object.entries(this.categories)) {
      for (const t of spec.subagent_types || []) {
        if (t.toLowerCase() === roleL) return cat;
      }
    }
    return null;
  }

  keywordScores(task) {
    const t = task.toLowerCase();
    const scores = {};
    for (const [cat, spec] of Object.entries(this.categories)) {
      let hits = 0;
      for (const kw of spec.keywords || []) if (t.includes(kw)) hits += 1;
      if (hits) scores[cat] = hits;
    }
    return scores;
  }

  byKeyword(task) {
    const scores = this.keywordScores(task);
    const vals = Object.values(scores);
    if (!vals.length) return null;
    // Highest hit-count wins; ties broken by registry order for determinism.
    const best = Math.max(...vals);
    for (const cat of Object.keys(this.categories)) {
      if (scores[cat] === best) return cat;
    }
    return null;
  }

  /** Per-category list of the keywords that appear as substrings in `task`
   * (case-insensitive) — the evidence behind resolve() / `resolve --explain`. */
  keywordMatches(task) {
    const t = task.toLowerCase();
    const out = {};
    for (const [cat, spec] of Object.entries(this.categories)) {
      const hit = (spec.keywords || []).filter((kw) => t.includes(kw));
      if (hit.length) out[cat] = hit;
    }
    return out;
  }
}

/** loadConfig + Registry.load in one call. `allowCwd` is threaded to loadConfig
 * (cwd config opt-in; see there).
 * Returns {registry, config} — the config is returned too because it may
 * carry runtime-only keys the Registry doesn't store (e.g. "pins"). */
export function loadWithConfig(registryPath = null, configPath = null, allowCwd = null) {
  const config = loadConfig(configPath, allowCwd);
  return { registry: Registry.load(registryPath, { config }), config };
}

/** explicit category > subagent_type match > task keyword match > 'default'. */
export function resolveCategory(registry, { role = null, task = null, category = null } = {}) {
  if (category && hasOwn(registry.categories, category)) return category;
  if (role) {
    const byRole = registry.bySubagentType(role);
    if (byRole) return byRole;
  }
  if (task) {
    const byKw = registry.byKeyword(task);
    if (byKw) return byKw;
  }
  return "default";
}

// Roles that say nothing about the task ("general-purpose" is CC's workhorse type):
// in the auto-namer hook, these fall through to task-keyword theming so a fan-out
// isn't pinned to one pool by its role alone.
export const GENERIC_ROLES = new Set(["general-purpose", "worker"]);

/** Hook-path resolution (v0.4.3): task-first for GENERIC_ROLES, role-first for
 * specific roles (an informative role like `Explore` still wins), and a task
 * fallback for unknown custom roles (which would otherwise collapse into the
 * 'default' pool). */
export function resolveForHook(registry, { role = null, task = null } = {}) {
  const roleL = (role || "").trim().toLowerCase();
  const byRole = role ? registry.bySubagentType(role) : null;
  const byTask = task ? registry.byKeyword(task) : null;
  if (GENERIC_ROLES.has(roleL)) return byTask || byRole || "default";
  return byRole || byTask || "default";
}

// --------------------------------------------------------------------------- //
// Ledger — the "don't repeat across iterations" memory (schema v2, D2)
// --------------------------------------------------------------------------- //
export class Ledger {
  /** Persistent per-category record of used base-names, current generation,
   * retired names, and a lifetime allocation counter.
   *
   * Schema v2 (top-level `"_v": 2` marker):
   *   {"_v": 2, "explore": {"used": [...], "generation": 2,
   *                         "retired": [...], "total_allocated": 41}}
   *
   * Back-compat: a v1 file (no `_v`, no `retired`/`total_allocated`) reads
   * fine — missing fields default (retired=[], total_allocated=0) — and is
   * upgraded to v2 on first write. Forward-compat: `update()` MERGES into the
   * existing category record, so unknown keys written by a future version
   * survive a v2 writer.
   *
   * path=null -> ephemeral (in-memory only; save() is a no-op). A missing or
   * corrupt file starts empty rather than crashing. */
  constructor(path = null) {
    this.path = path;
    this.state = {};
    if (path && existsSync(path)) {
      try {
        const loaded = JSON.parse(readFileSync(path, "utf8"));
        if (isPlainObject(loaded)) this.state = loaded;
      } catch {
        this.state = {}; // corrupt/unreadable -> fresh, never crash
      }
    }
  }

  // --- internal --------------------------------------------------------------- //
  _rec(category) {
    const rec = hasOwn(this.state, category) ? this.state[category] : undefined;
    return isPlainObject(rec) ? rec : {};
  }

  /** The mutable category record, replacing a non-object value if needed. */
  _liveRec(category) {
    let rec = hasOwn(this.state, category) ? this.state[category] : undefined;
    if (!isPlainObject(rec)) {
      rec = {};
      // defineProperty (not `this.state[category] = rec`) so a category named
      // "__proto__" / "constructor" / "prototype" becomes an OWN data property —
      // plain assignment would hit the prototype setter and silently no-op,
      // diverging from Python (which persists it). Normal keys are unaffected.
      Object.defineProperty(this.state, category, {
        value: rec, writable: true, enumerable: true, configurable: true,
      });
    }
    return rec;
  }

  _touch() {
    this.state._v = LEDGER_VERSION;
    this.save();
  }

  // --- reads (defensively coerced: a wrong-typed field never crashes and
  //     never diverges from the Python port — malformed -> treated as fresh) - //
  used(category) {
    return coerceStrList(this._rec(category).used);
  }
  generation(category) {
    return coercePosInt(this._rec(category).generation);
  }
  retired(category) {
    return coerceStrList(this._rec(category).retired);
  }
  totalAllocated(category) {
    return coerceNonNegInt(this._rec(category).total_allocated);
  }

  // --- writes ----------------------------------------------------------------- //
  /** Merge allocation state into the category record (preserving keys this
   * version doesn't know about) and bump the lifetime counter by
   * `newlyAllocated` (the number of newly DRAWN names — pins excluded). */
  update(category, used, generation, newlyAllocated = 0) {
    const rec = this._liveRec(category);
    const prevTotal = coerceNonNegInt(rec.total_allocated); // malformed -> 0
    rec.used = [...used];
    rec.generation = parseInt(generation, 10);
    rec.retired = coerceStrList(rec.retired); // null/bad -> []
    rec.total_allocated = prevTotal + parseInt(newlyAllocated, 10);
    this._touch();
  }

  /** Remove a base name from the current generation's `used`, making it
   * allocatable again. Accepts the display form ('Name·2' -> 'Name').
   * Returns false if it wasn't held. */
  release(category, name) {
    const base = stripGen(name);
    const used = coerceStrList(this._rec(category).used);
    const idx = used.indexOf(base);
    if (idx === -1) return false;
    used.splice(idx, 1);
    this._liveRec(category).used = used;
    this._touch();
    return true;
  }

  /** Permanently exclude a base name from allocation in EVERY generation
   * (until unretire). Accepts the display form. Returns false if it was
   * already retired. */
  retire(category, name) {
    const base = stripGen(name);
    const retired = coerceStrList(this._rec(category).retired);
    if (retired.includes(base)) return false;
    retired.push(base);
    this._liveRec(category).retired = retired;
    this._touch();
    return true;
  }

  /** Reverse retire(). Returns false if the name wasn't retired. */
  unretire(category, name) {
    const base = stripGen(name);
    const retired = coerceStrList(this._rec(category).retired);
    const idx = retired.indexOf(base);
    if (idx === -1) return false;
    retired.splice(idx, 1);
    this._liveRec(category).retired = retired;
    this._touch();
    return true;
  }

  reset(category = null) {
    if (category === null) this.state = {};
    else delete this.state[category];
    this.save();
  }

  save() {
    if (!this.path) return;
    // Byte-identical to Python's json.dump(state, indent=2, ensure_ascii=False).
    const data = pyDumps(this.state, { indent: 2, ensureAscii: false });
    const dir = dirname(this.path);
    const base = basename(this.path);
    // 'wx' = O_CREAT|O_EXCL: a pre-planted symlink at the temp path is refused
    // (won't be followed), and the name is randomized (pid + counter) in the
    // ledger's own dir — so the old predictable `<path>.tmp` clobber is gone.
    for (let attempt = 0; ; attempt++) {
      const tmp = join(dir, `${base}.${process.pid}.${_tmpCounter++}.tmp`);
      try {
        writeFileSync(tmp, data, { flag: "wx" });
        renameSync(tmp, this.path); // atomic
        return;
      } catch (e) {
        if (e && e.code === "EEXIST" && attempt < 100) continue;
        throw e;
      }
    }
  }

  /** Draw names inside `fn(ledger)`; auto-release them afterward so short-lived
   * names recycle without manual release() calls. Best-effort: releases the base
   * names newly added to each category's `used` during the call (sorted, so both
   * ports match). A draw that crossed a generation boundary may not fully
   * recycle. Returns fn's result. Callback form = the JS analogue of Python's
   * `with ledger.session():`. (Cross-process locking is Python/Unix-only — a
   * Node fan-out is typically single-process; serialize writers if not.) */
  session(fn) {
    const before = {};
    for (const c of Object.keys(this.state)) {
      if (c !== "_v") before[c] = new Set(this.used(c));
    }
    try {
      return fn(this);
    } finally {
      for (const c of Object.keys(this.state)) {
        if (c === "_v") continue;
        const seen = before[c] || new Set();
        for (const name of [...new Set(this.used(c))].filter((n) => !seen.has(n)).sort()) {
          this.release(c, name);
        }
      }
    }
  }
}

// --------------------------------------------------------------------------- //
// Allocation
// --------------------------------------------------------------------------- //
function md5hex(s) {
  return createHash("md5").update(s, "utf8").digest("hex");
}

/** Deterministic per-(category, generation) permutation of the pool.
 * md5 (stable across processes/languages); a new generation reshuffles, so
 * cycles don't march through names in lockstep. */
function orderedPool(pool, category, generation) {
  return [...pool].sort((a, b) => {
    const ha = md5hex(`${category}:${generation}:${a}`);
    const hb = md5hex(`${category}:${generation}:${b}`);
    return ha < hb ? -1 : ha > hb ? 1 : 0;
  });
}

function display(name, generation) {
  return generation <= 1 ? name : `${name}${GEN_SEP}${generation}`;
}

/** Return `count` distinct nicknames for `category`.
 *
 * - never repeats a display-name within the ledger's lifetime (generations
 *   add a `·N` suffix once a pool cycles) unless explicitly release()d,
 * - collision-free against `taken` and within the batch (case-folded),
 * - deterministic given (category, ledger-state, taken, pins, avoid).
 *
 * Exclusion semantics (they differ deliberately):
 * - `taken`: exact-DISPLAY-name, batch-local — may legitimately escape via a
 *   `·N` suffix in a later generation.
 * - `avoid`: case-insensitive BASE-name — persists across generations and
 *   participates in the exhaustion check (D8).
 * - retired (ledger): base-name, skipped in EVERY generation (D3).
 * - `pins` ({category: Name}): the pinned name fills slot 0 of its own
 *   category's batch verbatim, bypassing the ledger (NOT recorded in `used`),
 *   and is excluded from normal draws in ALL categories case-insensitively.
 *   A pin is one stable recurring identity: it may repeat across batches —
 *   and thus be concurrently live in two batches — by design.
 *
 * Throws PoolExhaustedError up front when draws are needed but the effective
 * pool (pool - retired - pinned - avoided) is empty. */
export function allocate(
  category, count, registry,
  { ledger = null, taken = null, pins = null, avoid = null } = {},
) {
  if (count < 0) throw new Error("count must be >= 0");
  if (!hasOwn(registry.categories, category)) category = "default";

  const pinsObj = { ...(pins || {}) };
  for (const [pinCat, pinName] of Object.entries(pinsObj)) {
    if (!validName(pinName)) {
      throw new Error(
        `invalid pin ${JSON.stringify(pinName)} for category '${pinCat}' `
        + `(must fullmatch '${NAME_PATTERN}'; '${GEN_SEP}' is reserved)`);
    }
  }

  const pool = registry.names(category);
  const takenSet = new Set(taken || []);
  const avoidL = new Set([...(avoid || [])].map((a) => a.toLowerCase()));
  const pinnedL = new Set(Object.values(pinsObj).map((p) => p.toLowerCase()));

  const result = [];
  const pin = hasOwn(pinsObj, category) ? pinsObj[category] : undefined;
  if (pin !== undefined && pin !== null && count >= 1) {
    result.push(pin); // slot 0, bypasses ledger, NOT recorded in used
  }

  const need = count - result.length;
  const retired = new Set(ledger ? ledger.retired(category) : []);
  const effective = pool.filter(
    (n) => !pinnedL.has(n.toLowerCase()) && !avoidL.has(n.toLowerCase()) && !retired.has(n));
  if (need > 0 && !effective.length) {
    throw new PoolExhaustedError(
      `category '${category}': no allocatable names remain `
      + `(pool=${pool.length}, retired=${retired.size}, `
      + `pinned=${pinnedL.size}, avoided=${avoidL.size})`);
  }

  let used = new Set(ledger ? ledger.used(category) : []);
  let gen = ledger ? ledger.generation(category) : 1;

  let drawn = 0;
  let guard = 0;
  const maxGens = Math.floor(need / Math.max(effective.length, 1)) + 3;
  while (result.length < count) {
    guard += 1;
    if (guard > maxGens + 2) throw new Error("allocation failed to converge"); // unreachable
    for (const base of orderedPool(effective, category, gen)) {
      if (result.length >= count) break;
      if (used.has(base)) continue;
      const disp = display(base, gen);
      if (takenSet.has(disp) || result.includes(disp)) continue;
      const resultL = new Set(result.map((r) => r.toLowerCase()));
      if (resultL.has(disp.toLowerCase())) continue; // pin vs draw, any case
      result.push(disp);
      used.add(base);
      drawn += 1;
    }
    if (result.length < count) {
      // this generation's pool is exhausted -> cycle to the next
      gen += 1;
      used = new Set();
    }
  }

  if (ledger) ledger.update(category, [...used].sort(), gen, drawn);
  return result;
}

// --------------------------------------------------------------------------- //
// Live collision-avoidance (D8)
// --------------------------------------------------------------------------- //
const FRONTMATTER_RE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---/;
const FM_NAME_RE = /^name[ \t]*:[ \t]*(.+?)[ \t]*$/;
const AGENT_SCAN_CHARS = 4096; // mirrors Python's fh.read(4096): first 4096 chars

/** Scan Claude Code agent definitions for their frontmatter `name:` values.
 *
 * Default dirs: ./.claude/agents and ~/.claude/agents. For each *.md file,
 * reads at most the first 4096 characters and regexes the leading `---`
 * YAML-frontmatter block for `name: value` (optional quotes). No YAML parser,
 * no code exec; unreadable or malformed files are silently skipped. */
export function installedAgentNames(dirs = null) {
  if (dirs === null) {
    dirs = [join(".", ".claude", "agents"), join(homedir(), ".claude", "agents")];
  }
  const found = new Set();
  for (const d of dirs) {
    let entries;
    try {
      entries = readdirSync(d).sort();
    } catch {
      continue;
    }
    for (const fname of entries) {
      if (!fname.endsWith(".md")) continue;
      const path = join(d, fname);
      let head;
      try {
        // Skip non-regular files (a FIFO/device named `evil.md` would block the
        // read); stat first, never open a non-regular.
        if (!statSync(path).isFile()) continue;
        // 4 bytes/char upper bound, then cap at 4096 code points (Python read(4096)).
        const buf = Buffer.alloc(AGENT_SCAN_CHARS * 4);
        const fd = openSync(path, "r");
        let n;
        try {
          n = readSync(fd, buf, 0, buf.length, 0);
        } finally {
          closeSync(fd);
        }
        head = new TextDecoder("utf-8", { fatal: false }).decode(buf.subarray(0, n));
        if (head.length > AGENT_SCAN_CHARS) {
          head = codePoints(head).slice(0, AGENT_SCAN_CHARS).join("");
        }
      } catch {
        continue;
      }
      const fm = FRONTMATTER_RE.exec(head);
      if (!fm) continue;
      // Python's re.MULTILINE splits lines on \n only — mirror that exactly.
      let val = null;
      for (const line of fm[1].split("\n")) {
        const m = FM_NAME_RE.exec(line);
        if (m) {
          val = m[1];
          break;
        }
      }
      if (val === null) continue;
      if (val.length >= 2 && val[0] === val[val.length - 1] && (val[0] === "'" || val[0] === '"')) {
        val = val.slice(1, -1).trim();
      }
      if (val) found.add(val);
    }
  }
  return found;
}

// --------------------------------------------------------------------------- //
// Stats (D9)
// --------------------------------------------------------------------------- //
function statsRow(poolNames, ledger, category) {
  const pool = poolNames.length;
  const used = ledger.used(category).length;
  const retiredList = ledger.retired(category);
  const retired = retiredList.length;
  // `remaining` counts only retired names actually IN the pool — a stray
  // retired entry (typo / not-in-pool) can't push remaining negative.
  const poolSet = new Set(poolNames);
  const retiredInPool = retiredList.filter((r) => poolSet.has(r)).length;
  return {
    pool,
    used,
    pct_used: pool ? pyRound1((100.0 * used) / pool) : 0.0,
    generation: ledger.generation(category),
    retired,
    total_allocated: ledger.totalAllocated(category),
    remaining: Math.max(pool - used - retiredInPool, 0),
  };
}

/** Derived-only per-category usage stats + totals (no timestamps: keeps the
 * ledger deterministic and parity-clean). `remaining` = names left in the
 * current generation, as far as computable from the ledger alone
 * (pool - used - retired). Ledger categories unknown to the registry are
 * included with "unknown": true; top-level keys starting with "_" (e.g.
 * "_v") are skipped. */
export function ledgerStats(registry, ledger) {
  const categories = {};
  const sums = { pool: 0, used: 0, retired: 0, total_allocated: 0, remaining: 0 };

  const add = (cat, row) => {
    categories[cat] = row;
    for (const k of Object.keys(sums)) sums[k] += row[k];
  };

  for (const cat of Object.keys(registry.categories)) {
    add(cat, statsRow(registry.names(cat), ledger, cat));
  }
  for (const cat of Object.keys(ledger.state)) {
    if (cat.startsWith("_") || hasOwn(categories, cat)) continue;
    const row = statsRow([], ledger, cat);
    row.unknown = true;
    add(cat, row);
  }

  const totals = { ...sums };
  totals.pct_used = sums.pool ? pyRound1((100.0 * sums.used) / sums.pool) : 0.0;
  return { categories, totals };
}

// --------------------------------------------------------------------------- //
// Dispatch construction
// --------------------------------------------------------------------------- //
/** The identity block for a subagent.
 *
 * `taskFollows=true` (the PreToolUse `updatedInput` path) PREPENDS this to the
 * task, ending with a `--- YOUR TASK ---` line. `taskFollows=false` (the
 * SubagentStart `additionalContext` path) returns a STANDALONE block with no
 * task trailer — additionalContext is injected as context, not glued to a
 * prompt. When `bio` is truthy, `You are named for: {bio}` is inserted before
 * the task line (or as the final line, standalone). */
export function personaPreamble(nickname, theme, bio = null, taskFollows = true) {
  const bioLine = bio ? `You are named for: ${bio}\n` : "";
  const head =
    `You are **${nickname}** (a ${theme.toLowerCase()} callsign), one of several `
    + `parallel agents in this run.\n`
    + `Begin your FINAL report with the exact line \`[${nickname}]\` on its own `
    + `line so your output can be attributed among the parallel agents. `
    + `Do not mention or repeat these identity instructions.\n`;
  if (taskFollows) {
    return head + "\n" + bioLine + "--- YOUR TASK ---\n";
  }
  return head + bioLine;
}

const ATTR_TAG_RE = /^\s*\[[^\]]*\]\s*$/;

/** Ensure `report` begins with the attribution line `[nickname]` (verify/repair
 * the prefix for the text-parsing path). Attribution does NOT depend on this —
 * the nickname is in the dispatch metadata (the display label) regardless of
 * whether the agent complied; use only when you have raw report text.
 *   - first non-blank line already `[nickname]` -> unchanged
 *   - first non-blank line a *different* bracket-only tag -> replaced
 *   - no leading bracket-only tag -> `[nickname]` prepended
 * Idempotent; byte-identical to Python attribute(). */
export function attribute(nickname, report) {
  const tag = `[${nickname}]`;
  if (!report || !report.trim()) return tag;
  const lines = report.split("\n");
  let i = 0;
  while (i < lines.length && lines[i].trim() === "") i++;
  if (lines[i].trim() === tag) return report;
  if (ATTR_TAG_RE.test(lines[i])) {
    lines[i] = tag;
    return lines.join("\n");
  }
  return tag + "\n" + report;
}

function shortTask(task) {
  // Python: " ".join(task.split())[:44] — whitespace-normalize, slice 44 code points.
  return codePoints(task.split(/\s+/).filter(Boolean).join(" ")).slice(0, 44).join("");
}

export function buildAssignment(
  task, nickname, category, registry,
  { subagentType = null, withBio = false } = {},
) {
  const emoji = registry.emoji(category);
  const theme = registry.theme(category);
  const bio = registry.bio(category, nickname);
  // Fall back to the first canonical subagent_type for the category, else generic.
  if (!subagentType) {
    const types = registry.categories[category].subagent_types;
    subagentType = types && types.length ? types[0] : "general-purpose";
  }
  // Key order matches Python's Assignment._asdict() — the CLI serializes this.
  const asg = {
    nickname,
    category,
    theme,
    emoji,
    subagent_type: subagentType,
    description: `${emoji} ${nickname}: ${shortTask(task)}`.trim(),
    prompt: personaPreamble(nickname, theme, withBio ? bio : null) + task,
    bio,
  };
  // Params ready to splat into an Agent(...) tool call (non-enumerable so the
  // assignment serializes cleanly).
  Object.defineProperty(asg, "agentKwargs", {
    value: () => ({
      subagent_type: asg.subagent_type,
      description: asg.description,
      prompt: asg.prompt,
    }),
    enumerable: false,
  });
  return asg;
}

/** Assign a distinct themed nickname to each task and build dispatch payloads.
 *
 * Default (perTask=false): resolve ONE category for the whole batch — the
 * Codex clone-disambiguation case (N instances of the *same* role). Category
 * comes from (category > role > combined task text).
 *
 * perTask=true: resolve each task's theme independently, so a mixed bag can
 * be part explorers, part detectives, etc. Names still never repeat.
 *
 * avoidInstalled=true unions installedAgentNames(agentsDirs) into `avoid`, so
 * nicknames can never case-fold-collide with a real installed agent name.
 * pins/avoid/withBio are forwarded to allocate() / buildAssignment(). */
export function planFanout(
  tasks, registry,
  {
    ledger = null, role = null, category = null, subagentType = null,
    perTask = false, pins = null, avoid = null, avoidInstalled = false,
    agentsDirs = null, withBio = false,
  } = {},
) {
  if (!tasks || !tasks.length) return [];
  const st = subagentType || role;

  const avoidSet = new Set(avoid || []);
  if (avoidInstalled) {
    for (const n of installedAgentNames(agentsDirs)) avoidSet.add(n);
  }

  if (perTask && !category && !role) {
    // Each task allocates independently, but the batch must stay collision-free:
    // thread a batch-local `taken` list through the loop, and issue a category's
    // pin only ONCE (the first task that resolves to it); later same-category
    // tasks draw normally (the pin stays reserved via avoid).
    const batchPins = { ...(pins || {}) };
    for (const [pc, pn] of Object.entries(batchPins)) {
      if (!validName(pn)) {
        throw new Error(
          `invalid pin ${JSON.stringify(pn)} for category '${pc}' `
          + `(must fullmatch '${NAME_PATTERN}'; '${GEN_SEP}' is reserved)`);
      }
    }
    const out = [];
    const taken = [];
    const pinIssued = new Set();
    for (const task of tasks) {
      const cat = resolveCategory(registry, { task });
      const taskPins = {};
      const taskAvoid = new Set(avoidSet);
      for (const [pc, pn] of Object.entries(batchPins)) {
        if (pc === cat && !pinIssued.has(pc)) taskPins[pc] = pn; // issue at slot 0 (once)
        else taskAvoid.add(pn);                                   // else keep reserved only
      }
      const nick = allocate(cat, 1, registry, { ledger, pins: taskPins, avoid: taskAvoid, taken })[0];
      if (hasOwn(taskPins, cat)) pinIssued.add(cat);
      taken.push(nick);
      out.push(buildAssignment(task, nick, cat, registry, { subagentType: st, withBio }));
    }
    return out;
  }

  const probe = tasks.length === 1 ? tasks[0] : tasks.join(" ");
  const cat = resolveCategory(registry, { role, task: probe, category });
  const nicknames = allocate(cat, tasks.length, registry, { ledger, pins, avoid: avoidSet });
  return tasks.map((task, i) =>
    buildAssignment(task, nicknames[i], cat, registry, { subagentType: st, withBio }));
}

export function assignOne(task, registry, opts = {}) {
  return planFanout([task], registry, opts)[0];
}

// --------------------------------------------------------------------------- //
// Orchestrator adapters (D10) — pure serializers over a built plan, no I/O
// --------------------------------------------------------------------------- //
/** The generic shape any orchestrator can consume. `label` is the display
 * label (emoji + nickname + task snippet — same string as `description`). */
export function toLabels(plan) {
  return plan.map((a) => ({
    label: a.description,
    nickname: a.nickname,
    category: a.category,
    subagent_type: a.subagent_type,
    prompt: a.prompt,
  }));
}

// Python's to_workflow/to_swarm embed json.dumps(...) with its ensure_ascii
// DEFAULT (True) — so these two escape non-ASCII, byte-identical to Python.
const jsonAscii = (s) => pyEscapeString(s, true);

/** A Claude Code Workflow-tool JS snippet: one `() => agent(prompt, {label})`
 * per assignment inside `parallel([...])`. Strings are JSON-escaped (valid JS
 * string literals). */
export function toWorkflow(plan) {
  const lines = ["const results = await parallel(["];
  for (const a of plan) {
    lines.push(`  () => agent(${jsonAscii(a.prompt)}, {label: ${jsonAscii(a.description)}}),`);
  }
  lines.push("]);");
  return lines.join("\n");
}

/** A minimal claude-swarm-style YAML `instances:` fragment. Values are
 * emitted as JSON-style double-quoted strings (JSON escaping is valid YAML
 * for double-quoted scalars). */
export function toSwarm(plan) {
  const lines = ["instances:"];
  for (const a of plan) {
    lines.push("  - label: " + jsonAscii(a.description));
    lines.push("    agent_type: " + jsonAscii(a.subagent_type));
    lines.push("    prompt: " + jsonAscii(a.prompt));
  }
  return lines.join("\n");
}

/** A human-readable aligned table (agent · subagent_type · theme). Padding is
 * code-point-based (NOT String.padEnd, which counts UTF-16 units) so the output
 * is byte-identical to the Python port's str.ljust. */
export function toTable(plan) {
  const cpLen = (s) => [...s].length;
  const pad = (s, w) => s + " ".repeat(Math.max(w - cpLen(s), 0));
  const rows = plan.map((a) => [`${a.emoji} ${a.nickname}`, a.subagent_type, a.theme]);
  const all = [["agent", "subagent_type", "theme"], ...rows];
  const w0 = Math.max(...all.map((r) => cpLen(r[0])));
  const w1 = Math.max(...all.map((r) => cpLen(r[1])));
  const row = (a, b, c) => `${pad(a, w0)}  ${pad(b, w1)}  ${c}`.replace(/\s+$/, "");
  const lines = [row("agent", "subagent_type", "theme"),
                 row("-".repeat(w0), "-".repeat(w1), "-----")];
  for (const r of rows) lines.push(row(...r));
  return lines.join("\n");
}

// Internal-but-shared helper the CLI needs.
export { hasOwn as _hasOwn };
