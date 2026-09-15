from pathlib import Path

def replace(path, old, new):
    p=Path(path); s=p.read_text()
    if old not in s: raise SystemExit(f'anchor missing: {path}: {old[:80]!r}')
    p.write_text(s.replace(old,new,1))

replace('src/agency/director.ts',
'  /** Refresh the food dependency, not the strategic objective or a pending receipt. */',
'''  /** Retire a bounded attempt that has no executable step in the fresh world state. */
  deferCurrent(at:number,reason:string,evidence:string[]):void {
    if(this.memory.pending)throw new Error('RECONCILE_PENDING_ACTION_FIRST');
    if(!this.memory.active)return;
    this.review(at,'partial',reason,evidence);
  }

  /** Refresh the food dependency, not the strategic objective or a pending receipt. */''')

replace('src/agency/live-adapter.ts',
'  deferSurvey(route:Route,state:LiveState,reason:string):void {',
'''  deferCurrent(state:LiveState,reason:string):void {
    if(this.document.receipt||this.document.safetyReceipt)throw new Error('RECONCILE_PENDING_ACTION_FIRST');
    const goal=this.director.memory.active;if(!goal)return;
    this.director.deferCurrent(this.clock(),reason,[`fresh-no-executor:${state.tick}:${goal.id}`]);
    delete this.document.route;this.document.blocked=reason;this.save();
  }
  deferSurvey(route:Route,state:LiveState,reason:string):void {''')

replace('src/agent.ts',
"    case 'equipment': return gearCandidates(state);",
'''    case 'equipment': {
      // Prefer fresh carried/equipped observations and the agent's own observed bank before seeking another item.
      const owned=await equipmentGoals.next(state,(from,to)=>navigator!.assess(from,to));
      return owned?[owned as Candidate]:gearCandidates(state);
    }''')
replace('src/agent.ts',
"      } else if(!agency.summary().blocked && !agency.summary().acquisition?.need) agency.blocked('Selected task has no feasible current executor step: '+planned.task.id);",
'''      } else if(!agency.summary().acquisition?.need) {
        agency.deferCurrent(state,'Selected task has no feasible current executor step: '+planned.task.id);
      }''')

replace('agents/advanced/src/live-cli.ts',
'''      if(decision.blocked){
        // A disappearing NPC or a short UI transition is a new observation''',
'''      if(decision.blocked){
        if(agency&&planned?.task.kind==='exploration'&&planned.task.route&&!agency.pending()&&!agency.pending('safety')){
          agency.deferSurvey(planned.task.route,agencyState(latest),decision.blocked);
          publish('REPLANNING',decision.blocked);await sleep(700);continue;
        }
        // A disappearing NPC or a short UI transition is a new observation''')
replace('agents/advanced/src/live-cli.ts',
"        if(step.blocked){if(agency&&!agency.pending())agency.blocked(step.blocked);policy.recordOutcome(latest,latest,decision,'FAILED');publish('REPLANNING',step.blocked);failed++;await sleep(700);continue;}",
'''        if(step.blocked){
          if(agency&&!agency.pending()){
            if(planned?.task.kind==='exploration'&&planned.task.route)agency.deferSurvey(planned.task.route,agencyState(latest),step.blocked);
            else agency.deferCurrent(agencyState(latest),step.blocked);
          }
          policy.recordOutcome(latest,latest,decision,'FAILED');publish('REPLANNING',step.blocked);failed++;await sleep(700);continue;
        }''')

replace('agents/advanced/src/live-policy.ts',
'''      if (current < 0) return block("equipment", shield ? "MISSING_SHIELD" : "MISSING_SWORD", "No supported wielded or inventory sword/shield; an acquisition route is required before combat.");''',
'''      if (current < 0) {
        const stored=(o.bank.open?o.bank.items??[]:[]).filter(i=>i.count>0&&rank(i,shield)>=0)
          .sort((a,b)=>rank(b,shield)-rank(a,shield)||a.slot-b.slot)[0];
        if(stored)return {goal:shield?'equipment:shield-bank':'equipment:sword-bank',reason:'Withdraw the strongest usable owned upgrade from the freshly observed bank; no item or slot is assumed.',
          intent:{operation:'withdraw',slot:stored.slot,item_id:stored.id,amount:1}};
        if(!o.bank.open&&this.state.bankLead)return this.startBank(o);
        return block("equipment", shield ? "MISSING_SHIELD" : "MISSING_SWORD", "No supported wielded, carried, or freshly observed banked sword/shield; an acquisition route is required before combat.");
      }''')
