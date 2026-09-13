import { expect, test } from 'bun:test';
import { bowNext, validateBow } from './bowmaking';
import { selectWork } from './objectives';

const item=(id:number,name:string,count=1,slot=0,options:any[]=[])=>({id,name,count,slot,optionsWithIndex:options});
const base=()=>({tick:10,player:{worldX:3094,worldZ:3491,level:0,animId:-1,lifeId:1,hp:20,maxHp:20},
  skills:[{name:'Woodcutting',baseLevel:99},{name:'Fletching',baseLevel:89},{name:'Crafting',baseLevel:1}],
  inventory:[item(995,'Coins',50,0),item(946,'Knife',1,1),item(841,'Shortbow',1,2),item(315,'Shrimps',3,3,[{text:'Eat',opIndex:1}])],equipment:[],
  bank:{isOpen:false,items:[]},shop:{isOpen:false,shopItems:[]},dialog:{isOpen:false},interface:{isOpen:false,options:[]},modalOpen:false,nearbyLocs:[],nearbyNpcs:[]});

test('banked unstrung bows create a bounded finishing goal after 99 woodcutting',()=>{
  const s=base(),m:any={bankItems:[item(66,'Yew longbow',8,0)]};
  const intent=selectWork(s,m,100)!;
  expect(intent.mode).toBe('finish');
  expect(intent.inputId).toBe(66);
  expect(intent.outputId).toBe(855);
});

test('bowmaking preserves unstrung inputs and starts the Crafting prerequisite',()=>{
  const s=base();s.bank={isOpen:true,items:[item(66,'Yew longbow',8,0)]};
  const m:any={bankItems:s.bank.items,objectives:{prices:{},samples:{},completed:0,lastProbe:0,needs:[],blocked:{}}};
  m.objectives.intent={id:'finish-bow:66',track:'woodworking',mode:'finish',inputId:66,inputName:'Yew longbow',outputId:855,reason:'test'};
  const action=bowNext(s,m,()=>false,100)!;
  expect(action[0]!.type).toBe('bankDeposit');
  expect(action[0]!.fields!.amount).toBe(1);
  expect(m.bowmaking.input).toBe(66);
  expect(m.bowmaking.target).toBe(8);
  s.inventory=s.inventory.filter((i:any)=>i.id!==946&&i.id!==841);
  expect(bowNext(s,m,()=>false,101)[0]!.type).toBe('closeModal');
});

test('missing shears uses the observed shop trade menu',()=>{
  const s=base();s.player.worldX=3218;s.player.worldZ=3415;
  s.nearbyNpcs=[{id:99,name:'Shop keeper',index:4,reachable:true,distance:1,optionsWithIndex:[{text:'Trade',opIndex:2}]}];
  const m:any={bankItems:[],objectives:{prices:{},samples:{},completed:0,lastProbe:0,needs:[],blocked:{},intent:{id:'finish-bow:66',track:'woodworking',mode:'finish',inputId:66,inputName:'Yew longbow',outputId:855,reason:'test'}}};
  m.bowmaking={active:true,phase:'shear',input:66,output:855,target:1,made:0,started:1,lastProgress:100,life:1};
  expect(bowNext(s,m,()=>false,100)[0]).toMatchObject({type:'interactNpc',fields:{npcIndex:4,optionIndex:2}});
});

test('spinning selects the current material Make 10 component',()=>{
  const s=base();s.player.worldX=3082;s.player.worldZ=3430;s.inventory.push(item(1737,'Wool',8,3));
  s.interface={isOpen:true,options:[{index:1,text:'Wool',componentId:8871},{index:2,text:'Make 10',componentId:8869}]};s.modalOpen=true;
  const m:any={bankItems:[],objectives:{prices:{},samples:{},completed:0,lastProbe:0,needs:[],blocked:{},intent:{id:'finish-bow:66',track:'woodworking',mode:'finish',inputId:66,inputName:'Yew longbow',outputId:855,reason:'test'}}};
  m.bowmaking={active:true,phase:'wool',input:66,output:855,target:1,made:0,started:1,lastProgress:100,life:1};
  const a=bowNext(s,m,()=>false,100)[0]!;
  expect(a).toMatchObject({type:'clickComponent',fields:{componentId:8869}});
  expect(validateBow(s,a,{...s,interface:s.interface})).toBe(true);
});

test('an actionable bank modal does not become an endless bowmaking wait',()=>{
  const s=base();s.bank={isOpen:true,items:[item(58,'Willow longbow',4,0)]};s.modalOpen=true;
  const m:any={bankItems:s.bank.items,objectives:{prices:{},samples:{},completed:0,lastProbe:0,needs:[],blocked:{},intent:{id:'finish-bow:58',track:'woodworking',mode:'finish',inputId:58,inputName:'Willow longbow',outputId:847,reason:'test'}}};
  expect(bowNext(s,m,()=>false,100)[0]!.id).not.toBe('economy-bow-wait-interface');
});
