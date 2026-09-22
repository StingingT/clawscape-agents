import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, cpSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { SourceCatalogue, loadSourceCatalogue, recipeYield, expectedDropQuantity } from '../../src/catalog/source-catalogue.ts';
import { buildSourceMethods, requirementBranches, sourceSkills, recipeSupport, compatibleSourceArrows, atRuneTemple, type SourceSettings } from '../../src/agency/source-methods.ts';
import { SourceResources, SOURCE_CONFIG, readSourceSettings } from '../../src/agency/source-resources.ts';
import { sourceActions, hasOutputSpace } from '../../src/agency/source-actions.ts';
import { sourceOutcome } from '../../src/agency/source-outcome.ts';
import { createMemory, makePlan } from '../../src/agency/director.ts';
import { emptyKnowledge, defaultPolicy, type Catalogue } from '../../src/agency/world-model.ts';
import { LiveAgency, isSelection, type Selection } from '../../src/agency/live-adapter.ts';
import { bindItems, resolveItems } from '../../src/agency/item-intents.ts';

const SOURCE=process.env.CLAWSCAPE_SOURCE_CATALOGUE??resolve(import.meta.dirname,'../../data/catalog/clawscape-source-20260921');
let source:SourceCatalogue,root:string,counter=0;
const NOW=1_000_000;
const identity={agent:'stinger',world:'clawscape',revision:'fixture'};
const unknown:any={status:'unknown',evidence:[],reason:'generic verifier does not understand this action'};
const verified:any={status:'verified',evidence:['observed']};
const port:any={bank:()=>[],route:async(p:any)=>({status:'ready',destination:p})};
before(()=>{source=loadSourceCatalogue(SOURCE);root=mkdtempSync(join(tmpdir(),'source-integration-'));cpSync(SOURCE,join(root,'data/catalog/source'),{recursive:true});});
after(()=>{if(root)rmSync(root,{recursive:true,force:true});});
const row=(id:number,count=1,slot=0):any=>({id,name:source.item(id)?.name??String(id),count,slot});
const inv=(entries:Array<[number,number]>):any[]=>entries.flatMap(([id,n])=>source.item(id)?.properties?.stackable?[row(id,n)]:Array.from({length:n},()=>row(id)))
  .map((x,n)=>({...x,slot:n}));
const state=(patch:any={}):any=>({character:'stinger',world:'clawscape',worldEpoch:'one',inGame:true,tick:1,capacity:28,members:true,
 player:{lifeId:1,respawnCount:0,worldX:3200,worldZ:3200,level:0,hp:30,maxHp:30,animId:-1,combat:{inCombat:false,targetType:'none'}},
 inventory:[],equipment:[],skills:['attack','strength','defence','ranged','magic','fletching','mining','smithing','woodcutting','runecraft'].map(name=>({name,level:40,currentLevel:40,experience:1000})),
 bank:{isOpen:false,items:[]},shop:{isOpen:false},dialog:{isOpen:false},modalOpen:false,nearbyLocs:[],nearbyNpcs:[],groundItems:[],...patch});
const config=(patch:any={}):SourceSettings=>({version:1,directory:'data/catalog/source',mode:'pilot',pilotAgents:['stinger'],confirmedWorld:'clawscape',
 confirmedProfileId:source.data.profile.id,members:true,pilotId:'test-pilot-id',expiresAt:NOW+600_000,maxActions:60,maxSpendGp:250,
 requests:{stinger:[{item:882,quantity:15}]},...patch});
const saveConfig=(c:SourceSettings)=>writeFileSync(join(root,SOURCE_CONFIG),JSON.stringify(c));
const catalogue=(s:any):Catalogue=>({view:{...identity,at:NOW,context:'fixture',facts:{},capabilities:['acquisition'],
 budget:{spendableGp:10000,maxLossGp:0,maxDeaths:0,maxDurationMs:600_000}},methods:[],opportunities:[],tasks:new Map()});
const compile=(s:any,cfg=config(),knowledge=emptyKnowledge())=>{const c=catalogue(s),memory=createMemory(identity);
 const report=buildSourceMethods(source,c,s,knowledge,undefined,defaultPolicy,memory,cfg,NOW);return {c,report,memory};};
