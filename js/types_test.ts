// Compile-only test (never executed): `tsc -p tsconfig.json` type-checks the
// public surface of named_subagents.d.ts by USING it exactly as a downstream
// consumer would. It catches signature drift between the hand-written .d.ts and
// the .mjs runtime — the `@ts-expect-error` blocks prove the types actually
// REJECT misuse (a too-loose declaration would fail here). The runtime suite's
// "Type surface" section is the complementary export-name reconciliation guard.
//
// "named-subagents" resolves to ./named_subagents.d.ts via tsconfig `paths`.
import {
  Registry, Ledger, PoolExhaustedError,
  VERSION, GEN_SEP, CONFIG_ENV_VAR, NO_CWD_CONFIG_ENV_VAR, CWD_CONFIG_ENV_VAR,
  LEDGER_VERSION, NAME_PATTERN, CATEGORY_KEY_PATTERN, DEFAULT_REGISTRY_URL,
  stripGen, validName, ledgerRecordIssue, loadConfig, loadWithConfig,
  cwdConfigEnabled, resolveCategory, allocate, installedAgentNames, ledgerStats,
  personaPreamble, attribute, buildAssignment, planFanout, assignOne, toLabels,
  toWorkflow, toSwarm, pyDumps, pyRound1, formatPyFloat,
} from "named-subagents";
import type {
  CategorySpec, RegistryData, UserConfig, ResolveOpts, LedgerRecord,
  AllocateOpts, StatsRow, LedgerStats, Assignment, BuildOpts, FanoutOpts,
  LabelEntry,
} from "named-subagents";

// --- constants carry their declared primitive types ---
const _v: string = VERSION;
const _g: string = GEN_SEP;
const _ce: string = CONFIG_ENV_VAR;
const _nc: string = NO_CWD_CONFIG_ENV_VAR;
const _cc: string = CWD_CONFIG_ENV_VAR;
const _lv: number = LEDGER_VERSION;
const _np: string = NAME_PATTERN;
const _ck: string = CATEGORY_KEY_PATTERN;
const _du: URL = DEFAULT_REGISTRY_URL;

// --- the runtime surface, exercised with correct argument/return types ---
const reg: Registry = Registry.load();
const reg2: Registry = Registry.load(null, { config: loadConfig() });
const cfg: UserConfig = loadConfig("x.json", true);
const rc: { registry: Registry; config: UserConfig } = loadWithConfig(null, null, false);
const cat: string = resolveCategory(reg, { role: "Explore", task: "map", category: null });
const names: string[] = allocate("explore", 3, reg, { ledger: null, avoid: ["x"] });
const led: Ledger = new Ledger(null);
const sess: string[] = led.session((l) => l.used("explore"));
const stats: LedgerStats = ledgerStats(reg, led);
const plan: Assignment[] = planFanout(["a", "b"], reg, { ledger: led, perTask: true });
const one: Assignment = assignOne("task", reg, { withBio: true });
const kwargs: { subagent_type: string; description: string; prompt: string } = one.agentKwargs();
const labels: LabelEntry[] = toLabels(plan);
const wf: string = toWorkflow(plan);
const sw: string = toSwarm(plan);
const pre: string = personaPreamble("Magellan", "Explorers", "a navigator");
const attributed: string = attribute("Magellan", "[Cook]\nbody");
const issue: string | null = ledgerRecordIssue({ used: [] });
const enabled: boolean = cwdConfigEnabled(true);
const stripped: string = stripGen("Magellan·2");
const valid: boolean = validName("Magellan");
const installed: Set<string> = installedAgentNames(null);
const dumped: string = pyDumps({ a: 1 }, { indent: 2, floatKeys: new Set(["x"]) });
const floatRepr: string = formatPyFloat(pyRound1(1.25));
const err: PoolExhaustedError = new PoolExhaustedError("empty");

// --- type-only interfaces are all referenceable + structurally checked ---
const _cs: CategorySpec = { names: ["A"] };
const _rd: RegistryData = { categories: {} };
const _ro: ResolveOpts = { role: "x" };
const _lr: LedgerRecord = { used: ["A"], generation: 1 };
const _ao: AllocateOpts = { pins: { security: "Argus" } };
const _sr: StatsRow = {
  pool: 1, used: 0, pct_used: 0, generation: 1, retired: 0, total_allocated: 0, remaining: 1,
};
const _bo: BuildOpts = { withBio: true };
const _fo: FanoutOpts = { avoidInstalled: true };
const _asg: Assignment = buildAssignment("t", "Magellan", "explore", reg, { withBio: false });

// --- negative checks: a correct .d.ts MUST reject each of these ---
// @ts-expect-error count must be a number, not a string
allocate("explore", "3", reg);
// @ts-expect-error loadConfig takes at most two arguments
loadConfig("x.json", true, "extra");
// @ts-expect-error Registry.load's config option is typed (not a number)
Registry.load(null, { config: 123 });
// @ts-expect-error cwdConfigEnabled takes boolean | null, not a string
cwdConfigEnabled("yes");

// Reference every binding so an unused-local error can't mask a resolution
// failure (each name here had to resolve against the .d.ts to type-check).
export const _surface = [
  _v, _g, _ce, _nc, _cc, _lv, _np, _ck, _du, reg, reg2, cfg, rc, cat, names, led,
  stats, sess, plan, one, kwargs, labels, wf, sw, pre, attributed, issue,
  enabled, stripped, valid, installed, dumped, floatRepr, err, _cs, _rd, _ro,
  _lr, _ao, _sr, _bo, _fo, _asg,
] as const;
