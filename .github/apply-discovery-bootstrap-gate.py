from pathlib import Path

path = Path('src/agency/world-model.ts')
text = path.read_text()
def replace(old, new):
    global text
    if text.count(old) != 1:
        raise SystemExit(f'expected one bootstrap match, found {text.count(old)}: {old[:100]!r}')
    text = text.replace(old, new, 1)

replace("  const recentLocalProbes=memory.reviews.filter(r=>r.goal.id.startsWith('local-probe:')&&now-r.at<10*60_000).length;\n  const p=state.player;\n  if(supported.includes('exploration')&&recentLocalProbes<2&&state.inGame!==false&&p&&!p.isDead&&p.combat?.inCombat!==true&&state.danger?.active!==true\n",
"""  // Count actual survey goal IDs (and legacy IDs), including unsuccessful probes.
  const recentLocalProbes=memory.reviews.filter(r=>/^(?:survey:)?local-probe:/.test(r.goal.id)&&now-r.at<10*60_000).length;
  const health=progressHealth(memory,now);
  const discoveryBootstrap=health.lastProductiveAt===null||health.stalled||!!memory.active?.blocker;
  const p=state.player;
  const safeProbeState=state.inGame===true&&!!p&&!p.isDead&&Number(p.hp)>0
    &&p.combat?.inCombat!==true&&state.danger?.active!==true;
  const probeEligible=(route:Route)=>safeProbeState&&(memory.active?.id==='survey:'+route.id
    ||discoveryBootstrap&&recentLocalProbes<2);
  if(discoveryBootstrap&&safeProbeState&&supported.includes('exploration')&&recentLocalProbes<2
""")
replace("    && (!r.id.startsWith('local-probe:')||recentLocalProbes<2)",
"    // Previously generated routes must pass the same gate; generation-only gating leaks stale probes.\n    && (!r.id.startsWith('local-probe:')||probeEligible(r))")
path.write_text(text)
