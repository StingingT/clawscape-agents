import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {join,dirname,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {TrainingDiscovery} from '../../src/training/discovery.ts';
import {AdaptiveRuntime,readAdaptiveReport} from '../../src/training/adaptive-runtime.ts';
import {defaultAdaptiveSettings,readAdaptiveSettings,ADAPTIVE_CONFIG} from '../../src/training/adaptive-settings.ts';
import {emptyAdaptive,beginEncounter,observeEncounter,finishEncounter,contextKey,captureContext,readinessDecision} from '../../src/training/adaptive-combat.ts';
import {state,target,event,record} from './fixtures.ts';
const NOW=1_000_000;
const gearOptions=(s:any)=>[101,102].map(id=>({id,slot:3,name:'Known sword',allowed:s.skills[0].baseLevel>=1,reason:'fixture verified'}));
const opts=(root:string)=>({root,gearOptions});
function fixture(t:any,extra:any={}){
 const root=mkdtempSync(join(tmpdir(),'adaptive-combat-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const config=join(root,ADAPTIVE_CONFIG);mkdirSync(dirname(config),{recursive:true});writeFileSync(config,JSON.stringify({...defaultAdaptiveSettings(),...extra}));
 const file=join(root,'data/stinger/training-knowledge.json');mkdirSync(dirname(file),{recursive:true});return {root,config,file};
}
const pilot=()=>({experiments:'pilot',pilot:{id:'pilot',agent:'stinger',expiresAt:NOW+300000,maxEncounters:4,maxFood:2,maxSupplyDecrease:30,maxLevelStep:10}});
const memory=()=>{const m=emptyAdaptive();m.samples=[record(),record()];return m;};
const catalogue=():any=>({namespace:'profile',evidence:[],monsters:[{id:1,name:'Test opponent',symbol:'test',combatLevel:5,minSkill:1,hp:10,respawnTicks:20,source:'fixture'}],
 sites:[{id:'site',name:'Observed site',monster:{id:1,combatLevel:5},points:[{x:3200,z:3200,level:0}],guideIds:[],source:'fixture'}]});
const attack=(id='site'):any=>({id:'training-attack-'+id,type:'interactNpc',fields:{npcIndex:9,optionIndex:2,trainingSite:id},waitTicks:4});
const applyEquip=(s:any,a:any)=>{const out=structuredClone(s),i=out.inventory.find((v:any)=>v.slot===a.fields.slot),old=out.equipment.find((v:any)=>v.slot===3);
 const next={...i,slot:3};out.inventory[out.inventory.indexOf(i)]={...old,slot:i.slot,optionsWithIndex:[{text:'Wield',opIndex:2}]};out.equipment[out.equipment.indexOf(old)]=next;out.tick++;return out;};

test('absent or malformed settings fail closed without live authority',t=>{
 const f=fixture(t);assert.equal(readAdaptiveSettings('/nonexistent').recording,false);writeFileSync(f.config,'{bad');assert.equal(readAdaptiveSettings(f.root).experiments,'shadow');assert.equal(readAdaptiveSettings(f.root).recording,false);
});
test('passive mode records through the real TrainingDiscovery hook and survives reload',t=>{
 const f=fixture(t),tr=new TrainingDiscovery(f.file,'stinger',catalogue(),false,false,()=>NOW,opts(f.root));const b=state();tr.beforeAction(b,attack());
 const a=state({tick:5,combatEvents:[event('damage_dealt',10),event()]});tr.afterAction(b,a,attack());
 const d=JSON.parse(readFileSync(f.file,'utf8'));assert.equal(d.worlds.profile.adaptive.samples.length,1);assert.equal(d.worlds.profile.adaptive.samples[0].outcome,'kill');
 const re=new TrainingDiscovery(f.file,'stinger',catalogue(),false,false,()=>NOW+1,opts(f.root));assert.equal(re.memory.adaptive?.samples.length,1);
});
test('normal source-observed NPC attacks, not only training IDs, collect evidence',t=>{
 const f=fixture(t),tr=new TrainingDiscovery(f.file,'stinger',catalogue(),false,false,()=>NOW,opts(f.root));const b=state();tr.beforeAction(b,{...attack(),id:'ordinary-attack'});
 tr.afterAction(b,state({tick:5,combatEvents:[event()]}),{...attack(),id:'ordinary-attack'});assert.equal(tr.memory.adaptive?.samples.length,1);
});
test('read-only state observation finishes a later kill while no new action is issued',t=>{
 const f=fixture(t),tr=new TrainingDiscovery(f.file,'stinger',catalogue(),false,false,()=>NOW,opts(f.root));tr.beforeAction(state(),attack());
 tr.observe(state({tick:5,combatEvents:[event()]}));assert.equal(tr.memory.adaptive?.samples[0].outcome,'kill');
});
test('unobserved targets or non-attack options cannot manufacture a combat sample',t=>{
 const f=fixture(t),tr=new TrainingDiscovery(f.file,'stinger',catalogue(),false,false,()=>NOW,opts(f.root));tr.beforeAction(state(),{...attack(),fields:{npcIndex:9,optionIndex:1}});
 assert.equal(tr.memory.adaptive?.pending,undefined);
});
test('a restart preserves incomplete evidence but never resumes its experimental authority',t=>{
 const f=fixture(t),m=memory();let rt=new AdaptiveRuntime(m,'stinger','profile',opts(f.root),()=>NOW);beginEncounter(m,state(),target(),'site','stinger','profile',rt.session,NOW);
 rt=new AdaptiveRuntime(m,'stinger','profile',opts(f.root),()=>NOW+1);assert.equal(m.pending,undefined);assert.equal(m.samples.at(-1)?.outcome,'interrupted');
});
test('midfight skill gains do not pollute the legacy start-configuration aggregate',t=>{
 const f=fixture(t),tr=new TrainingDiscovery(f.file,'stinger',catalogue(),false,false,()=>NOW,opts(f.root));tr.beforeAction(state(),attack());const a=state({tick:5,combatEvents:[event()]});a.skills[0].baseLevel++;
 tr.afterAction(state(),a,attack());assert.equal(tr.memory.adaptive?.samples[0].changes.length,1);assert.equal(Object.keys(tr.memory.sites.site.stats).length,0);
});
test('legacy coarse aggregates remain on disk without pretending to be exact new evidence',t=>{
 const f=fixture(t);writeFileSync(f.file,JSON.stringify({version:1,character:'stinger',worlds:{profile:{sites:{},observations:{},exploration:{window:0,trips:0},legacyExample:'melee:weapon:def40:skill40'}}}));
 const tr=new TrainingDiscovery(f.file,'stinger',catalogue(),false,false,()=>NOW,opts(f.root));tr.save();assert.equal(JSON.parse(readFileSync(f.file,'utf8')).worlds.profile.legacyExample,'melee:weapon:def40:skill40');assert.equal(tr.memory.adaptive?.samples.length,0);
});
test('shadow proposes a useful experiment but emits no equip action',t=>{
 const f=fixture(t),m=memory(),r=new AdaptiveRuntime(m,'stinger','profile',opts(f.root),()=>NOW);r.propose(state(),target(),'site','strength','train-strength');
 assert.equal(m.lastProposal.kind,'equipment-experiment');assert.equal(m.experiment,undefined);assert.equal(r.gearAction(state(),'strength').action,undefined);
});
test('pilot can select only a carried, requirement-verified alternative on a sampled benchmark',t=>{
 const f=fixture(t,pilot()),m=memory(),r=new AdaptiveRuntime(m,'stinger','profile',opts(f.root),()=>NOW);r.propose(state(),target(),'site','strength','train-strength');
 assert.equal(m.experiment?.status,'active');assert.equal(m.experiment?.parent,'train-strength');assert.ok(m.experiment?.sequence.some((v,i,a)=>i>0&&v!==a[i-1]));
});
test('insufficient personal observations produce readiness proposal, not a gear test',t=>{
 const f=fixture(t,pilot()),m=emptyAdaptive(),r=new AdaptiveRuntime(m,'stinger','profile',opts(f.root),()=>NOW);r.propose(state(),target(),'site','strength','parent');assert.equal(m.experiment,undefined);assert.equal(m.lastProposal.kind,'readiness-benchmark');
});
test('unaffordable starting health cost defers the experiment',t=>{
 const f=fixture(t,pilot()),m=memory();m.samples.forEach(e=>e.metrics.hpDecreaseLowerBound=20);const r=new AdaptiveRuntime(m,'stinger','profile',opts(f.root),()=>NOW);
 r.propose(state(),target(),'site','strength','parent');assert.equal(m.experiment,undefined);
});
test('unowned alternatives are never bought, borrowed or synthetically equipped',t=>{
 const f=fixture(t,pilot()),m=memory(),r=new AdaptiveRuntime(m,'stinger','profile',opts(f.root),()=>NOW);const s=state();s.inventory=[];
 r.propose(s,target(),'site','strength','parent');assert.equal(m.experiment,undefined);assert.match(m.lastProposal.reason,/No informative/);
});
test('unknown requirements or missing styles are not treated as permission',t=>{
 const f=fixture(t,pilot()),m=memory(),r=new AdaptiveRuntime(m,'stinger','profile',{root:f.root,gearOptions:()=>[{id:102,slot:3,name:'unknown',allowed:false,reason:'unknown'}]},()=>NOW);
 r.propose(state(),target(),'site','strength','parent');assert.equal(m.experiment,undefined);
});
test('mid-series skill change aborts and records the reason without erasing old observations',t=>{
 const f=fixture(t,pilot()),m=memory(),r=new AdaptiveRuntime(m,'stinger','profile',opts(f.root),()=>NOW);r.propose(state(),target(),'site','strength','parent');
 const s=state();s.skills[0].baseLevel++;assert.equal(r.check(s,'strength'),undefined);assert.equal(m.experiment?.status,'aborted');assert.match(m.experiment!.reason,/levels/);assert.equal(m.samples.length,2);
});
test('revoking the pilot invalidates a previously proposed equip command',t=>{
 const f=fixture(t,pilot()),m=memory(),r=new AdaptiveRuntime(m,'stinger','profile',opts(f.root),()=>NOW);r.propose(state(),target(),'site','strength','parent');m.experiment!.sequence=['B','A','A','B'];
 const a=r.gearAction(state(),'strength').action;assert.ok(a);writeFileSync(f.config,JSON.stringify(defaultAdaptiveSettings()));assert.equal(r.validateGear(state(),a,'strength'),false);
});
test('fresh inventory rebinding and context validation reject stale equip packets',t=>{
 const f=fixture(t,pilot()),m=memory(),r=new AdaptiveRuntime(m,'stinger','profile',opts(f.root),()=>NOW);r.propose(state(),target(),'site','strength','parent');m.experiment!.sequence=['B','A','A','B'];
 const a=r.gearAction(state(),'strength').action,s=state();s.inventory[1].slot=9;assert.equal(r.validateGear(s,a,'strength'),false);
 s.inventory[1].slot=1;s.skills[1].currentLevel++;assert.equal(r.validateGear(s,a,'strength'),false);
});
test('health danger and recent damage preempt equipment experimentation',t=>{
 const f=fixture(t,pilot()),m=memory(),r=new AdaptiveRuntime(m,'stinger','profile',opts(f.root),()=>NOW);r.propose(state(),target(),'site','strength','parent');m.experiment!.sequence=['B','A','A','B'];
 const s=state();s.player.hp=5;assert.equal(r.gearAction(s,'strength').action,undefined);s.player.hp=40;s.player.combat.lastDamageTick=0;assert.equal(r.gearAction(s,'strength').action,undefined);
});
test('encounter budget is charged before dispatch and not replenished by restarting',t=>{
 const f=fixture(t,pilot()),m=memory(),r=new AdaptiveRuntime(m,'stinger','profile',opts(f.root),()=>NOW);r.propose(state(),target(),'site','strength','parent');m.experiment!.sequence=['A','B','B','A'];
 assert.ok(r.attackTag(state(),target(),'site','strength'));assert.equal(m.pilotUsage?.attempts,1);new AdaptiveRuntime(m,'stinger','profile',opts(f.root),()=>NOW+1);assert.equal(m.pilotUsage?.attempts,1);
});
test('other agents cannot use a pilot issued for Stinger',t=>{
 const f=fixture(t,pilot()),m=memory();m.samples.forEach(e=>e.agent='featherer');const r=new AdaptiveRuntime(m,'featherer','profile',opts(f.root),()=>NOW);r.propose(state(),target(),'site','strength','parent');assert.equal(m.experiment,undefined);
});
test('pending combat evidence prevents interleaved equipment changes',t=>{
 const f=fixture(t,pilot()),m=memory(),r=new AdaptiveRuntime(m,'stinger','profile',opts(f.root),()=>NOW);r.propose(state(),target(),'site','strength','parent');m.experiment!.sequence=['B','A','A','B'];
 beginEncounter(m,state(),target(),'site','stinger','profile',r.session,NOW);assert.equal(r.gearAction(state(),'strength').action,undefined);
});
test('a complete counterbalanced sequence uses real observations and stops at its bound',t=>{
 const f=fixture(t,pilot()),m=memory(),r=new AdaptiveRuntime(m,'stinger','profile',opts(f.root),()=>NOW);let s=state();r.propose(s,target(),'site','strength','parent');m.experiment!.sequence=['A','B','B','A'];
 for(let i=0;i<4;i++){
   const gear=r.gearAction(s,'strength').action;if(gear){assert.equal(r.validateGear(s,gear,'strength'),true);s=applyEquip(s,gear);}
   const tag=r.attackTag(s,target(),'site','strength');assert.ok(tag);beginEncounter(m,s,target(),'site','stinger','profile',r.session,NOW,tag);
   const a=structuredClone(s);a.tick+=4;a.combatEvents=[event('damage_dealt',10,{tick:a.tick}),event('kill',undefined,{tick:a.tick})];a.skills[1].experience+=20;
   observeEncounter(m,s,a,{type:'wait'},NOW+100);s=a;
 }
 assert.equal(m.experiment?.status,'complete');assert.equal(m.experiment?.completedIds.length,4);assert.equal(m.pilotUsage?.attempts,4);
 assert.equal(m.samples.filter(e=>e.experimentId).length,4);r.propose(s,target(),'site','strength','parent');assert.equal(m.experiment?.completedIds.length,4);
});
test('an interrupted trial does not move to the next arm or count as an easy kill',t=>{
 const f=fixture(t,pilot()),m=memory(),r=new AdaptiveRuntime(m,'stinger','profile',opts(f.root),()=>NOW);r.propose(state(),target(),'site','strength','parent');m.experiment!.sequence=['A','B'];
 const tag=r.attackTag(state(),target(),'site','strength');beginEncounter(m,state(),target(),'site','stinger','profile',r.session,NOW,tag);finishEncounter(m,'retreat',NOW+1);
 assert.equal(m.experiment?.status,'aborted');assert.equal(m.experiment?.cursor,0);
});
test('evidence feedback alters real ranking only when independently enabled',t=>{
 const f=fixture(t),tr=new TrainingDiscovery(f.file,'stinger',catalogue(),false,false,()=>NOW,opts(f.root));tr.memory.adaptive!.samples=[record({},'retreat')];
 const s=state(),base=(tr as any).score(tr.memory.sites.site,s,0);writeFileSync(f.config,JSON.stringify({...defaultAdaptiveSettings(),decisions:'on'}));
 assert.ok((tr as any).score(tr.memory.sites.site,s,0)<base);
});
test('real TrainingDiscovery.next records the selected site and decision explanation',async t=>{
 const f=fixture(t),tr=new TrainingDiscovery(f.file,'stinger',catalogue(),false,false,()=>NOW,opts(f.root));const a=await tr.next(state(),async()=>({status:'ready',cost:0}),[],'strength');
 assert.equal(a[0].type,'interactNpc');assert.equal(tr.memory.adaptive?.lastDecision.siteId,'site');assert.equal(tr.memory.adaptive?.lastDecision.authority,'ranking-only');
});
test('saved own and shared reports retain context without transferring readiness',t=>{
 const f=fixture(t),tr=new TrainingDiscovery(f.file,'stinger',catalogue(),false,false,()=>NOW,opts(f.root));tr.memory.adaptive!.samples=[record()];tr.save();
 assert.equal(readAdaptiveReport(f.root,'stinger','stinger').available,true);assert.equal(existsSync(join(f.root,'data/shared/combat-evidence/stinger.json')),true);
 const receiver=new AdaptiveRuntime(emptyAdaptive(),'featherer','profile',opts(f.root),()=>NOW);assert.equal(receiver.sharedHints(1,'site').length,1);assert.equal(receiver.memory.samples.length,0);
});
test('public shared evidence with another rules profile is ignored',t=>{
 const f=fixture(t),r=new AdaptiveRuntime(memory(),'stinger','profile',opts(f.root),()=>NOW);r.publish();const other=new AdaptiveRuntime(emptyAdaptive(),'featherer','other',opts(f.root),()=>NOW);
 assert.equal(other.sharedHints(1,'site').length,0);
});
test('measured useful equipment can override a static higher-tier preference',t=>{
 const f=fixture(t,{decisions:'on'}),m=memory();m.lastDecision={siteId:'site'};
 const b=state();b.equipment[0].id=102;b.equipment[0].name='Other sword';const x=record(b),y=record(b);x.metrics.xp.strength=100;y.metrics.xp.strength=100;m.samples.push(x,y);
 const r=new AdaptiveRuntime(m,'stinger','profile',opts(f.root),()=>NOW);const a=r.gearAction(state(),'strength').action;
 assert.ok(a);assert.equal(a.fields.adaptiveItemId,102);assert.equal(r.validateGear(state(),a,'strength'),true);assert.equal(m.lastDecision.equipmentPreference.provisional,true);
});
test('unmatched levels cannot cause an equipment switch from historical superior stats',t=>{
 const f=fixture(t,{decisions:'on'}),m=memory();m.lastDecision={siteId:'site'};const b=state();b.equipment[0].id=102;b.skills[1].baseLevel=99;const x=record(b);x.metrics.xp.strength=1000;m.samples.push(x,structuredClone(x));
 const r=new AdaptiveRuntime(m,'stinger','profile',opts(f.root),()=>NOW);assert.equal(r.gearAction(state(),'strength').action,undefined);
});

test('progression feedback constrains an unfamiliar jump, but does not force a weakest-target restart',t=>{
 const f=fixture(t,{...defaultAdaptiveSettings(),decisions:'on'}),m=memory(),r=new AdaptiveRuntime(m,'stinger','profile',opts(f.root),()=>NOW);
 assert.equal(r.candidateReview(state(),99,16).eligible,false);assert.equal(r.candidateReview(state(),99,15).eligible,true);
 const s=state();s.skills[0].baseLevel++;assert.equal(r.candidateReview(s,1,5).eligible,true);
 assert.equal(r.candidateReview(s,99,50).enforced,false);
});
test('another character or a different same-level monster cannot grant a personal familiar-target exception',t=>{
 const f=fixture(t,{...defaultAdaptiveSettings(),decisions:'on'}),m=memory();const stranger=record();stranger.agent='featherer';stranger.target.id=99;stranger.target.level=40;m.samples.push(stranger);
 const r=new AdaptiveRuntime(m,'stinger','profile',opts(f.root),()=>NOW);assert.equal(r.candidateReview(state(),99,40).eligible,false);
});
test('changing the parent combat skill aborts rather than holding an inappropriate style',t=>{
 const f=fixture(t,pilot()),m=memory(),r=new AdaptiveRuntime(m,'stinger','profile',opts(f.root),()=>NOW);r.propose(state(),target(),'site','strength','parent');
 assert.equal(r.check(state(),'attack'),undefined);assert.equal(m.experiment?.status,'aborted');
});
test('reaching the last permitted attempt does not erase its still-pending evidence',t=>{
 const settings=pilot();settings.pilot!.maxEncounters=1;const f=fixture(t,settings),m=memory(),r=new AdaptiveRuntime(m,'stinger','profile',opts(f.root),()=>NOW);
 r.propose(state(),target(),'site','strength','parent');m.experiment!.sequence=['A'];const tag=r.attackTag(state(),target(),'site','strength');
 beginEncounter(m,state(),target(),'site','stinger','profile',r.session,NOW,tag);assert.ok(r.check(state(),'strength'));
 observeEncounter(m,state(),state({tick:5,combatEvents:[event()]}),{type:'wait'},NOW+1);assert.equal(m.experiment?.status,'complete');
 assert.equal(m.samples.at(-1)?.experimentId,tag?.id);
});
test('an exhausted positive supply budget prevents starting another equipment encounter',t=>{
 const f=fixture(t,pilot()),m=memory(),r=new AdaptiveRuntime(m,'stinger','profile',opts(f.root),()=>NOW);r.propose(state(),target(),'site','strength','parent');
 m.pilotUsage!.food=2;assert.equal(r.check(state(),'strength'),undefined);assert.equal(m.experiment?.status,'aborted');
});
