// Witness for mod/ (named-subagents-mod). Appends JSONL to <session cwd>/markers.jsonl:
//   tool.call.Agent   the name the call carries when it reaches this hook (order-dependent)
//   agent.spawn       e.name at spawn, then the list row's name for the new id
//   turn.complete     each subagent's listed name when its loop ends ("did it stick")
import type { Register, EngineInterface } from 'claude-code';

let cwd: string | undefined;
let chain: Promise<void> = Promise.resolve();
function mark($: EngineInterface, hook: string, data: Record<string, unknown>): Promise<void> {
  const path = `${cwd ?? $.plugin.root}/markers.jsonl`;
  const line = JSON.stringify({ ts: new Date().toISOString(), hook, ...data }) + '\n';
  chain = chain.then(async () => {
    const prev = (await $.fs.exists(path)) ? await $.fs.read(path) : '';
    await $.fs.write(path, prev + line);
  }).catch(() => undefined); // audit-allow: fail-loud — probe telemetry; a lost line shows as a gap
  return chain;
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    cwd = e.cwd;
    const r = await next(e);
    await mark($, 'session.start', { version: await $.session.version() });
    return r;
  });
  on('agent.spawn', async ($, e, next) => {
    const r = await next(e);
    const row = (await $.agent.list()).find(a => a.id === r.agentId);
    await mark($, 'agent.spawn', { tool_use_id: e.tool_use_id, spawnName: e.name, agentId: r.agentId, listName: row?.name, type: e.subagentType, description: e.description });
    return r;
  });
  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) {
      const row = (await $.agent.list()).find(a => a.id === e.agentId);
      await mark($, 'turn.complete', { agentId: e.agentId, listName: row?.name, status: row?.status });
    }
    return next(e);
  });
};
