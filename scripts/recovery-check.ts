import {callSkill} from '../src/skill-cli';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
const root=resolve(import.meta.dir,'..');
const characters=['clawscout','stinger','coincrafter','astra'];
const call=(c:string,args:string[])=>callSkill(c,args,resolve(root,'data/online-home'));
const snapshot=async(c:string)=>(await call(c,['state'])).state;
const count=(s:any,id:number)=>(s.inventory??[]).filter((i:any)=>i.id===id).reduce((n:number,i:any)=>n+i.count,0);
const mode=process.argv[2]??'report';
if(mode==='trial') {
 const c=process.argv[3]!;const before=await snapshot(c);let type='',fields:any={};
 if(c==='stinger') { const row=before.shop?.shopItems?.find((i:any)=>/small fishing net/i.test(i.name)&&i.count>0&&i.buyPrice<=count(before,995));if(!before.shop?.isOpen||!row)throw Error('No affordable live net'); type='shopBuy';fields={slot:row.slot,amount:1}; }
 if(c==='coincrafter') {const rock=before.nearbyLocs.find((l:any)=>[2092,2093].includes(l.id)&&l.reachable&&l.optionsWithIndex.some((o:any)=>o.text==='Mine'));if(!rock)throw Error('No live iron rock');type='interactLoc';fields={locId:rock.id,x:rock.x,z:rock.z,optionIndex:rock.optionsWithIndex.find((o:any)=>o.text==='Mine').opIndex};}
 if(c==='astra') {const npc=before.nearbyNpcs.filter((n:any)=>/^goblin$/i.test(n.name)&&n.reachable&&n.combatLevel<=2&&n.optionsWithIndex.some((o:any)=>o.text==='Attack')).sort((a:any,b:any)=>a.distance-b.distance)[0];if(!npc||before.player.hp<9)throw Error('No safe goblin trial');type='interactNpc';fields={npcIndex:npc.index,optionIndex:npc.optionsWithIndex.find((o:any)=>o.text==='Attack').opIndex};}
 if(!type)throw Error('Unknown trial');
 const result=await call(c,['act',type,'--json',JSON.stringify(fields)]);
 let after=(await call(c,['wait','5'])).state;
 console.log(JSON.stringify({character:c,type,success:result.success,before:{tick:before.tick,hp:before.player.hp,skills:before.skills,inventory:before.inventory},after:{tick:after.tick,hp:after.player.hp,skills:after.skills,inventory:after.inventory}}));
} else {
 let md='# Agent inventory and bank overview\n\nCaptured '+new Date().toISOString()+'\n';
 for(const c of characters){const s=await snapshot(c);const profile=c==='clawscout'?'online':c;const file=resolve(root,'data',profile,'work-state.json');const w=existsSync(file)?JSON.parse(readFileSync(file,'utf8')):{};
 const bank=s.bank?.items?.length?s.bank.items:w.economy?.bankItems??w.bankItems??[];
 const rows=(items:any[])=>{const totals=new Map<string,number>();for(const i of items)totals.set(i.name,(totals.get(i.name)??0)+i.count);return [...totals].map(([n,q])=>'- '+n+' × '+q).join('\n')||'No items recorded.';};
 md+='\n## '+c+'\n\nHP '+s.player.hp+'/'+s.player.maxHp+', combat '+s.player.combatLevel+', position '+s.player.worldX+', '+s.player.worldZ+'.\n\n### Equipped\n\n'+rows(s.equipment??[])+'\n\n### Inventory (live)\n\n'+rows(s.inventory??[])+'\n\n### Bank ('+(s.bank?.isOpen?'live':'cached; not verified during this inspection')+')\n\n'+rows(bank)+'\n';
 console.log(JSON.stringify({character:c,hp:s.player.hp,shop:s.shop?.isOpen,inventorySlots:s.inventory.length,bankEntries:bank.length}));
 }
 writeFileSync(resolve(root,'data/agent-inventory-overview.md'),md);
}
