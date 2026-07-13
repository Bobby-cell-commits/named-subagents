// TypeScript declarations for named_subagents.mjs — the JS runtime is plain ESM.

export const VERSION: string;
export const GEN_SEP: string;
export const CONFIG_ENV_VAR: string;
export const NO_CWD_CONFIG_ENV_VAR: string;
export const CWD_CONFIG_ENV_VAR: string;
export const LEDGER_VERSION: number;
export const NAME_PATTERN: string;
export const CATEGORY_KEY_PATTERN: string;
export const DEFAULT_REGISTRY_URL: URL;

/** Thrown when a category's effective pool (pool - retired - pinned - avoided)
 * is empty but names still need to be drawn. */
export class PoolExhaustedError extends Error {}

/** 'Magellan·2' -> 'Magellan'; base names pass through unchanged. */
export function stripGen(display: string): string;
/** Name sanitization (D6): fullmatch of NAME_PATTERN, GEN_SEP reserved. */
export function validName(name: unknown): boolean;

export interface CategorySpec {
  theme?: string;
  emoji?: string;
  blurb?: string;
  subagent_types?: string[];
  keywords?: string[];
  names: string[];
  bios?: Record<string, string>;
}

export interface RegistryData {
  categories: Record<string, CategorySpec>;
  [k: string]: unknown;
}

/** User config (D5): custom/extended categories + pinned identities. */
export interface UserConfig {
  pins?: Record<string, string>;
  categories?: Record<string, CategorySpec>;
  extend?: Record<string, Partial<CategorySpec>>;
  [k: string]: unknown;
}

export class Registry {
  data: RegistryData;
  categories: Record<string, CategorySpec>;
  constructor(data: RegistryData);
  static load(path?: string | URL | null, opts?: { config?: UserConfig | null }): Registry;
  validate(): void;
  names(category: string): string[];
  theme(category: string): string;
  emoji(category: string): string;
  /** One-line bio for a name (display form accepted: '·N' stripped). Missing -> ''. */
  bio(category: string, name: string): string;
  totalNames(): number;
  bySubagentType(role: string): string | null;
  keywordScores(task: string): Record<string, number>;
  /** Per-category keywords that substring-match `task` (evidence for --explain). */
  keywordMatches(task: string): Record<string, string[]>;
  byKeyword(task: string): string | null;
}

/** Whether the implicit ./.named-subagents.json cwd config is auto-loaded.
 * Opt-in as of 0.3 (the one untrusted-input surface). Precedence: explicit
 * `cliOverride` > NAMED_SUBAGENTS_NO_CWD_CONFIG (off) > NAMED_SUBAGENTS_CWD_CONFIG
 * (on) > default off. */
export function cwdConfigEnabled(cliOverride?: boolean | null): boolean;

/** Load the user config. Search order: explicit path > $NAMED_SUBAGENTS_CONFIG
 * > (opt-in) ./.named-subagents.json > ~/.config/named-subagents/config.json.
 * `allowCwd` gates the cwd candidate (null -> resolve via cwdConfigEnabled()). */
export function loadConfig(path?: string | null, allowCwd?: boolean | null): UserConfig;

/** loadConfig + Registry.load in one call (config may carry runtime-only keys
 * such as "pins" that the Registry doesn't store). `allowCwd` is threaded to
 * loadConfig. */
export function loadWithConfig(
  registryPath?: string | null,
  configPath?: string | null,
  allowCwd?: boolean | null,
): { registry: Registry; config: UserConfig };

export interface ResolveOpts {
  role?: string | null;
  task?: string | null;
  category?: string | null;
}
export function resolveCategory(registry: Registry, opts?: ResolveOpts): string;

/** Per-category ledger record (schema v2; unknown future keys are preserved). */
export interface LedgerRecord {
  used?: string[];
  generation?: number;
  retired?: string[];
  total_allocated?: number;
  [k: string]: unknown;
}

/** Human reason string if `rec` is a malformed ledger category record, else
 * null (the doctor uses it to FAIL-report instead of crashing). */
export function ledgerRecordIssue(rec: unknown): string | null;

