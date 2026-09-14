/* Offline execution of the ORIGINAL shared episode function with fake I/O.
 * No CLI subprocess, game connection, network call or persistent user state is used. */
let ts;try{ts=require('typescript');}catch{ts=require('../agents/advanced/node_modules/typescript');}
const {readFileSync,mkdtempSync,rmSync}=require('node:fs');
const {join}=require('node:path');
const {tmpdir}=require('node:os');
const vm=require('node:vm');
const assert=require('node:assert/strict');
const source=readFileSync('src/agent.ts','utf8');
const parsed=ts.createSourceFile('src/agent.ts',source,ts.ScriptTarget.Latest,true);
const wanted=['runEpisode','actionsForTask','executeAgencyAction'];
const extracted=parsed.statements.filter(s=>ts.isFunctionDeclaration(s)&&wanted.includes(s.name?.text)).map(s=>s.getText(parsed)).join('\n');
assert.equal(parsed.statements.filter(s=>ts.isFunctionDeclaration(s)&&wanted.includes(s.name?.text)).length,wanted.length);
const js=ts.transpileModule(extracted,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
async function runScenario({blocked=false,unknown=false,deny=false}={}){
  const {LiveAgency,isSelection}=await import('../src/agency/live-adapter.ts');
  const {verifyActionOutcome}=await import('../src/action-outcome.ts');
  const dir=mkdtempSync(join(tmpdir(),'agency-controller-'));
  try{
    let now=1000,ids=0,mutationCalls=0,planned=false;
    const identity={agent:'test',world:'test',revision:'test'};
    const agency=new LiveAgency(join(dir,'journal.json'),identity,{supported:['food'],policy:{foodTarget:3},now:()=>now});
    const state={inGame:true,tick:1,player:{hp:30,maxHp:30,lifeId:1,level:0,worldX:1,worldZ:1,combat:{inCombat:false,targetType:'none',targetIndex:-1}},
      inventory:[],equipment:[],skills:[],bank:{isOpen:true,items:[{id:315,name:'Shrimps',count:10,slot:7}]}};
    const originalPlan=agency.plan.bind(agency);agency.plan=(s)=>{planned=true;return blocked?{type:'blocked',reason:'test refusal',missingCapabilities:[]}:originalPlan(s);};
    if(unknown){const p=originalPlan(state);agency.begin(p,{id:'buy-arrows',type:'wait'},state,'old-command');agency.record('old-command',state,{status:'unknown',evidence:[]});
      // Use a still-unresolved shop intent for the actual episode reconciliation branch.
      agency.document.receipt.action={id:'buy-arrows',type:'shopBuy',fields:{slot:0,amount:1}};agency.document.receipt.dispatchState='sent';}
    if(deny)agency.begin=()=>{throw new Error('TEST_PRE_DISPATCH_REFUSAL');};
    const environment={
      agency,steps:5,character:'test',role:'brawler',build:'melee',forumEnabled:false,training:undefined,
      console:{log(){},error(){}},Date:class extends Date{static now(){return now;}},JSON,Number,Math,Set,Array,String,
      loadActionIntent:()=>undefined,actionIntentPath:'unused',finishActionIntent:()=>{},
      stateFrom:v=>v.state,isSelection,verifyActionOutcome,available:v=>v,choose:(_,v)=>v[0],stateKey:()=>'',
      urgentAgencyAction:()=>undefined,validateMetal:()=>true,validateBow:()=>true,validateFishing:()=>true,
      equipmentGoals:{validate:()=>true},observeAgencyResult:()=>{},appendFileSync:()=>{},experiencePath:'unused',
      randomUUID:()=>`command-${++ids}`,dialogCandidates:()=>[],bankingCandidates:()=>{
        assert.ok(planned,'Legacy executor was called BEFORE the Director');
        return [{id:'withdraw-food',type:'bankWithdraw',fields:{slot:7,amount:1},waitTicks:1}];
      },
      cliCall:async args=>{
        now+=100;state.tick++;
        if(args[0]==='act'){
          mutationCalls++;assert.equal(args[1],'bankWithdraw');
          const receipt=agency.pending();assert.ok(receipt,'Action dispatched without durable intent');
          assert.match(receipt.commandId,/^command-/);
          state.bank.items[0].count--;
          state.inventory.push({id:315,name:'Shrimps',count:1,slot:state.inventory.length,optionsWithIndex:[{opIndex:1,text:'Eat'}]});
        }
        return {state:structuredClone(state)};
      },
    };
    const context=vm.createContext(environment);vm.runInContext(js,context);
    await context.runEpisode();
    if(blocked||unknown||deny)assert.equal(mutationCalls,0,'A planner refusal/unknown intent fell through to real execution');
    else{assert.equal(mutationCalls,3);assert.equal(agency.director.memory.reviews.length,1);assert.equal(agency.director.memory.reviews[0].result,'success');}
    return {mutationCalls,reviews:agency.director.memory.reviews.length};
  }finally{rmSync(dir,{recursive:true,force:true});}
}
async function runRouteScenario(loading=false){
  const {LiveAgency,isSelection}=await import('../src/agency/live-adapter.ts');
  const {Navigator,position}=await import('../src/navigation/controller.ts');
  const dir=mkdtempSync(join(tmpdir(),'agency-route-controller-'));
  let navigator;
  try{
    let now=1000,ids=0,sends=0,target,planned=false;
    let current={inGame:true,tick:1,player:{hp:30,maxHp:30,lifeId:1,level:0,worldX:100,worldZ:100,combat:{inCombat:false,targetType:'none',targetIndex:-1}},inventory:[],equipment:[],skills:[],nearbyNpcs:[],nearbyLocs:[]};
    const route={id:'detour',x:110,z:110,level:0,evidence:'own lead'};
    const agency=new LiveAgency(join(dir,'agency.json'),{agent:'test',world:'test',revision:'test'},{supported:['exploration'],routes:[route],now:()=>now});
    const plan=agency.plan.bind(agency);agency.plan=s=>{planned=true;return plan(s);};
    const wait=async()=>{now+=2000;current={...current,tick:current.tick+2,player:{...current.player,...(target?{worldX:target.x,worldZ:target.z}:{})}};return structuredClone(current);};
    navigator=new Navigator({state:async()=>structuredClone(current),wait,act:async(type,fields)=>{
      assert.ok(planned);assert.equal(type,'walkTo');assert.equal(agency.pending()?.execution?.action.fields?.x,fields.x,'waypoint must be durable BEFORE send');sends++;target=fields;return {success:true};
    }},join(dir,'nav.json'),async()=>({legs:[{target:{x:98,z:100,level:0},doors:[]},{target:{x:98,z:110,level:0},doors:[]},{target:{x:110,z:110,level:0},doors:[]}],hash:'fixture',unmappedTiles:0}));
    if(loading){const step=navigator.step.bind(navigator);let first=true;navigator.step=async(...args)=>{if(first){first=false;return {state:args[1],navigation:{status:'loading-map'}};}return step(...args);};}
    const context=vm.createContext({agency,navigator,position,isSelection,steps:8,character:'test',role:'brawler',build:'melee',forumEnabled:false,training:undefined,
      console:{log(){},error(){}},Date:class extends Date{static now(){return now;}},JSON,Number,Math,Set,Array,String,
      loadActionIntent:()=>undefined,actionIntentPath:'unused',finishActionIntent:()=>{},stateFrom:v=>v.state,available:v=>v,choose:(_,v)=>v[0],
      urgentAgencyAction:()=>undefined,validateMetal:()=>true,validateBow:()=>true,validateFishing:()=>true,equipmentGoals:{validate:()=>true},
      observeAgencyResult:()=>{},appendFileSync:()=>{},experiencePath:'unused',randomUUID:()=>`route-${++ids}`,
      cliCall:async(args)=>args[0]==='wait'?{state:await wait()}:{state:structuredClone(current)},
    });
    vm.runInContext(js,context);await context.runEpisode();
    assert.equal(sends,3,'the actual episode must execute all three detour legs');
    assert.equal(agency.pending(),undefined);assert.equal(agency.director.memory.reviews.length,1);
    assert.equal(agency.director.memory.reviews[0].result,'success');
    return {scenario:loading?'map-loading-then-detour':'multi-leg-detour',sends,reviews:1};
  }finally{navigator?.close();rmSync(dir,{recursive:true,force:true});}
}
(async()=>{
  const results=[];
  for(const scenario of [{},{blocked:true},{unknown:true},{deny:true}])results.push({scenario,...await runScenario(scenario)});
  results.push(await runRouteScenario(),await runRouteScenario(true));
  console.log(JSON.stringify({controllerChecks:6,passed:6,results},null,2));
})().catch(e=>{console.error(e);process.exitCode=1;});
