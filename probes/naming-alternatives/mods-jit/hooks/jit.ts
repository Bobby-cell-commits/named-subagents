// mods-jit — throwaway. Design (c): register a callsign just in time inside agent.spawn,
// keep it out of the model's agent listing via agent.offer, dispatch to it.
// mode.txt (plugin root) selects:  show  = no offer filter (baseline listing cost)
//                                  hide  = isOffered:false for every JIT name, always
//                                  gate  = isOffered:false unless a spawn for that name is in flight
//                                  call  = isOffered:false unless an Agent tool.call is in progress
//                                          (tool.call runs before the dispatch-time offer batch,
//                                          never during the per-turn listing)
//                                  tight = isOffered:true only for the ONE type an in-progress Agent
//                                          call reserved (picked in tool.call, keyed by tool_use_id)
//   pre-<m>[-N] = same offer rule, but the names are registered up front at session.start (JIT inside
//             spawn is refused: the call's dispatchable set is fixed before the hook runs).
// Witness: every fire appends a JSONL line to markers.jsonl via $.fs.
import type { Register, EngineInterface } from 'claude-code';
type Json = Record<string, unknown>;
const POOL = ['Hopper', 'Lovelace', 'Noether', 'Shackleton', 'Tereshkova', 'Amundsen', 'Kovalevskaya', 'Ibn_Battuta'];
const jit = new Set<string>();      // full registered type names
const inflight = new Set<string>(); // types a spawn is dispatching right now
let calls = 0; // Agent tool.calls in progress
const reserved = new Map<string, string>(); // tool_use_id -> type (tight mode)
let cursor = 0;
let n = 0; let mode: string | undefined;
let chain: Promise<void> = Promise.resolve();
function mark($: EngineInterface, hook: string, data: Json): Promise<void> {
  const path = `${$.plugin.root}/markers.jsonl`;
  const line = JSON.stringify({ ts: new Date().toISOString(), hook, ...data }) + '\n';
  chain = chain.then(async () => {
    const prev = (await $.fs.exists(path)) ? await $.fs.read(path) : '';
    await $.fs.write(path, prev + line);
  }).catch(() => undefined); // audit-allow: fail-loud — probe telemetry
  return chain;
}
async function getMode($: EngineInterface): Promise<string> {
  if (mode === undefined) {
    const p = `${$.plugin.root}/mode.txt`;
    mode = (await $.fs.exists(p)) ? String(await $.fs.read(p)).trim() : 'show';
  }
  return mode;
}
async function reg($: EngineInterface, name: string): Promise<string | undefined> {
  // @ts-expect-error — $.agent.register is in the 2.1.283 binary, not the 2.1.273 typings
  const r: unknown = await $.agent.register({
    name, description: `callsign ${name}`,
    prompt: `You are ${name}. Begin your final reply with the exact line [${name}]. You are a capable general agent; complete the task.`,
  });
  return (r as { agent?: string } | undefined)?.agent;
}
const pre: string[] = [];
export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    const r = await next(e);
    const m = await getMode($);
    const poolAll: string[] = JSON.parse(String(await $.fs.read(`${$.plugin.root}/pool.json`)));
    if (m.startsWith('pre-')) {
      const t0 = Date.now();
      const count = Number(m.split('-')[2] ?? POOL.length);
      for (let i = 0; i < count; i++) {
        const name = count <= POOL.length ? POOL[i]! : poolAll[i]!;
        try { const t = await reg($, name); if (t) { pre.push(t); jit.add(t); } }
        catch (err) { await mark($, 'agent.register', { name, error: String(err) }); }
      }
      await mark($, 'session.start', { mode: m, registered: pre.length, first: pre.slice(0, 3), ms: Date.now() - t0 });
    }
    return r;
  });
  on('agent.offer', async ($, e, next) => {
    const r = await next(e);
    const m = await getMode($);
    let isOffered = r.isOffered;
    const base = m.replace(/^pre-/, '').split('-')[0];
    if (jit.has(e.agent) && base === 'hide') isOffered = false;
    if (jit.has(e.agent) && base === 'gate') isOffered = inflight.has(e.agent);
    if (jit.has(e.agent) && base === 'call') isOffered = calls > 0;
    if (jit.has(e.agent) && base === 'tight') isOffered = [...reserved.values()].includes(e.agent);
    if (pre.slice(0, 2).includes(e.agent) || e.agent === 'general-purpose') await mark($, 'agent.offer', { mode: m, agent: e.agent, isOffered });
    return { isOffered };
  });
  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    const id = (e as unknown as Json).tool_use_id as string;
    const input = e as unknown as Json;
    const st = (input.subagent_type ?? 'general-purpose') as string;
    if (pre.length > 0 && st === 'general-purpose') reserved.set(id, pre[cursor++ % pre.length]!);
    calls++;
    try { return await next(e); } finally { calls--; reserved.delete(id); }
  });
  on('agent.spawn', async ($, e, next) => {
    const m = await getMode($);
    const k = n++;
    if (e.subagentType !== 'general-purpose') return next(e);
    if (m.startsWith('pre-')) {
      const type = reserved.get(e.tool_use_id) ?? pre[k % Math.max(pre.length, 1)];
      if (type === undefined) return next(e);
      const name = type.split(':')[1]!;
      inflight.add(type);
      try {
        const r = await next({ ...e, subagentType: type, description: `${name} · ${e.description}` });
        await mark($, 'agent.spawn.result', { mode: m, k, type, result: r as Json });
        return r;
      } catch (err) {
        await mark($, 'agent.spawn.error', { mode: m, k, type, error: String(err) });
        throw err;
      } finally { inflight.delete(type); }
    }
    const name = POOL[k % POOL.length]!;
    let type: string | undefined;
    try {
      // @ts-expect-error — $.agent.register is in the 2.1.283 binary, not the 2.1.273 typings
      const r: unknown = await $.agent.register({
        name, description: `callsign ${name}`,
        prompt: `You are ${name}. Begin your final reply with the exact line [${name}]. You are a capable general agent; complete the task.`,
      });
      type = (r as { agent?: string } | undefined)?.agent;
      await mark($, 'agent.register', { mode: m, k, name, returned: r as Json });
    } catch (err) {
      await mark($, 'agent.register', { mode: m, k, name, error: String(err) });
      return next(e);
    }
    if (type === undefined) return next(e);
    jit.add(type); inflight.add(type);
    try {
      const r = await next({ ...e, subagentType: type, description: `${name} · ${e.description}` });
      await mark($, 'agent.spawn.result', { mode: m, k, type, result: r as Json });
      return r;
    } catch (err) {
      await mark($, 'agent.spawn.error', { mode: m, k, type, error: String(err) });
      throw err;
    } finally { inflight.delete(type); }
  });
  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) await mark($, 'turn.complete', { agentId: e.agentId, answer: typeof e.answer === 'string' ? e.answer.slice(0, 80) : e.answer });
    return next(e);
  });
};
