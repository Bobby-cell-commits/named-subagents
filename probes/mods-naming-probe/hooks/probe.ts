// mods-naming-probe — throwaway. Answers, for Claude Code 2.1.283 function hooks:
//   Q1  does `agent.spawn` fire for background-dispatched agents?
//   Q2  does rewriting `description` in agent.spawn become the agent's row label?
//   Q3  can `$.agent.register` add an agent type at runtime (ProbeHudson), and can
//       an agent.spawn rewrite of `subagentType` dispatch to it?
//   +   what `turn.complete` carries for a subagent (agentId?) — needed for name release.
//
// Witnessing rule: every hook fire appends a JSONL line to <plugin root>/markers.jsonl
// via $.fs (hooks run with no Node, so no node:fs). Never judge from $.ui.log.

import type { Register, EngineInterface } from 'claude-code';

type Json = Record<string, unknown>;

const PROBE_AGENT = 'ProbeHudson';
let registeredAs: string | undefined; // what $.agent.register returned ({ agent })
let registerTried = false;
let spawnCount = 0;
let writeChain: Promise<void> = Promise.resolve();

const clip = (s: unknown, n = 160): unknown =>
  typeof s === 'string' && s.length > n ? `${s.slice(0, n)}…(${s.length})` : s;

// Serialized read-append-write: $.fs.write replaces the file, so append = read + write.
function mark($: EngineInterface, hook: string, data: Json): Promise<void> {
  const path = `${$.plugin.root}/markers.jsonl`;
  const line = JSON.stringify({ ts: new Date().toISOString(), hook, ...data }) + '\n';
  writeChain = writeChain.then(async () => {
    const prev = (await $.fs.exists(path)) ? await $.fs.read(path) : '';
    await $.fs.write(path, prev + line);
  }).catch(() => undefined); // audit-allow: fail-loud — probe telemetry; a lost line shows as a gap
  return writeChain;
}

async function snapshotAgents($: EngineInterface, why: string): Promise<void> {
  try {
    const list = await $.agent.list();
    await mark($, 'agent.list', { why, agents: list });
  } catch (err) {
    await mark($, 'agent.list', { why, error: String(err) });
  }
}

async function tryRegister($: EngineInterface, from: string): Promise<void> {
  if (registerTried) return;
  registerTried = true;
  try {
    // @ts-expect-error — $.agent.register exists in the 2.1.283 binary, not in the 2.1.273 typings.
    const r: unknown = await $.agent.register({
      name: PROBE_AGENT,
      description: 'Probe persona registered at runtime by the mods-naming-probe plugin. Use for trivial probe tasks.',
      prompt: `You are ${PROBE_AGENT}, a probe agent. Start your reply with the line [${PROBE_AGENT}] and then answer in one word.`,
      model: 'haiku',
      tools: ['Read'],
    });
    registeredAs = (r as { agent?: string } | undefined)?.agent;
    await mark($, 'agent.register', { from, ok: true, returned: r as Json });
  } catch (err) {
    await mark($, 'agent.register', { from, ok: false, error: String(err) });
  }
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    const r = await next(e);
    await mark($, 'session.start', { cwd: e.cwd, isInteractive: e.isInteractive, surface: e.surface });
    await tryRegister($, 'session.start');
    return r;
  });

  on('turn.start', async ($, e, next) => {
    await mark($, 'turn.start', { turnId: e.turnId, text: clip(e.text, 80) });
    await tryRegister($, 'turn.start'); // fallback if session.start did not fire / had no session
    return next(e);
  });

  on('agent.offer', async ($, e, next) => {
    const r = await next(e);
    if (/probe|general-purpose/i.test(e.agent)) {
      await mark($, 'agent.offer', { agent: e.agent, source: e.source, provider: e.provider, isOffered: r.isOffered });
    }
    return r;
  });

  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    const input = e as unknown as Json;
    await mark($, 'tool.call.Agent', {
      tool_use_id: input.tool_use_id, agentId: input.agentId,
      subagent_type: input.subagent_type, description: input.description,
      run_in_background: input.run_in_background, name: input.name,
    });
    const r = await next(e);
    await mark($, 'tool.call.Agent.result', { tool_use_id: input.tool_use_id, result: clip(JSON.stringify(r), 600) });
    return r;
  });

  on('agent.spawn', async ($, e, next) => {
    const n = ++spawnCount;
    await mark($, 'agent.spawn', {
      n, tool_use_id: e.tool_use_id, description: e.description, subagentType: e.subagentType,
      background: e.background, fork: e.fork, name: e.name, parentAgentId: e.parentAgentId,
      model: e.model, provider: e.provider, prompt: clip(e.prompt, 80),
    });
    const rewritten = { ...e, description: `Probe-${n} · ${e.description}` };
    // Q3: route the 2nd general-purpose spawn to the runtime-registered type.
    if (n === 2 && registeredAs !== undefined && e.subagentType === 'general-purpose') {
      rewritten.subagentType = registeredAs;
    }
    try {
      const r = await next(rewritten);
      await mark($, 'agent.spawn.result', {
        n, sentDescription: rewritten.description, sentSubagentType: rewritten.subagentType, result: r as Json,
      });
      await snapshotAgents($, `after spawn ${n}`);
      return r;
    } catch (err) {
      await mark($, 'agent.spawn.error', { n, sentSubagentType: rewritten.subagentType, error: String(err) });
      throw err;
    }
  });

  on('turn.complete', async ($, e, next) => {
    await mark($, 'turn.complete', {
      agentId: e.agentId, turnId: e.turnId, reason: e.reason, isAborted: e.isAborted,
      durationMs: e.durationMs, answer: clip(e.answer, 120),
    });
    if (e.agentId !== undefined) await snapshotAgents($, `turn.complete ${e.agentId}`);
    return next(e);
  });
};