export class Ledger {
  path: string | null;
  state: Record<string, LedgerRecord | number>;
  constructor(path?: string | null);
  used(category: string): string[];
  generation(category: string): number;
  retired(category: string): string[];
  totalAllocated(category: string): number;
  update(category: string, used: Iterable<string>, generation: number, newlyAllocated?: number): void;
  /** Return a held base name to the pool (accepts display form). */
  release(category: string, name: string): boolean;
  /** Permanently exclude a base name from every generation (until unretire). */
  retire(category: string, name: string): boolean;
  unretire(category: string, name: string): boolean;
  reset(category?: string | null): void;
  save(): void;
  /** Draw names inside `fn`, auto-release them afterward (recycle short-lived
   * names). Returns fn's result. JS analogue of Python's `with ledger.session():`. */
  session<T>(fn: (ledger: Ledger) => T): T;
}

export interface AllocateOpts {
  ledger?: Ledger | null;
  /** Exact-display-name, batch-local exclusion (may escape via a ·N suffix). */
  taken?: Iterable<string> | null;
  /** {category: Name} — pinned name fills slot 0 of its own category verbatim,
   * bypasses the ledger, and is excluded from draws in ALL categories. */
  pins?: Record<string, string> | null;
  /** Case-insensitive BASE-name exclusion; persists across generations and
   * participates in the exhaustion check. */
  avoid?: Iterable<string> | null;
}
export function allocate(category: string, count: number, registry: Registry, opts?: AllocateOpts): string[];

/** Scan .claude/agents/*.md frontmatter `name:` values (regex-only, 4KB bound). */
export function installedAgentNames(dirs?: string[] | null): Set<string>;

export interface StatsRow {
  pool: number;
  used: number;
  pct_used: number;
  generation: number;
  retired: number;
  total_allocated: number;
  remaining: number;
  unknown?: boolean;
}
export interface LedgerStats {
  categories: Record<string, StatsRow>;
  totals: StatsRow & { pct_used: number };
}
export function ledgerStats(registry: Registry, ledger: Ledger): LedgerStats;

/** The identity block for a subagent. `taskFollows=true` prepends it to the
 * task and ends with `--- YOUR TASK ---`; `taskFollows=false` returns a
 * standalone block (no task trailer) for the SubagentStart additionalContext
 * path. When `bio` is truthy, `You are named for: {bio}` is inserted before the
 * task line (or as the final line, standalone). */
export function personaPreamble(
  nickname: string, theme: string, bio?: string | null, taskFollows?: boolean,
): string;

/** Ensure `report` begins with the attribution line `[nickname]` (verify/repair
 * the prefix for the text-parsing path). Attribution does not depend on this —
 * the nickname is in the dispatch metadata regardless of agent compliance. */
export function attribute(nickname: string, report: string): string;

export interface Assignment {
  nickname: string;
  category: string;
  theme: string;
  emoji: string;
  subagent_type: string;
  description: string;
  prompt: string;
  bio: string;
  /** Params ready to splat into an Agent(...) tool call (non-enumerable). */
  agentKwargs(): { subagent_type: string; description: string; prompt: string };
}

export interface BuildOpts {
  subagentType?: string | null;
  withBio?: boolean;
}
export function buildAssignment(
  task: string, nickname: string, category: string, registry: Registry, opts?: BuildOpts
): Assignment;

export interface FanoutOpts {
  ledger?: Ledger | null;
  role?: string | null;
  category?: string | null;
  subagentType?: string | null;
  perTask?: boolean;
  pins?: Record<string, string> | null;
  avoid?: Iterable<string> | null;
  /** Union installedAgentNames(agentsDirs) into `avoid`. */
  avoidInstalled?: boolean;
  agentsDirs?: string[] | null;
  withBio?: boolean;
}
export function planFanout(tasks: string[], registry: Registry, opts?: FanoutOpts): Assignment[];
export function assignOne(task: string, registry: Registry, opts?: FanoutOpts): Assignment;

export interface LabelEntry {
  label: string;
  nickname: string;
  category: string;
  subagent_type: string;
  prompt: string;
}
/** Orchestrator adapters (D10) — pure serializers over a built plan. */
export function toLabels(plan: Assignment[]): LabelEntry[];
export function toWorkflow(plan: Assignment[]): string;
export function toSwarm(plan: Assignment[]): string;
export function toTable(plan: Assignment[]): string;

/** Python-json.dumps-compatible serializer (parity-load-bearing: identical
 * separators, ensure_ascii escaping, and float rendering to CPython). */
export function pyDumps(
  obj: unknown,
  opts?: { indent?: number | null; ensureAscii?: boolean; floatKeys?: Set<string> | null },
): string;
/** Python round(x, 1) (decimal half-to-even on the exact double). */
export function pyRound1(x: number): number;
/** Python repr() for the floats emitted by pyRound1. */
export function formatPyFloat(x: number): string;
