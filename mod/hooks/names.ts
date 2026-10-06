// named-subagents mod: every Agent dispatch without a model-supplied `name` gets one from
// the themed pool, so the task tree labels it. The name is display-only: the engine does
// not put it in the subagent's context, so there is no ledger, queue or file lock.
//
// tool.call{Agent}  draws a name not held by a listed agent or an in-flight draw, and
//                   sets it on the call; the description is left as is.
// agent.spawn       checks the name reached the spawn and that $.agent.list() shows it
//                   on the new id; anything else raises a toast.

import type { Register, EngineInterface } from 'claude-code';
import { pickName } from './draw.ts';
import { POOL } from './pool.ts';

const TAG = 'named-subagents';

// Drawn but not yet settled. JS runs the draw and the reserve with no await between them,
// so parallel dispatches in one message cannot draw the same name.
const reserved = new Set<string>();
// tool_use_id -> the name this module set, read back by agent.spawn to verify.
const drawn = new Map<string, string>();

function rand(): number {
  const a = new Uint32Array(1);
  crypto.getRandomValues(a);
  return (a[0] ?? 0) / 2 ** 32;
}

function alarm($: EngineInterface, text: string): void {
  // Toast plus status line: the toast fades, the status line stays until the next clean spawn.
  void Promise.resolve($.ui.toast(`${TAG}: ${text}`, { timeoutMs: 10000 })).catch(() => undefined); // audit-allow: fail-loud — the alarm itself has nowhere louder to report
  void Promise.resolve($.ui.status(`${TAG}: ${text}`)).catch(() => undefined); // audit-allow: fail-loud — same
}

export const register: Register = (on, options) => {
  if (options.enabled === false) return;
  const theme = typeof options.theme === 'string' ? options.theme : 'auto';

  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    if (e.name !== undefined && e.name !== '') return next(e); // the model named it: leave it
    const live = (await $.agent.list()).map(a => a.name).filter((n): n is string => !!n);
    const { name } = pickName(POOL, {
      subagentType: e.subagent_type, description: e.description, theme,
      taken: [...live, ...reserved], rand,
    });
    reserved.add(name);
    drawn.set(e.tool_use_id, name);
    try {
      return await next({ ...e, name });
    } finally {
      reserved.delete(name);
      drawn.delete(e.tool_use_id);
    }
  }).catch(($, e, next) => {
    alarm($, 'naming failed; this agent runs unnamed');
    return next(e); // replays the settled call if next already ran; never blocks the dispatch
  });

  on('agent.spawn', async ($, e, next) => {
    const r = await next(e);
    const want = drawn.get(e.tool_use_id);
    if (want === undefined || r.agentId === undefined) return r; // not ours, or not started
    try {
      if (e.name !== want) {
        alarm($, `drew ${want} but the spawn got ${e.name ?? 'no name'}`);
      } else {
        const row = (await $.agent.list()).find(a => a.id === r.agentId);
        if (row?.name !== want) alarm($, `drew ${want} but the agent list shows ${row?.name ?? (row ? 'no name' : 'no row')}`);
        else void Promise.resolve($.ui.status(undefined)).catch(() => undefined); // audit-allow: fail-loud — clearing a stale alarm line
      }
    } catch {
      alarm($, `could not verify ${want}`);
    }
    return r;
  }).catch(($, e, next) => next(e)); // replays the spawn if it already ran; never refuses one
};
