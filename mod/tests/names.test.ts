// Engine-level tests: `claude plugin test mod`. The test's own hooks sit beneath the mod and
// stand in for the engine: the Agent tool, the agent list, agent.spawn and the toast.
import { test, expect } from 'claude-code/testing';
import type { AgentInfo, On } from 'claude-code';

type World = { list: AgentInfo[]; names: (string | undefined)[]; toasts: string[]; listName?: (n?: string) => string | undefined };

// Beneath the mod: the Agent tool spawns (raising agent.spawn as the engine does) and the
// new agent appears in the list under the name the spawn got, unless `listName` says otherwise.
// Call nouns (agent.list, ui.toast) answer `{ value }` beneath the plugins. The spawn is
// raised on the test's own engine `$` (`top`): a hook's `$` may only call what its module's
// scan lists.
function engine(top: any, on: On, w: World) {
  let n = 0;
  on('agent.list', () => ({ value: w.list }) as never);
  on('ui.toast', ($, e) => { w.toasts.push(e.text); return { value: undefined } as never; });
  on('ui.status', () => ({ value: undefined }) as never);
  on('agent.spawn', ($, e) => {
    const id = `a${++n}`;
    w.list = [...w.list, { id, description: e.description, type: e.subagentType, status: 'running', name: w.listName ? w.listName(e.name) : e.name }];
    return { model: 'haiku', agentId: id };
  });
  on('tool.call', { tool: 'Agent' }, async ($, e) => {
    w.names.push(e.name);
    const r = await top.agent.spawn({
      tool_use_id: e.tool_use_id, prompt: e.prompt, description: e.description,
      subagentType: e.subagent_type ?? 'general-purpose', name: e.name,
    } as never);
    return { result: { agentId: r.agentId ?? '' }, text: 'ok' } as never;
  });
}

const call = ($: any, description: string, extra: Record<string, unknown> = {}) =>
  $.tool.call({ tool: 'Agent', description, prompt: 'reply ok', subagent_type: 'general-purpose', ...extra });

test('three same-type agents dispatched together get three distinct names', async ($, on) => {
  const w: World = { list: [], names: [], toasts: [] };
  engine($, on, w);
  await Promise.all([call($, 'say ok'), call($, 'say ok'), call($, 'say ok')]);
  expect(w.names.every(n => typeof n === 'string' && n.length > 0)).toBe(true);
  expect(new Set(w.names).size).toBe(3);
  expect(w.list.map(a => a.name)).toEqual(w.names);
  expect(w.toasts).toEqual([]);
});

test('a model-supplied name is left alone', async ($, on) => {
  const w: World = { list: [], names: [], toasts: [] };
  engine($, on, w);
  await call($, 'say ok', { name: 'my-reviewer' });
  expect(w.names).toEqual(['my-reviewer']);
});

test('a name already in the agent list is not drawn again', async ($, on) => {
  // Every code-pool name but one is live: the draw must land on the free one.
  const { POOL } = await import_pool();
  const code = POOL.categories.find(c => c.key === 'code')!.names;
  const w: World = { list: code.slice(1).map((name, i) => ({ id: `x${i}`, description: '', type: 'general-purpose', status: 'running', name })), names: [], toasts: [] };
  engine($, on, w);
  await call($, 'say ok');
  expect(w.names).toEqual([code[0]]);
});

test('the description is not rewritten', async ($, on) => {
  const w: World = { list: [], names: [], toasts: [] };
  engine($, on, w);
  await call($, 'say ok');
  expect(w.list[0]?.description).toBe('say ok');
});

test('a list row that does not carry the drawn name raises a toast', async ($, on) => {
  const w: World = { list: [], names: [], toasts: [], listName: () => 'Somebody' };
  engine($, on, w);
  await call($, 'say ok');
  expect(w.toasts.length).toBe(1);
  expect(w.toasts[0]).toContain('agent list shows Somebody');
});

test('theme option pins the pool', { options: { theme: 'debug' } }, async ($, on) => {
  const { POOL } = await import_pool();
  const w: World = { list: [], names: [], toasts: [] };
  engine($, on, w);
  await call($, 'implement the endpoint');
  expect(POOL.categories.find(c => c.key === 'debug')!.names).toContain(w.names[0]);
});

test('enabled=false leaves every dispatch unnamed', { options: { enabled: false } }, async ($, on) => {
  const w: World = { list: [], names: [], toasts: [] };
  engine($, on, w);
  await call($, 'say ok');
  expect(w.names).toEqual([undefined]);
});

import { POOL as _POOL } from '../hooks/pool.ts';
async function import_pool() { return { POOL: _POOL }; }
