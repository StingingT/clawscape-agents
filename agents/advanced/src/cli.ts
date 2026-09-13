import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { Config, CompatibilityProfile } from "./contracts.ts";
import { Store } from "./store.ts";
import { Learner, contextKey } from "./learning.ts";
import { METHODS, runBankDemo, simulatedEpisode, snapshot } from "./simulation.ts";
import { ClawscapeObserver } from "./observer.ts";

const root = resolve(import.meta.dir,"..");
const args = process.argv.slice(2), command = args[0] ?? "help";
const option = (name: string) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i+1]; };
const dbPath = resolve(root,"data/astra-simulation.sqlite");
async function main() {
  if (command === "help") {
    console.log("Astra v0.1 — separate agent, LIVE ACTIONS DISABLED\n"
      + "demo                  Run a short synthetic action/learning demonstration\n"
      + "observe --config FILE Read Astra's already-connected CLI session; never logs in\n"
      + "status                Read simulation controls, latest snapshot and learning\n"
      + "pause | stop | takeover | hard-disable | release-manual | resume\n"
      + "start --simulation    Alias for the bounded demo (not continuous live play)");
    return;
  }
  if (command === "observe") {
    const file = option("--config");
    if (!file) throw new Error("Supply a private --config file; see config.example.json");
    const cfg = Config.parse(JSON.parse(readFileSync(resolve(file),"utf8")));
    if (cfg.mode !== "observe" || !cfg.character || !cfg.cli_home) throw new Error("Configure read-only character and CLI home first");
    if (cfg.character !== "astra") throw new Error("This project is reserved for Astra, not an existing agent");
    const profile = CompatibilityProfile.parse(JSON.parse(readFileSync(resolve(root,"docs/compatibility-profile.json"),"utf8")));
    const observer = new ClawscapeObserver(resolve(root,cfg.game_root),resolve(root,cfg.cli_home),
      cfg.character,cfg.world,profile.profile_id,cfg.keep_item_ids);
    const o = await observer.snapshot();
    // Selective operator output: not raw CLI text/chat, account config, or credentials.
    console.log(JSON.stringify({ mode: "READ_ONLY",character: o.character,connected: o.connected,
      position: o.position,hp: o.hp,max_hp: o.max_hp,skills: o.skills,inventory: o.inventory,
      world_epoch: o.world_epoch,unavailable: o.unavailable },null,2));
    return;
  }
  if (command === "start" && !args.includes("--simulation")) throw new Error("LIVE_DISPATCH_RELEASE_GATE");
  if (!["status","demo","start","pause","stop","takeover","hard-disable","release-manual","resume"].includes(command)) throw new Error("UNKNOWN_COMMAND");
  if (command === "status" && !existsSync(dbPath)) {
    console.log(JSON.stringify({ character: "Astra",mode: "NOT_STARTED",live: false })); return;
  }
  mkdirSync(resolve(root,"data"),{recursive: true});
  const store = new Store(dbPath);
  try {
    const controls = { pause: "PAUSED",stop: "STOPPED",takeover: "MANUAL","hard-disable": "DISABLED" } as const;
    if (command in controls) {
      store.setControl(controls[command as keyof typeof controls]);
      console.log(JSON.stringify({ scope: "local simulation controller only",control: store.control(),
        warning: "Stopping an agent does not freeze the game or disconnect a live character." }));
    } else if (command === "release-manual" || command === "resume") {
      store.releaseManual();
      console.log("Simulation control released; run demo to begin another bounded trial. Live actions remain disabled.");
    } else if (command === "demo" || command === "start") {
      const bank = await runBankDemo(store);
      const learner = new Learner(store,20260907);
      const context = contextKey(snapshot(),"fixture-course");
      const prefix = crypto.randomUUID();
      const initial = learner.select(context,METHODS,0,true);
      for (let n=0;n<30;n++) {
        const selection = learner.select(context,METHODS,0);
        learner.record(simulatedEpisode(selection.method!,n,false,prefix));
      }
      console.log(JSON.stringify({ character: "Astra",evidence_type: "SIMULATION_ONLY",bank,
        learning: { initial,after: learner.select(context,METHODS,0,true),episodes_added: 30 },
        live_character_created: false,live_game_actions: 0,model_calls: 0 },null,2));
    } else {
      const summaries = store.records<{method: string;n: number;mean: number}>("method_estimates");
      const latest = new Map(summaries.map(s => [s.method,s]));
      console.log(JSON.stringify({ character: "Astra",evidence_type: "SIMULATION_ONLY",
        control: store.control(),pending: store.pending().map(p => p.result),
        latest_snapshot: store.records("observations_or_checkpoints").at(-1) ?? null,
        episodes: store.records("episodes").length,estimates: [...latest.values()],
        live_play: "RELEASE_GATED",model: "DISABLED",npc_spending_gp: 0 },null,2));
    }
  } finally { store.close(); }
}
try { await main(); }
catch (error) {
  // Never echo raw external process output or nested causes.
  console.error(JSON.stringify({ error: error instanceof Error ? error.message.slice(0,300) : "FAILED" }));
  process.exitCode = 1;
}
