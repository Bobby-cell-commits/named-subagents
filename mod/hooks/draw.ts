// Pure name-drawing logic: no engine calls, so it is unit-tested with plain node.

export type Category = {
  key: string;
  subagent_types: string[];
  keywords: string[];
  names: string[];
};
export type Pool = { categories: Category[] };

/** Roles that say nothing about the task: their description's keywords decide first. */
export const GENERIC_ROLES = ['general-purpose', 'worker'];
/** What the Agent tool runs when `subagent_type` is omitted. */
const DEFAULT_ROLE = 'general-purpose';
const FALLBACK = 'default';

function byType(pool: Pool, role: string): string | undefined {
  const r = role.trim().toLowerCase();
  return pool.categories.find(c => c.subagent_types.some(t => t.toLowerCase() === r))?.key;
}

function byKeyword(pool: Pool, text: string): string | undefined {
  const t = text.toLowerCase();
  let best: string | undefined;
  let bestHits = 0;
  for (const c of pool.categories) {
    const hits = c.keywords.filter(k => t.includes(k)).length;
    if (hits > bestHits) { best = c.key; bestHits = hits; } // strict >: ties keep the earlier category
  }
  return best;
}

/**
 * Category for one dispatch: a valid `theme` pins it; otherwise a specific role wins,
 * a generic role defers to description keywords, and the default pool catches the rest.
 * Mirrors the Python package's resolve_for_hook.
 */
export function categoryFor(pool: Pool, subagentType?: string, description?: string, theme = 'auto'): string {
  if (theme !== 'auto' && pool.categories.some(c => c.key === theme)) return theme;
  const role = subagentType ?? DEFAULT_ROLE;
  const fromType = byType(pool, role);
  const fromTask = description ? byKeyword(pool, description) : undefined;
  if (GENERIC_ROLES.includes(role.trim().toLowerCase())) return fromTask ?? fromType ?? FALLBACK;
  return fromType ?? fromTask ?? FALLBACK;
}

/**
 * A name from `category` not in `taken` (case-insensitive). An exhausted category spills
 * to the default pool, then to any free name; with all taken, a numbered suffix.
 */
export function drawName(pool: Pool, category: string, taken: Iterable<string>, rand: () => number): string {
  const used = new Set([...taken].map(n => n.toLowerCase()));
  const free = (names: string[]) => names.filter(n => !used.has(n.toLowerCase()));
  const home = pool.categories.find(c => c.key === category) ?? pool.categories.find(c => c.key === FALLBACK);
  const tiers = [home?.names ?? [], pool.categories.find(c => c.key === FALLBACK)?.names ?? [], pool.categories.flatMap(c => c.names)];
  for (const tier of tiers) {
    const f = free(tier);
    const pick = f[Math.min(f.length - 1, Math.floor(rand() * f.length))];
    if (pick !== undefined) return pick;
  }
  const base = home?.names[0] ?? 'Agent';
  for (let n = 2; ; n++) if (!used.has(`${base}-${n}`.toLowerCase())) return `${base}-${n}`;
}

export type PickInput = {
  subagentType?: string;
  description?: string;
  theme?: string;
  taken: Iterable<string>;
  rand: () => number;
};

export function pickName(pool: Pool, i: PickInput): { name: string; category: string } {
  const category = categoryFor(pool, i.subagentType, i.description, i.theme);
  return { name: drawName(pool, category, i.taken, i.rand), category };
}