const recipeTask=(c:Catalogue,id:string)=>[...c.tasks.values()].find(t=>t.sourceResource?.recipeId===id)?.sourceResource!;
const entity=(id:string,optionText='Craft-rune')=>{const l:any=source.locations.get(id);return {id:l.sourceTypeId,name:l.name,x:l.coordinates.x,z:l.coordinates.z,level:l.coordinates.plane,reachable:true,optionsWithIndex:[{text:optionText,opIndex:1}]};};
const inTemple=(runeId:number,s=state())=>{const r=source.runes.get(runeId)!,e=entity(r.altarLocationIds[0]!);s.player={...s.player,worldX:e.x,worldZ:e.z,level:e.level};s.nearbyLocs=[e];return s;};
const fresh=(s:any,inventory:any[],other:any={})=>({...structuredClone(s),tick:s.tick+1,inventory,...other});
const bridge=(cfg=config())=>{saveConfig(cfg);const file=join(root,'data/test-'+counter+++'/agency-v2.json');return {b:new SourceResources(root,file,identity,()=>NOW),file};};
const agency=(cfg=config(),clock=()=>NOW)=>{saveConfig(cfg);const file=join(root,'data/test-'+counter+++'/agency-v2.json');return {a:new LiveAgency(file,identity,{supported:['acquisition'],sourceCatalogueRoot:root,now:clock}),file};};

