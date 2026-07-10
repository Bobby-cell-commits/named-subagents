#!/usr/bin/env node
/** Demo (JS): themed, non-repeating fan-out with a shared ledger. Mirrors demo.py. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Registry, Ledger, planFanout } from "./named_subagents.mjs";

const REG = Registry.load();

const ROUNDS = [
  ["Explore", ["map the auth module", "map the billing module", "map the search module"]],
  [null, ["why was the event-sourcing abstraction chosen here", "what tradeoff does the cache TTL encode"]],
  [null, ["find the root cause of the flaky login test", "diagnose the crash in the export worker"]],
];

const d = mkdtempSync(join(tmpdir(), "ns-demo-"));
const ledgerPath = join(d, "ledger.json");
try {
  ROUNDS.forEach(([role, tasks], i) => {
    const plan = planFanout(tasks, REG, { ledger: new Ledger(ledgerPath), role });
    const cat = plan[0].category;
    console.log(`\n── round ${i + 1}: ${REG.emoji(cat)} ${REG.theme(cat)} (category=${cat}) ──`);
    for (const a of plan) {
      const task = a.prompt.split("--- YOUR TASK ---\n").pop();
      console.log(`  ${a.emoji} ${a.nickname.padEnd(12)} [${a.subagent_type}]  ${task}`);
    }
  });

  const mixed = planFanout(
    ["map the payment webhook handler",
     "ponder the rationale behind the state-machine design",
     "diagnose the intermittent 502 crash from the proxy",
     "write the documentation for the search endpoint"],
    REG, { ledger: new Ledger(ledgerPath), perTask: true });
  console.log("\n── round 4: per_task=true — each task themed independently ──");
  for (const a of mixed) console.log(`  ${a.emoji} ${a.nickname.padEnd(12)} ${a.category.padEnd(10)} [${a.subagent_type}]`);

  const led = new Ledger(ledgerPath);
  console.log("\nledger summary (names consumed this session):");
  for (const [cat, rec] of Object.entries(led.state)) console.log(`  ${cat.padEnd(10)} gen=${rec.generation}  used=${JSON.stringify(rec.used)}`);
} finally {
  rmSync(d, { recursive: true, force: true });
}
