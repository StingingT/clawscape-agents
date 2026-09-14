import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

export type Requirement = { skill: string; level: number };
export type Ingredient = { id: number; name: string; count: number };
export type Shop = { id: string; name: string; npc: string; x: number; z: number; level: number; enabled: boolean; blocker?: string; source: string };
export type Method = { id: string; kind: 'buy' | 'craft' | 'drop'; source: string; shop?: Shop; priceHint?: number;
  skill?: string; level?: number; inputs?: Ingredient[]; recipe?: 'smith' | 'leather' | 'string'; prerequisites?: string[]; blocker?: string };
export type Gear = { id: number; name: string; symbol: string; family: 'melee' | 'bow' | 'axe' | 'pickaxe' | 'legs' | 'hands' | 'shield' | 'body';
  quality: number; requires: Requirement[]; methods: Method[]; source: string; tool: boolean };
export type GearCatalog = { namespace: string; items: Gear[]; shops: Shop[]; evidence: string[] };
export const block = (text: string, key: string) => text.split('[' + key + ']')[1]?.split(/\r?\n\[/)[0] ?? '';
const field = (text: string, key: string) => {
  const prefix=key+(key.includes('=')?',':'=');
  return text.split(/\r?\n/).find(l=>l.startsWith(prefix))?.slice(prefix.length)?.trim();
};

// A source-derived shortlist, not a claim to cover every build/item. Local
// content suggests possibilities; observed prices, stock and options authorize actions.
export function loadGearCatalog(upstream = process.env.CLAWSCAPE_UPSTREAM ?? resolve(import.meta.dir, '../../../tmp/clawscape/upstream')): GearCatalog {
  const evidence: string[] = [], hash = createHash('sha256');
  const read = (p: string) => { const t = readFileSync(resolve(upstream, p), 'utf8'); evidence.push(p); hash.update(p).update(t); return t; };
  const pack = new Map(read('server/content/pack/obj.pack').split(/\r?\n/).filter(l => /^\d+=/.test(l)).map(l => [l.slice(l.indexOf('=') + 1), Number(l.slice(0, l.indexOf('=')))]));
  const id = (symbol: string) => { const n = pack.get(symbol); if (n === undefined) throw new Error('Missing source item ' + symbol); return n; };
  const metal = ['bronze','iron','steel','black','mithril','adamant','rune'];
  const metalLevel = [1,1,5,10,20,30,40];
  const items: Gear[] = [];
  const add = (symbol: string, family: Gear['family'], file: string, contents: string, level: number, skill: string, quality: number) => {
    const data = block(contents, symbol), name = field(data, 'name');
    if (!data || !name) return;
    const g: Gear = { id:id(symbol), name, symbol, family, quality, requires:[{skill,level}], methods:[], source:file+'#'+symbol, tool:family==='axe'||family==='pickaxe' };
    items.push(g); return g;
  };
  for (const [type,file] of [['scimitar','scimitars'],['sword','swords'],['longsword','longswords']] as const) {
    const path='server/content/scripts/skill_combat/configs/melee/'+file+'.obj', contents=read(path);
    metal.forEach((m,i) => {
      const data=block(contents,m+'_'+type);
      // Equal-speed sword/scimitar prior; not a learned DPS claim. Later
      // encounter observations remain free to choose the better carried kit.
      const strength=Number(field(data,'param=strengthbonus') ?? 0), slash=Number(field(data,'param=slashattack') ?? 0), stab=Number(field(data,'param=stabattack') ?? 0);
      add(m+'_'+type,'melee',path,contents,metalLevel[i]!, 'attack', (strength+Math.max(slash,stab))/(type==='longsword'?5:4));
    });
  }
  const axePath='server/content/scripts/skill_woodcutting/configs/axes/axes.obj', axes=read(axePath);
  metal.forEach((m,i)=>add(m+'_axe','axe',axePath,axes,[1,1,6,6,21,31,41][i]!, 'woodcutting',i+1));
  const pickPath='server/content/scripts/skill_mining/configs/pickaxes.obj', picks=read(pickPath);
  ['bronze','iron','steel','mithril','adamant','rune'].forEach((m,i)=>add(m+'_pickaxe','pickaxe',pickPath,picks,[1,1,6,21,31,41][i]!, 'mining',i+1));
  const bowPath='server/content/scripts/skill_combat/configs/ranged/bows.obj', bows=read(bowPath);
  ['shortbow','oak_shortbow','willow_shortbow','maple_shortbow','yew_shortbow','magic_shortbow'].forEach((symbol,i)=>
    add(symbol,'bow',bowPath,bows,[1,5,20,30,40,50][i]!, 'ranged',i+1));
  const leatherPath='server/content/scripts/skill_crafting/configs/leather/leather_gear.obj', leather=read(leatherPath);
  for (const [symbol,family,level,quality] of [['leather_chaps','legs',1,2],['dragonhide_chaps','legs',40,8],['leather_vambraces','hands',1,1],['dragon_vambraces','hands',40,8]] as const) {
    add(symbol,family,leatherPath,leather,level,'ranged',quality);
  }
  for (const [file,suffix,family] of [['shields','sq_shield','shield'],['platebodies','platebody','body']] as const) {
    const path='server/content/scripts/skill_combat/configs/melee/'+file+'.obj', contents=read(path);
    // Basic kit first; higher tiers require additional source requirement validation.
    for(const m of ['bronze','iron']) add(m+'_'+suffix,family,path,contents,1,'defence',m==='iron'?2:1);
  }
  const shopSpecs = [
    ['horviks-armour-shop','Horvik',3229,3438,0,true], ['cassies-shield-shop','Cassie',2979,3383,0,true],
    ['bobs-brilliant-axes','Bob',3232,3203,0,true], ['varrock-swordshop','Shop keeper|Shop assistant',3203,3397,0,true],
    ['zekes-superior-scimitars','Zeke',3288,3190,0,true], ['lowes-archery-emporium','Lowe',3232,3423,0,true],
    ['scavvos-rune-store','Scavvo',3191,3351,1,false], ['nurmofs-pickaxe-shop','Nurmof',2998,9844,0,false],
    ['aarons-archery-appendages','Armour salesman',2667,3436,0,false],
  ] as const;
  const shops = shopSpecs.map(([key,npc,x,z,level,enabled]): Shop => {
    const source='wiki/shops/'+key+'.md', text=read(source);
    const shop: Shop={id:key,name:text.split(/\r?\n/)[0]!.replace(/^# /,''),npc,x,z,level,enabled,source,
      blocker:enabled?undefined:key==='scavvos-rune-store'?'32 Quest Points and verified guild/floor transition required':'Service route/transition not yet supported'};
    for (const match of text.matchAll(/\| \[([^\]]+)\]\([^)]*\) \| (\d+) \| (\d+) gp/g)) {
      const gear=items.find(i=>i.name.toLowerCase()===match[1]!.toLowerCase());
      if (gear && Number(match[2])>0) gear.methods.push({id:'buy:'+key+':'+gear.id,kind:'buy',shop,priceHint:Number(match[3]),source,blocker:shop.blocker});
    }
    return shop;
  });
  const ingredient=(symbol:string,count:number):Ingredient=>({id:id(symbol),name:symbol.replaceAll('_',' '),count});
  const smithPath='server/content/scripts/skill_smithing/configs/smithing/smithing.dbrow', smith=read(smithPath);
  const craftPath='server/content/scripts/skill_crafting/configs/leather/leather.dbrow', craft=read(craftPath);
  const stringPath='server/content/scripts/skill_fletching/configs/stringing/bows.dbrow', strings=read(stringPath);
  for (const gear of items) {
    const recipe=block(smith,gear.symbol);
    if(recipe) gear.methods.push({id:'smith:'+gear.id,kind:'craft',recipe:'smith',skill:'smithing',level:Number(field(recipe,'data=levelrequired')),
      inputs:[ingredient(field(recipe,'data=bar')!,Number(field(recipe,'data=bar_amount'))),ingredient('hammer',1)],source:smithPath+'#'+gear.symbol,
      prerequisites:['Train Smithing to the recipe level','Obtain bars: buy them or mine ores and coal, then smelt','Carry a hammer; use a verified anvil']});
    for(const row of craft.split(/\r?\n\[/)) {
      if(field(row,'data=product')!==gear.symbol)continue;
      const [material,count]=field(row,'data=leather')!.split(',');
      gear.methods.push({id:'craft:'+gear.id,kind:'craft',recipe:'leather',skill:'crafting',level:Number(field(row,'data=levelrequired')),
        inputs:[ingredient(material!,Number(count)),ingredient('needle',1),ingredient('thread',1)],source:craftPath,
        prerequisites:['Obtain the correct hide from a supported dragon (not a guessed drake source) or buy it','Tan hide into leather; raw hide is not a crafting input','Carry needle and thread; meet Crafting level']});
    }
    for(const row of strings.split(/\r?\n\[/)) {
      if(field(row,'data=product')?.split(',')[0]!==gear.symbol)continue;
      gear.methods.push({id:'string:'+gear.id,kind:'craft',recipe:'string',skill:'fletching',level:Number(field(row,'data=level')),
        inputs:[ingredient(field(row,'data=item')!,1),ingredient('bow_string',1)],source:stringPath,
        prerequisites:['Cut the correct log and fletch its unstrung bow at the required level','Obtain bowstring; string the bow (unstrung output cannot be equipped)']});
    }
    const wiki='wiki/items/'+gear.name.toLowerCase().replaceAll(' ','-')+'.md';
    try {
      const info=read(wiki);
      for(const m of info.matchAll(/Dropped by: \[([^\]]+)\]\([^)]*\) \(([^)]+)\)/g)) gear.methods.push({id:'drop:'+gear.id+':'+m[1],kind:'drop',source:wiki,
        blocker:'Requires verified safe encounter, travel and measured kill/drop time',prerequisites:[m[1]+' drop '+m[2],'Food, suitable gear, replacement-cost budget, and safe return route']});
    } catch { /* A missing wiki page supplies no drop claims. */ }
  }
  hash.update('goal-catalog-v1');
  return {namespace:hash.digest('hex'),items,shops,evidence};
}
