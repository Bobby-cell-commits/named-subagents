// mods-name-toolcall — throwaway. Answers, for Claude Code 2.1.287 function hooks:
//   Q1  does a `tool.call` rewrite of the Agent tool's `name` reach `agent.spawn` (e.name)?
//   Q2  does `next(e)` in agent.spawn give the agentId, and does `$.agent.list()` then
//       report that id with the hook-set name (exact name→agent binding, fail-loud check)?
//   Q3  is a model-supplied `name` visible to the hook (so it can be left alone)?
//
// Witnessing rule: every hook fire appends a JSONL line to <session cwd>/markers.jsonl
// via $.fs (hooks run with no Node). Never judge from $.ui.log.

import type { Register, EngineInterface } from 'claude-code';

type Json = Record<string, unknown>;

const POOL = ['Hopper', 'Lovelace', 'Turing', 'Backus', 'Knuth', 'Liskov'];
let picked = 0;
let cwd: string | undefined;
const sentName: Record<string, string> = {}; // tool_use_id -> name the hook set
let writeChain: Promise<void> = Promise.resolve();

// Serialized read-append-write: $.fs.write replaces the file, so append = read + write.
function mark($: EngineInterface, hook: string, data: Json): Promise<void> {
  const path = `${cwd ?? $.plugin.root}/markers.jsonl`;
  const line = JSON.stringify({ ts: new Date().toISOString(), hook, ...data }) + '\n';
  writeChain = writeChain.then(async () => {
    const prev = (await $.fs.exists(path)) ? await $.fs.read(path) : '';
    await $.fs.write(path, prev + line);
  }).catch(() => undefined); // audit-allow: fail-loud — probe telemetry; a lost line shows as a gap
  return writeChain;
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    cwd = e.cwd;
    const r = await next(e);
    await mark($, 'session.start', { cwd: e.cwd, root: $.plugin.root, version: await $.session.version() });
    return r;
  });

  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    const modelName = e.name;
    const name = modelName ?? POOL[picked++ % POOL.length];
    if (modelName === undefined && e.tool_use_id !== undefined) sentName[e.tool_use_id] = name;
    await mark($, 'tool.call.Agent', {
      tool_use_id: e.tool_use_id, loop: e.agentId, subagent_type: e.subagent_type,
      description: e.description, modelName, setName: modelName === undefined ? name : null,
    });
    const r = await next(modelName === undefined ? { ...e, name, description: `${name} · ${e.description}` } : e);
    await mark($, 'tool.call.Agent.result', { tool_use_id: e.tool_use_id, deny: r.deny, isError: r.isError });
    return r;
  });

  on('agent.spawn', async ($, e, next) => {
    const expected = sentName[e.tool_use_id];
    await mark($, 'agent.spawn', {
      tool_use_id: e.tool_use_id, name: e.name, expected, reached: e.name === expected,
      description: e.description, subagentType: e.subagentType, background: e.background,
    });
    const r = await next(e);
    const list = await $.agent.list();
    const row = list.find(a => a.id === r.agentId);
    await mark($, 'agent.spawn.bound', {
      agentId: r.agentId, deny: r.deny, expected, listed: row ?? null,
      nameStuck: row !== undefined && row.name === expected,
    });
    return r;
  });

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) {
      const row = (await $.agent.list()).find(a => a.id === e.agentId);
      await mark($, 'turn.complete', { agentId: e.agentId, name: row?.name, status: row?.status });
    }
    return next(e);
  });
};
