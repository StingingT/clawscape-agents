from pathlib import Path

path = Path('src/agency/world-model.ts')
text = path.read_text()
old = """  const recentLocalProbes=memory.reviews.filter(r=>r.goal.id.startsWith('local-probe:')&&now-r.at<10*60_000).length;
  const p=state.player;
  if(supported.includes('exploration')&&recentLocalProbes<2&&state.inGame!==false&&p&&!p.isDead&&p.combat?.inCombat!==true&&state.danger?.active!==true
"""
new = """  const recentLocalProbes=memory.reviews.filter(r=>r.goal.id.startsWith('local-probe:')&&now-r.at<10*60_000).length;
  const health=progressHealth(memory,now);
  // Bootstrap discovery is maintenance, not the automatic successor to every successful goal.
  // It becomes eligible when this runtime has no productive evidence yet, when a current
  // approach is explicitly blocked, or when semantic progress health says the agent stalled.
  const discoveryBootstrap=health.lastProductiveAt===null||health.stalled||!!memory.active?.blocker;
  const p=state.player;
  if(discoveryBootstrap&&supported.includes('exploration')&&recentLocalProbes<2&&state.inGame!==false&&p&&!p.isDead&&p.combat?.inCombat!==true&&state.danger?.active!==true
"""
if text.count(old) != 1:
    raise SystemExit(f'expected one discovery bootstrap block, found {text.count(old)}')
path.write_text(text.replace(old,new,1))
