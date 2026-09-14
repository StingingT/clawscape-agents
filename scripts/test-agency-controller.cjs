/* Offline execution of the ORIGINAL shared episode function with fake I/O.
 * No CLI subprocess, game connection, network call or persistent user state is used. */
let ts;try{ts=require('typescript');}catch{ts=require('../agents/advanced/node_modules/typescript');}
const {readFileSync,writeFileSync,mkdtempSync,rmSync}=require('node:fs');
const {join}=require('node:path');
const {tmpdir}=require('node:os');
const vm=require('node:vm');
const assert=require('node:assert/strict');
const source=readFileSync('src/agent.ts','utf8');
const parsed=ts.createSourceFile('src/agent.ts',source,ts.ScriptTarget.Latest,true);
const wanted=['runEpisode','actionsForTask','executeAgencyAction','verification'];
const extracted=parsed.statements.filter(s=>ts.isFunctionDeclaration(s)&&wanted.includes(s.name?.text)).map(s=>s.getText(parsed)).join('\n');
assert.equal(parsed.statements.filter(s=>ts.isFunctionDeclaration(s)&&wanted.includes(s.name?.text)).length,wanted.length);
const js=ts.transpileModule(extracted,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
async function runScenario({blocked=false,unknown=false,deny=false,movement=false,mapWait=false,legacyNavigation=false,combatGoal=false,badStyle=false,meleeGoal=false}={}){
  const {LiveAgency,isSelection}=await import('../src/agency/live-adapter.ts');
  const {verifyActionOutcome}=await import('../src/action-outcome.ts');
  const {recoverLegacyJournals}=await import('../src/agency/journal-recovery.ts');
  const dir=mkdtempSync(join(tmpdir(),'agency-controller-'));
  try{
    let now=1000,ids=0,mutationCalls=0,planned=false,legs=0,assessments=0,mapWaited=false;
    class TestDate extends Date { static now(){return now;} }
    const identity={agent:'test',world:'test',revision:'test'};
    const goalSkill=meleeGoal?'strength':'ranged';
    const agency=new LiveAgency(join(dir,'journal.json'),identity,{supported:combatGoal?['food','combat']:movement?['exploration']:['food'],developmentHint:combatGoal?(meleeGoal?'melee':'ranged-magic'):undefined,preferences:combatGoal?{combat:2}:{},routes:movement?[{id:'bank-route',x:50,z:1,level:0,evidence:'observed lead'}]:[],policy:{foodTarget:3,combatLossBoundGp:5},now:()=>now});
    const state={inGame:true,tick:1,player:{hp:30,maxHp:30,lifeId:1,level:0,worldX:1,worldZ:1,animId:-1,combat:{inCombat:false,targetType:'none',targetIndex:-1}},
      inventory:[],equipment:[],skills:[],bank:{isOpen:!movement,items:[{id:315,name:'Shrimps',count:10,slot:7}]}};
    if(combatGoal) {
      state.skills=['attack','strength','defence','ranged','magic','prayer'].map(name=>({name,experience:0,baseLevel:1}));
      state.equipment=[{id:841,name:'Shortbow',slot:3,count:1},{id:882,name:'Bronze arrow',slot:13,count:50}];
      state.combatStyle={weaponName:'Shortbow',currentStyle:0,styles:[{index:0,trainsSkills:['ranged']},{index:1,trainsSkills:['ranged','defence']}]};
      if(meleeGoal) {
        state.equipment=[{id:1323,name:'Iron scimitar',slot:3,count:1}];
        state.combatStyle={weaponName:'Iron scimitar',currentStyle:0,styles:[{index:0,trainsSkills:['strength']},{index:1,trainsSkills:['strength','defence']},{index:2,trainsSkills:['attack']}]};
      }
      state.nearbyNpcs=[{id:1,index:7,name:'Goblin',reachable:true,optionsWithIndex:[{opIndex:2,text:'Attack'}]}];
    }
    const legacyPath=join(dir,'action-intent.json');
    if(legacyNavigation)writeFileSync(legacyPath,JSON.stringify({commandId:'test-old-bank-for-fishing-tool-funds',
      actionId:'bank-for-fishing-tool-funds',type:'walkTo',fields:{x:50,z:1,level:0},status:'failed',beforeState:structuredClone(state)}));
    const originalPlan=agency.plan.bind(agency);agency.plan=(s)=>{planned=true;return blocked?{type:'blocked',reason:'test refusal',missingCapabilities:[]}:originalPlan(s);};
    if(unknown){const p=originalPlan(state);agency.begin(p,{id:'buy-arrows',type:'wait'},state,'old-command');agency.record('old-command',state,{status:'unknown',evidence:[]});
      // Use a still-unresolved shop intent for the actual episode reconciliation branch.
      agency.document.receipt.action={id:'buy-arrows',type:'shopBuy',fields:{slot:0,amount:1}};}
    if(deny)agency.begin=()=>{throw new Error('TEST_PRE_DISPATCH_REFUSAL');};
    const environment={
      agency,steps:8,character:'test',role:'brawler',build:'melee',forumEnabled:false,training:combatGoal?{
        observe(){},beforeAction(){},next(s,probe,leadIds,skill){
          assert.ok(leadIds.includes('lumbridge-chickens'),'guide leads were not forwarded to training');
          assert.equal(skill,goalSkill,'task skill was not forwarded to training');
          assert.equal(agency.director.memory.active.id,'train-'+goalSkill,'parent lost during food preparation');
          return [{id:'trial-target',type:'interactNpc',fields:{npcIndex:7,optionIndex:2},waitTicks:1}];
        },
      }:undefined,gearCandidates:()=>[],
      console:{log(){},error(){}},Date:TestDate,JSON,Number,Math,Set,Array,String,
      loadActionIntent:()=>undefined,actionIntentPath:legacyPath,finishActionIntent:()=>{},
      dataDir:dir,existsSync:require('node:fs').existsSync,resolve:require('node:path').resolve,
      recoverLegacyJournals:(dir,id,options)=>recoverLegacyJournals(dir,id,{...options,now}),process:{env:{CLAWSCAPE_SERVER:'test'}},
      stateFrom:v=>v.state,isSelection,verifyActionOutcome,available:v=>v,choose:(_,v)=>v[0],stateKey:()=>'',
      position:s=>({x:s.player.worldX,z:s.player.worldZ,level:s.player.level}),
      navigator:{
        assess:async()=>{assessments++;return {status:'ready'};},
        step:async destination=>{
          assert.ok(agency.pending(),'movement needs durable receipt');
          assert.equal(agency.director.memory.reviews.length,0,'partial movement cannot finish route goal');
          if(mapWait&&!mapWaited){mapWaited=true;return {state:structuredClone(state),navigation:{status:'loading-map',movementDispatched:false}};}
          const point=[{x:0,z:8},{x:25,z:8},{x:50,z:1}][legs++];
          assert.deepEqual({...destination},{x:50,z:1,level:0},'the committed destination changed between legs');
          state.player.worldX=point.x;state.player.worldZ=point.z;state.tick++;now+=100;mutationCalls++;
          return {state:structuredClone(state),navigation:{status:legs===3?'arrived':'progress',movementDispatched:true}};
        },
      },
      urgentAgencyAction:()=>undefined,validateMetal:()=>true,validateBow:()=>true,validateFishing:()=>true,
      equipmentGoals:{validate:()=>true},observeAgencyResult:()=>{},appendFileSync:()=>{},experiencePath:'unused',
      randomUUID:()=>`command-${++ids}`,dialogCandidates:()=>[],bankingCandidates:()=>{
        assert.ok(planned,'Legacy executor was called BEFORE the Director');
        if(combatGoal&&state.inventory.length>=3)return [{id:'close-bank',type:'closeModal',waitTicks:1}];
        return [{id:'withdraw-food',type:'bankWithdraw',fields:{slot:7,amount:1},waitTicks:1}];
      },
      cliCall:async args=>{
        now+=100;state.tick++;
        if(args[0]==='act'){
          mutationCalls++;
          if(combatGoal) {
            assert.equal(agency.director.memory.active.id,'train-'+goalSkill);
            if(args[1]==='closeModal'){state.bank.isOpen=false;if(badStyle)state.combatStyle.currentStyle=1;return {state:structuredClone(state)};}
            if(args[1]==='interactNpc'){
              assert.equal(state.inventory.length,3,'combat started before support reserve');
              assert.equal(agency.summary().development.id,meleeGoal?'rune-melee-pure':'ranged-magic-pure');
              assert.ok(agency.director.memory.active.supportGoals.some(s=>s.target.fact==='food'&&s.status==='satisfied'));
              state.skills.find(s=>s.name===goalSkill).experience+=100;
              state.player.combat={inCombat:true,targetType:'npc',targetIndex:7};
              return {state:structuredClone(state)};
            }
          }
          assert.equal(args[1],'bankWithdraw');
          const receipt=agency.pending();assert.ok(receipt,'Action dispatched without durable intent');
          assert.match(receipt.commandId,/^command-/);
          state.bank.items[0].count--;
          state.inventory.push({id:315,name:'Shrimps',count:1,slot:state.inventory.length,optionsWithIndex:[{opIndex:1,text:'Eat'}]});
        }
        return {state:structuredClone(state)};
      },
    };
    const context=vm.createContext(environment);vm.runInContext(js,context);
    if(legacyNavigation){
      await context.runEpisode();assert.equal(mutationCalls,0,'must not skip the idle settling window');
      now+=15_000;await context.runEpisode();assert.equal(mutationCalls,0);
      now+=15_000;
    }
    await context.runEpisode();
    if(legacyNavigation){
      const recovery=JSON.parse(readFileSync(join(dir,'legacy-recovery.json'),'utf8'));
      assert.equal(recovery.entries[0].outcome,'interrupted');
      assert.equal(JSON.parse(readFileSync(legacyPath,'utf8')).status,'failed','original record is preserved');
    }
    if(blocked||unknown||deny)assert.equal(mutationCalls,0,'A planner refusal/unknown intent fell through to real execution');
    else{assert.equal(mutationCalls,combatGoal?(badStyle?4:5):3);if(movement){assert.equal(legs,3);assert.equal(assessments,1);assert.equal(agency.pending(),undefined);}assert.equal(agency.director.memory.reviews.length,badStyle?0:1);if(!badStyle)assert.equal(agency.director.memory.reviews[0].result,'success');}
    return {mutationCalls,reviews:agency.director.memory.reviews.length};
  }finally{rmSync(dir,{recursive:true,force:true});}
}
(async()=>{
  const results=[];
  for(const scenario of [{},{blocked:true},{unknown:true},{deny:true},{movement:true},{movement:true,mapWait:true},{movement:true,legacyNavigation:true},{combatGoal:true},{combatGoal:true,badStyle:true},{combatGoal:true,meleeGoal:true},{combatGoal:true,meleeGoal:true,badStyle:true}])results.push({scenario,...await runScenario(scenario)});
  console.log(JSON.stringify({controllerChecks:results.length,passed:results.length,results},null,2));
})().catch(e=>{console.error(e);process.exitCode=1;});