test('real catalogue loads all rebuilt entities without renumbering',()=>{
 assert.equal(source.items.size,3894);assert.equal(source.recipes.size,419);assert.equal(source.routes.size,12932);assert.equal(source.runes.size,11);
 assert.equal(source.item('steel_arrow')?.id,886);assert.equal(source.item('waterrune')?.id,555);
});
test('source profile, invalid recipe references and duplicate IDs fail closed',()=>{
 assert.throws(()=>new SourceCatalogue({...source.data,items:[...source.data.items,source.data.items[0]!]}),/DUPLICATE/);
 assert.throws(()=>new SourceCatalogue({...source.data,recipes:[{...source.data.recipes[0]!,productItemId:999999}]}),/INVALID_SOURCE_RECIPE/);
});
test('checksum coverage must include required files',()=>{
 const p=join(root,'incomplete');mkdirSync(p);writeFileSync(join(p,'SHA256SUMS.json'),'{}');
 assert.throws(()=>loadSourceCatalogue(p),/SOURCE_CHECKSUM_MISSING/);
});
test('changed data fails checksum verification before parsing',()=>{
 const p=join(root,'bad-hash');mkdirSync(p);const files=['manifest.json','items.jsonl','acquisition_routes.jsonl','recipes.jsonl','locations.jsonl','runecrafting.jsonl'];
 const sums=Object.fromEntries(files.map(f=>[f,'0'.repeat(64)]));writeFileSync(join(p,'SHA256SUMS.json'),JSON.stringify(sums));writeFileSync(join(p,'manifest.json'),'{}');
 assert.throws(()=>loadSourceCatalogue(p),/SOURCE_CHECKSUM_MISMATCH/);
});
test('normal arrow dependencies explicitly include feathers, shafts, heads, logs, knife, bar and ores',()=>{
 const deps=source.dependencies([882]).items;for(const id of [314,52,53,39,1511,946,2349,436,438,2347])assert.ok(deps.includes(id),String(id));
 assert.equal(source.item('pure_essence'),undefined);
});
test('dependency traversal is bounded and reports truncation',()=>{assert.equal(source.dependencies([882],3).truncated,true);});
test('unverified world membership is not granted by recipe existence',()=>{
 const s=state();delete s.members;const r=source.recipes.get('recipe:headless-arrows')!;
 assert.equal(requirementBranches(r.requirements,s,config({members:undefined}),source).branches.length,0);
});
test('skill failures, reusable carried tools, OR choices and unmapped gates are explicit',()=>{
 const s=state();const req:any={all:[{skill:'smithing',level:99},{any:[{itemId:946,quantity:1,container:'inventory'},{itemId:2347,quantity:1,container:'inventory'}]}]};
 const result=requirementBranches(req,s,config(),source);assert.equal(result.branches.length,2);assert.ok(result.gaps.some(g=>g.includes('99')));
 assert.equal(requirementBranches({fact:'invented.access',equals:true} as any,s,config(),source).branches.length,0);
});
test('excessive OR requirements are withheld, not silently truncated',()=>{
 const r:any={any:Array.from({length:65},()=>({itemId:946,quantity:1}))};assert.equal(requirementBranches(r,state(),config(),source).branches.length,0);
});
test('bow-compatible ammunition excludes tiers above the equipped bow',()=>{
 const s=state({equipment:[row(841)]});assert.deepEqual(compatibleSourceArrows(source,s),[882,884]);
});
test('empty recipe leaves, stochastic iron smelting, and anvil UI remain explicit executor gaps',()=>{
 assert.match(recipeSupport(source.recipes.get('recipe:smelt:iron_bar')!)!,/stochastic/);
 assert.match(recipeSupport(source.recipes.get('recipe:smith:bronze_arrowheads')!)!,/executor not integrated/);
 const {report}=compile(state());assert.ok(report.blockers.some(x=>x.id==='recipe:smith:bronze_arrowheads'));
});
test('drop probability is represented as conditional expectation, never as a guaranteed combat method',()=>{
 const base:any={evidenceStatus:'source-verified',semantics:{probability:{numerator:32,denominator:128}},outputs:[{quantity:5}]};
 assert.equal(expectedDropQuantity(base),1.25);assert.equal(expectedDropQuantity({...base,semantics:{probability:{numerator:1,denominator:128}}}),5/128);
 assert.equal(expectedDropQuantity({...base,semantics:{}}),null);
 const {c,report}=compile(state());assert.ok(report.alternatives.some(x=>x.drops.length));assert.ok(!c.methods.some(m=>m.domain==='combat'));
});
test('planner composes feathered arrow intermediates instead of abstract supply-ammunition',()=>{
 const s=state({inventory:inv([[52,15],[314,15],[39,15]])}),{c,memory}=compile(s);
 const plan=makePlan(memory,c.view,c.opportunities[0]!,c.methods);assert.ok(plan);
 assert.equal(c.tasks.get(plan.steps[0]!.methodId)?.sourceResource?.recipeId,'recipe:headless-arrows');
 assert.equal(c.tasks.get(plan.steps.at(-1)!.methodId)?.sourceResource?.recipeId,'recipe:fletch:fletching_bronze_arrow');
 assert.equal(plan.steps.length,2);
});
test('automatic batches register the currently executable quantity, not impossible one-item packets',()=>{
 const {c}=compile(state({inventory:inv([[52,15],[314,15]])}));
 const tasks=[...c.tasks.values()].filter(x=>x.sourceResource?.recipeId==='recipe:headless-arrows');
 assert.equal(tasks.length,1);assert.equal(tasks[0]!.sourceResource!.batch,15);
});
test('shared knowledge does not pool another character inventory or bank',()=>{
 const s=state({inventory:inv([[52,15]])}),{c,memory}=compile(s);
 assert.equal(makePlan(memory,c.view,c.opportunities[0]!,c.methods),undefined);
 assert.equal(c.view.facts['carried:314'],0);
});
test('known banked ingredients become transfer prerequisites, not carried facts',()=>{
 const s=state({inventory:inv([[52,15],[39,15]])}),k=emptyKnowledge();k.bank=[row(314,15)];
 const {c,memory}=compile(s,config(),k),plan=makePlan(memory,c.view,c.opportunities[0]!,c.methods)!;
 assert.ok(plan);assert.equal(c.view.facts['carried:314'],0);assert.equal(c.tasks.get(plan.steps[0]!.methodId)!.sourceResource!.kind,'bank');
});
test('existing Director deducts shared inputs across different recipe branches',()=>{
 const {c,memory}=compile(state());c.view.facts.wood=1;
 const mk=(id:string,consumes:any,effects:any)=>({id,capability:'acquisition',domain:'crafting' as const,consumes,effects,prerequisites:[],costGp:0,lossBoundGp:0,durationMs:1,risk:'safe' as const});
 const goal:any={id:'two',domain:'crafting',target:{fact:'finished',minimum:1},source:'need',evidence:['fixture'],reason:'two independent components'};
 const methods=[mk('a',{wood:1},{a:1}),mk('b',{wood:1},{b:1}),mk('finish',{a:1,b:1},{finished:1})];
 assert.equal(makePlan(memory,c.view,goal,methods),undefined);
});
test('single-unit shop methods require a current, positive price',()=>{
 for(const buyPrice of [undefined,0,-1,NaN]){const {c}=compile(state({shop:{isOpen:true,shopItems:[{...row(882,10),buyPrice}]}}));assert.ok(![...c.tasks.values()].some(t=>t.sourceResource?.kind==='shop'));}
 const {c}=compile(state({inventory:inv([[995,100]]),shop:{isOpen:true,shopItems:[{...row(882,10),buyPrice:3}]}}));
 const m=c.methods.find(m=>c.tasks.get(m.id)?.sourceResource?.kind==='shop')!;assert.equal(m.costGp,3);assert.equal(m.consumes!['carried:995'],3);assert.equal(m.effects['carried:882'],1);
});
test('reordered live inventory slots are rebound before source dispatch',async()=>{
 const s=state({inventory:inv([[52,15],[314,15],[39,15]])}),{c}=compile(s),task=recipeTask(c,'recipe:headless-arrows');
 const a=(await sourceActions(source,task,s,config(),port,undefined,NOW)).actions[0]!;assert.ok(a);
 const next=structuredClone(s);next.inventory=next.inventory.map((x:any)=>({...x,slot:x.slot+5}));next.tick++;
 const bound=resolveItems(bindItems(a,s),next),b=(await sourceActions(source,task,next,config(),port,undefined,NOW)).actions[0]!;
 assert.deepEqual(bound.fields,b.fields);assert.equal(bound.fields!.sourceSlot,6);
});
test('changed automatic batch refuses a stale recipe task',async()=>{
 const s=state({inventory:inv([[52,15],[314,15]])}),task=recipeTask(compile(s).c,'recipe:headless-arrows');s.inventory=inv([[52,15],[314,2]]);
 assert.match((await sourceActions(source,task,s,config(),port,undefined,NOW)).reason!,/batch changed/);
});
test('a full inventory can craft when consumed stacks free the output slot',()=>{
 const s=state({inventory:inv([[52,15],[314,15],...[...Array(26)].map(()=>[1511,1] as [number,number])])});
 assert.equal(s.inventory.length,28);assert.equal(hasOutputSpace(source,s,[{itemId:52,quantity:15},{itemId:314,quantity:15}],53,15),true);
 assert.equal(hasOutputSpace(source,s,[],882,1),false);
});
test('bank withdrawal requires fresh bank stock and capacity',async()=>{
 const s=state({bank:{isOpen:true,items:[row(314,15,7)]}}),task:any={profileId:source.data.profile.id,kind:'bank',itemId:314,quantity:15};
 assert.equal((await sourceActions(source,task,s,config(),port,undefined,NOW)).actions[0]?.fields?.slot,7);
 s.bank.items=[];assert.match((await sourceActions(source,task,s,config(),port,undefined,NOW)).reason!,/Fresh bank/);
});
test('shop price change forces replanning instead of using a stale quote',async()=>{
 const s=state({inventory:inv([[995,100]]),shop:{isOpen:true,shopItems:[{...row(882,10),buyPrice:4}]}});
 const t:any={profileId:source.data.profile.id,kind:'shop',itemId:882,quantity:1,expectedPrice:3};
 assert.equal((await sourceActions(source,t,s,config(),port,undefined,NOW)).actions.length,0);
});
test('arrow shaft dialogue must be correlated, unique and fresh',async()=>{
 const s=state({inventory:inv([[946,1],[1511,1]]),dialog:{isOpen:true,options:[{index:2,text:'Arrow Shafts.'}]}});
 const t=recipeTask(compile(s).c,'recipe:fletch-shafts:fletching_normal');assert.ok(t);
 assert.equal((await sourceActions(source,t,s,config(),port,undefined,NOW)).actions.length,0);
 const d={recipeId:t.recipeId!,lifeId:1,at:NOW};assert.equal((await sourceActions(source,t,s,config(),port,d,NOW)).actions[0]?.type,'clickDialogOption');
 assert.equal((await sourceActions(source,t,s,config(),port,{...d,at:NOW-61000},NOW)).actions.length,0);
 s.dialog.options.push({index:3,text:'Arrow Shafts'});assert.equal((await sourceActions(source,t,s,config(),port,d,NOW)).actions.length,0);
});
test('component-only fletching panels are reported unsupported rather than clicked by guessed ID',async()=>{
 const s=state({inventory:inv([[946,1],[1511,1]]),interface:{isOpen:true,options:[{componentId:23,text:'Arrow Shafts'}]}}),t=recipeTask(compile(s).c,'recipe:fletch-shafts:fletching_normal');
 const result=await sourceActions(source,t,s,config(),port,{recipeId:t.recipeId!,lifeId:1,at:NOW},NOW);assert.equal(result.actions.length,0);assert.match(result.reason!,/component-only/);
});
test('water and air use one generic matching-rune executor with different data',async()=>{
 for(const id of [555,556]){const rune=source.runes.get(id)!,s=inTemple(id,state({inventory:inv([[1436,5]])}));
 const cfg=config({requests:{stinger:[{item:id,quantity:20}]}}),{c}=compile(s,cfg),task=recipeTask(c,source.recipesFor(id)[0]!.id);
 assert.equal(task.batch,5);const result=await sourceActions(source,task,s,cfg,port,undefined,NOW);assert.equal(result.actions[0]?.type,'interactLoc');
 assert.equal(result.actions[0]?.fields?.locId,(source.locations.get(rune.altarLocationIds[0]!) as any).sourceTypeId);}
});
test('rune crafting uses all current essence and the source integer multiplier',()=>{
 const s=inTemple(555,state({inventory:inv([[1436,5]])})),{c}=compile(s,config({requests:{stinger:[{item:555,quantity:15}]}})),t=recipeTask(c,source.recipesFor(555)[0]!.id);
 assert.equal(t.quantity,15);assert.equal(t.batch,5);assert.equal(recipeYield(source.recipesFor(555)[0]!,source,sourceSkills(s)),3);
});
test('wrong talisman cannot enter a different element ruins',async()=>{
 const r=source.runes.get(555)!,e=entity(r.entranceLocationIds[0]!,'Enter'),s=state({inventory:inv([[1438,1],[1436,1]]),nearbyLocs:[e]});s.player={...s.player,worldX:e.x,worldZ:e.z,level:e.level};
 const task:any={profileId:source.data.profile.id,kind:'rune-entry',itemId:555,quantity:0,locationId:r.entranceLocationIds[0]};
 assert.equal((await sourceActions(source,task,s,config(),port,undefined,NOW)).actions.length,0);
 s.inventory=inv([[r.talismanItemId,1],[1436,1]]);assert.equal((await sourceActions(source,task,s,config(),port,undefined,NOW)).actions[0]?.type,'useItemOnLoc');
});
test('matching talisman is reusable and unnecessary after already entering the correct temple',async()=>{
 const s=inTemple(555,state({inventory:inv([[1436,1]])})),cfg=config({requests:{stinger:[{item:555,quantity:3}]}}),t=recipeTask(compile(s,cfg).c,source.recipesFor(555)[0]!.id);
 assert.ok((await sourceActions(source,t,s,cfg,port,undefined,NOW)).actions.length);
});
test('death rune definition does not turn an unresolved entrance into an executable route',()=>{
 assert.equal(source.runes.get(560)!.hasPlacedGenericEntranceAndAltar,false);
 assert.equal(recipeYield(source.recipesFor(560)[0]!,source,{runecraft:99}),null);
});
test('furnace input selection cannot silently make a different bar',async()=>{
 const r=source.recipes.get('recipe:smelt:bronze_bar')!,locId=r.locationIds!.find(id=>(source.locations.get(id) as any)?.sourceTypeId===2781)!;
 const e=entity(locId,'Smelt'),s=state({inventory:inv([[436,1],[438,1]]),nearbyLocs:[e]});s.player={...s.player,worldX:e.x,worldZ:e.z,level:e.level};
 const cfg=config({requests:{stinger:[{item:2349,quantity:1}]}}),t=recipeTask(compile(s,cfg).c,r.id);assert.ok(t);
 assert.equal((await sourceActions(source,t,s,cfg,port,undefined,NOW)).actions[0]?.type,'useItemOnLoc');
 const wrong={...t,itemId:2353};assert.equal((await sourceActions(source,wrong,s,cfg,port,undefined,NOW)).actions.length,0);
});
test('source outcomes require the correct arrow outputs, not merely ingredient loss or XP',()=>{
 const before=state({inventory:inv([[52,15],[314,15]])}),t=recipeTask(compile(before).c,'recipe:headless-arrows'),a:any={type:'useItemOnItem'};
 assert.equal(sourceOutcome(source,t,before,fresh(before,[]),a,verified).status,'unknown');
 assert.equal(sourceOutcome(source,t,before,fresh(before,inv([[53,15]])),a,unknown).status,'verified');
 assert.equal(sourceOutcome(source,t,before,fresh(before,inv([[53,14]])),a,verified).status,'unknown');
});
test('generic rune outcome reconciliation confirms exact essence use and matching rune output',()=>{
 const before=inTemple(555,state({inventory:inv([[1436,5]])})),cfg=config({requests:{stinger:[{item:555,quantity:15}]}}),t=recipeTask(compile(before,cfg).c,source.recipesFor(555)[0]!.id);
 assert.equal(sourceOutcome(source,t,before,fresh(before,inv([[555,15]])),{id:'craft',type:'interactLoc'},unknown).status,'verified');
 assert.equal(sourceOutcome(source,t,before,fresh(before,inv([[556,15]])),{id:'craft',type:'interactLoc'},verified).status,'unknown');
});
test('runecrafting teleport reconciliation requires matching arrival and retained talisman',()=>{
 const r=source.runes.get(555)!,before=state({inventory:inv([[r.talismanItemId,1]])}),after=inTemple(555,fresh(before,before.inventory));
 const t:any={profileId:source.data.profile.id,kind:'rune-entry',itemId:555};
 assert.equal(sourceOutcome(source,t,before,after,{id:'enter',type:'useItemOnLoc'},unknown).status,'verified');
 assert.equal(sourceOutcome(source,t,before,inTemple(556,after),{id:'enter',type:'useItemOnLoc'},verified).status,'unknown');
});
test('source outcome cannot override explicit rejection or changed life',()=>{
 const b=state({inventory:inv([[52,15],[314,15]])}),t=recipeTask(compile(b).c,'recipe:headless-arrows'),a:any={type:'useItemOnItem'};
 assert.equal(sourceOutcome(source,t,b,fresh(b,inv([[53,15]])),a,{status:'rejected',evidence:[]}).status,'rejected');
 const n=fresh(b,inv([[53,15]]));n.player.lifeId=2;assert.equal(sourceOutcome(source,t,b,n,a,verified).status,'unknown');
});
test('shadow computes diagnostics without changing live methods, opportunities, or memory',()=>{
 const cfg=config({mode:'shadow'}),{b}=bridge(cfg),s=state({inventory:inv([[52,15],[314,15],[39,15]])}),c=catalogue(s),m=createMemory(identity);
 const before=digestTest({c:{...c,tasks:[...c.tasks]},m});b.augment(c,s,emptyKnowledge(),undefined,defaultPolicy,m);
 assert.equal(digestTest({c:{...c,tasks:[...c.tasks]},m}),before);const report=JSON.parse(readFileSync(b.reportFile,'utf8'));
 assert.equal(report.enabled,false);assert.ok(report.registeredMethods>0);assert.ok(report.plans.some((p:any)=>!p.blocked));
});
const digestTest=(x:unknown)=>JSON.stringify(x);
test('pilot requires explicit source/world confirmation, worker selection and expiry',()=>{
 for(const patch of [{confirmedProfileId:'other'},{confirmedWorld:'other'},{pilotAgents:[]},{expiresAt:NOW-1},{expiresAt:NOW+9999999}]){
  const {b}=bridge(config(patch)),s=state(),c=catalogue(s);b.augment(c,s,emptyKnowledge(),undefined,defaultPolicy,createMemory(identity));assert.equal(c.methods.length,0);assert.equal(b.brief().enabled,false);}
});
test('configuration rejects absolute/outside paths, Astra main-runner claim, and unbounded budgets',()=>{
 for(const patch of [{directory:'../elsewhere'},{directory:resolve(root,'data/catalog/source')},{pilotAgents:['astra']},{maxActions:999999},{maxSpendGp:-1}]){
  saveConfig(config(patch));assert.throws(()=>readSourceSettings(root),/INVALID_SOURCE/);}
});
test('unknown configuration failures are diagnostic and do not alter legacy catalogue',()=>{
 const {b}=bridge(config());writeFileSync(join(root,SOURCE_CONFIG),'not-json');const s=state(),c=catalogue(s);
 assert.doesNotThrow(()=>b.augment(c,s,emptyKnowledge(),undefined,defaultPolicy,createMemory(identity)));assert.equal(c.methods.length,0);assert.ok(b.brief().error);
});
test('main LiveAgency refuses source dispatch without a fresh one-use authorization',async()=>{
 const {a}=agency(),s=state({inventory:inv([[52,15],[314,15],[39,15]])}),p=a.plan(s);assert.ok(isSelection(p));assert.ok(p.task.sourceResource);
 const action=(await a.sourceActions(p.task,s,port))[0]!;assert.ok(action);
 assert.throws(()=>a.begin(p,action,s,'no-ticket'),/SOURCE_FRESH_AUTHORIZATION_REQUIRED/);assert.equal(a.pending(),undefined);
});
test('main LiveAgency executes a simulated two-step arrow chain and persists only observed progress',async()=>{
 let now=NOW;const {a,file}=agency(config(),()=>now);let s=state({inventory:inv([[52,15],[314,15],[39,15]])});
 for(const [number,output] of [[1,inv([[53,15],[39,15]])],[2,inv([[882,15]])]] as any){
  const p=a.plan(s);assert.ok(isSelection(p));const raw=(await a.sourceActions(p.task,s,port))[0]!;assert.ok(raw);
  const action=await a.sourcePreflight(p,bindItems(raw,s),s,port);a.begin(p,action,s,'source-'+number);
  now+=4000;const next=fresh(s,output);a.record('source-'+number,next,unknown,{spentGp:0,lostGp:0,deaths:0,elapsedMs:4000});
  assert.equal(a.pending(),undefined);s=next;
 }
 a.plan(s);const saved=JSON.parse(readFileSync(file,'utf8'));assert.ok(saved.memory.reviews.some((r:any)=>r.result==='success'));
 const ledger=JSON.parse(readFileSync(join(dirname(file),'source-catalogue-pilot.json'),'utf8'));assert.equal(ledger.actions,2);
});
test('state or packet changes invalidate a fresh authorization ticket',async()=>{
 const {a}=agency(),s=state({inventory:inv([[52,15],[314,15],[39,15]])}),p=a.plan(s);assert.ok(isSelection(p));
 const raw=(await a.sourceActions(p.task,s,port))[0]!,action=await a.sourcePreflight(p,raw,s,port);
 action.fields={...action.fields,targetSlot:2};assert.throws(()=>a.begin(p,action,s,'mutated'),/SOURCE_FRESH_AUTHORIZATION_REQUIRED/);assert.equal(a.pending(),undefined);
});
test('pilot action budget survives controller restart without resetting learned state',async()=>{
 let now=NOW;const cfg=config({maxActions:1}),{a,file}=agency(cfg,()=>now),s=state({inventory:inv([[52,15],[314,15],[39,15]])});
 const p=a.plan(s);assert.ok(isSelection(p));const raw=(await a.sourceActions(p.task,s,port))[0]!,action=await a.sourcePreflight(p,raw,s,port);a.begin(p,action,s,'one');
 now+=1000;const n=fresh(s,inv([[53,15],[39,15]]));a.record('one',n,unknown,{spentGp:0,lostGp:0,deaths:0,elapsedMs:1000});
 const restarted=new LiveAgency(file,identity,{supported:['acquisition'],sourceCatalogueRoot:root,now:()=>now});
 restarted.catalogue(n);assert.equal(restarted.summary().sourceResources?.enabled,false);
 assert.equal((await restarted.sourceActions(p.task,n,port)).length,0);
});
test('pending source outcome can reconcile after restart without old authorization tickets',async()=>{
 const {a,file}=agency(),s=state({inventory:inv([[52,15],[314,15],[39,15]])}),p=a.plan(s);assert.ok(isSelection(p));
 const raw=(await a.sourceActions(p.task,s,port))[0]!,action=await a.sourcePreflight(p,raw,s,port);a.begin(p,action,s,'restart');
 const b=new LiveAgency(file,identity,{supported:['acquisition'],sourceCatalogueRoot:root,now:()=>NOW+2000});
 b.record('restart',fresh(s,inv([[53,15],[39,15]])),unknown,{spentGp:0,lostGp:0,deaths:0,elapsedMs:2000});assert.equal(b.pending(),undefined);
});
test('source purchase budget is distinct from the normal Director gold reserve',async()=>{
 const {a}=agency(config({maxSpendGp:2})),s=state({inventory:inv([[995,1000]]),shop:{isOpen:true,shopItems:[{...row(882,100),buyPrice:3}]}}),p=a.plan(s);assert.ok(isSelection(p));
 const raw=(await a.sourceActions(p.task,s,port))[0]!;assert.equal(raw.type,'shopBuy');
 await assert.rejects(a.sourcePreflight(p,bindItems(raw,s),s,port),/SOURCE_GP_BUDGET_EXHAUSTED/);assert.equal(a.pending(),undefined);
});
test('source authorization is revoked immediately by switching to shadow',async()=>{
 const {a}=agency(),s=state({inventory:inv([[52,15],[314,15],[39,15]])}),p=a.plan(s);assert.ok(isSelection(p));
 const action=await a.sourcePreflight(p,(await a.sourceActions(p.task,s,port))[0]!,s,port);saveConfig(config({mode:'shadow'}));
 assert.throws(()=>a.begin(p,action,s,'disabled'),/SOURCE_GATE/);assert.equal(a.pending(),undefined);
});
test('observed purchase cost above the quote is charged once while the receipt stays uncertain',async()=>{
 const {a,file}=agency(config({maxSpendGp:3})),s=state({inventory:inv([[995,1000]]),shop:{isOpen:true,shopItems:[{...row(882,100),buyPrice:3}]}}),p=a.plan(s);assert.ok(isSelection(p));
 const raw=(await a.sourceActions(p.task,s,port))[0]!,action=await a.sourcePreflight(p,raw,s,port);a.begin(p,action,s,'changed-price');
 const next=fresh(s,inv([[995,996],[882,1]]));a.record('changed-price',next,verified,{spentGp:4,lostGp:0,deaths:0,elapsedMs:1000});
 const path=join(dirname(file),'source-catalogue-pilot.json');assert.equal(JSON.parse(readFileSync(path,'utf8')).quotedGp,4);
 a.record('changed-price',next,unknown,{spentGp:4,lostGp:0,deaths:0,elapsedMs:1000});assert.equal(JSON.parse(readFileSync(path,'utf8')).quotedGp,4);
 assert.ok(a.pending());
});
test('protected Fletching skill prevents the planner from scheduling a source arrow recipe',()=>{
 const s=state({inventory:inv([[52,15],[314,15],[39,15]])}),{c,memory}=compile(s);c.view.strategy={id:'protected',protectedSkills:['fletching']};
 assert.equal(makePlan(memory,c.view,c.opportunities[0]!,c.methods),undefined);
});
