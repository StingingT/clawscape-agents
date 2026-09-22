/** Read-only, checksummed view of the existing catalogue. No game actions here. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { loadCatalog } from './io.ts';
import type { ItemCatalog, AcquisitionRoute, Recipe, CatalogItem, Requirement } from './types.ts';

export const SOURCE_ADAPTER_VERSION = 'source-catalogue-20260921.1';
export type SourceRecipe = Recipe & { locationIds?: string[]; semantics?: Record<string, any> };
export type SourceRoute = AcquisitionRoute & { semantics?: Record<string, any>; recipeId?: string; shopId?: string };
export type RuneRelationship = {
  id: string; profileId: string; runeItemId: number; essenceItemId: number; talismanItemId: number;
  runeType: number; skill: string; level: number; members: boolean; hasPlacedGenericEntranceAndAltar: boolean;
  entranceLocationIds: string[]; altarLocationIds: string[]; objectTypes: Record<string, Array<{id:number;symbol:string}>>;
  yield: {kind:string;divisor?:number|null};
};
export type SourceData = ItemCatalog & { recipes: SourceRecipe[]; routes: SourceRoute[]; runecrafting: RuneRelationship[] };
const normalize=(s:unknown)=>String(s??'').trim().toLowerCase().replace(/_/g,' ').replace(/\s+/g,' ');
const cache=new Map<string,SourceCatalogue>();
const sha=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const jsonl=(file:string)=>readFileSync(file,'utf8').split(/\r?\n/).filter(x=>x.trim()).map(x=>JSON.parse(x));

/** Every required file must be covered, not merely whatever an untrusted manifest happens to list. */
export function loadSourceCatalogue(directory:string):SourceCatalogue {
  const root=resolve(directory);
  if(cache.has(root))return cache.get(root)!;
  const sums=JSON.parse(readFileSync(resolve(root,'SHA256SUMS.json'),'utf8'));
  for(const file of ['manifest.json','items.jsonl','acquisition_routes.jsonl','recipes.jsonl','locations.jsonl','runecrafting.jsonl'])
    if(!/^[a-f0-9]{64}$/.test(sums[file]??''))throw new Error('SOURCE_CHECKSUM_MISSING: '+file);
  for(const [file,hash] of Object.entries(sums)) {
    if(file!==basename(file)||/[\\/]/.test(file)||file==='.'||file==='..')throw new Error('UNSAFE_SOURCE_CHECKSUM_PATH');
    if(sha(readFileSync(resolve(root,file)))!==hash)throw new Error('SOURCE_CHECKSUM_MISMATCH: '+file);
  }
  const source=new SourceCatalogue({...loadCatalog(root),runecrafting:jsonl(resolve(root,'runecrafting.jsonl'))} as SourceData);
  cache.set(root,source);return source;
}

export class SourceCatalogue {
  readonly data:SourceData;
  readonly items:Map<number,CatalogItem>;
  readonly routes:Map<string,SourceRoute>;
  readonly recipes:Map<string,SourceRecipe>;
  readonly locations:Map<string,ItemCatalog['locations'][number]>;
  readonly runes:Map<number,RuneRelationship>;
  private byProduct=new Map<number,SourceRecipe[]>();
  private names=new Map<string,Set<number>>();
  constructor(data:SourceData) {
    this.data=data;
    this.items=new Map(data.items.map(x=>[x.id,x]));this.routes=new Map(data.routes.map(x=>[x.id,x]));
    this.recipes=new Map(data.recipes.map(x=>[x.id,x]));this.locations=new Map(data.locations.map(x=>[x.id,x]));
    this.runes=new Map(data.runecrafting.map(x=>[x.runeItemId,x]));
    if(this.items.size!==data.items.length||this.routes.size!==data.routes.length||this.recipes.size!==data.recipes.length)
      throw new Error('DUPLICATE_SOURCE_ID');
    for(const item of data.items) {
      if(item.profileId!==data.profile.id)throw new Error('MIXED_SOURCE_PROFILES');
      for(const name of [item.symbol,item.name,...item.aliases??[]]) {
        const key=normalize(name),ids=this.names.get(key)??new Set<number>();ids.add(item.id);this.names.set(key,ids);
      }
      if(item.acquisitionRouteIds.some(id=>!this.routes.has(id)))throw new Error('BROKEN_SOURCE_ROUTE: '+item.id);
    }
    for(const r of data.recipes) {
      if(r.profileId!==data.profile.id||!this.items.has(r.productItemId)||!Number.isSafeInteger(r.outputQuantity)||r.outputQuantity<1)
        throw new Error('INVALID_SOURCE_RECIPE: '+r.id);
      for(const i of [...r.inputs,...r.tools??[]])
        if(!Number.isInteger(i.itemId)||!this.items.has(i.itemId!)||!Number.isSafeInteger(i.quantity)||i.quantity<1)
          throw new Error('INVALID_SOURCE_INPUT: '+r.id);
      const list=this.byProduct.get(r.productItemId)??[];list.push(r);this.byProduct.set(r.productItemId,list);
    }
  }
  item(key:number|string):CatalogItem|undefined {
    if(typeof key==='number')return this.items.get(key);
    const symbol=this.data.items.find(x=>x.symbol===key);if(symbol)return symbol;
    const ids=this.names.get(normalize(key));return ids?.size===1?this.items.get([...ids][0]!):undefined;
  }
  recipesFor(id:number):SourceRecipe[]{return this.byProduct.get(id)??[];}
  sourcesFor(id:number):SourceRoute[]{return (this.items.get(id)?.acquisitionRouteIds??[]).map(x=>this.routes.get(x)!).filter(Boolean);}
  /** Breadth/recursion bounded. Unknown leaves remain visible; bank is NOT carried stock. */
  dependencies(ids:number[],limit=96):{items:number[];truncated:boolean} {
    const found=new Set<number>();const queue=ids.map(id=>({id,depth:0}));let truncated=false;
    const requirementItems=(r:Requirement|undefined):number[]=>!r?[]:'all'in r?r.all.flatMap(requirementItems):'any'in r?r.any.flatMap(requirementItems):'itemId'in r?[r.itemId]:[];
    while(queue.length) {
      const {id,depth}=queue.shift()!;if(found.has(id))continue;
      if(found.size>=limit||depth>12){truncated=true;continue;}found.add(id);
      for(const r of this.recipesFor(id)) {
        for(const x of [...r.inputs,...r.tools??[],...r.semantics?.requiredCarriedItems??[]])
          if(Number.isInteger(x.itemId))queue.push({id:x.itemId!,depth:depth+1});
        const relation=this.runes.get(id);if(relation)queue.push({id:relation.talismanItemId,depth:depth+1});
      }
      // Gathering-tool OR branches are knowledge alternatives, not instructions to obtain every pickaxe.
      for(const r of this.sourcesFor(id).filter(r=>r.method==='gathering'))
        for(const tool of requirementItems(r.requirements))queue.push({id:tool,depth:depth+1});
    }
    return {items:[...found],truncated};
  }
}

/** Expected yield of ONE conditional event. Never summed into a guaranteed drop. */
export function expectedDropQuantity(route:SourceRoute):number|null {
  const p=route.semantics?.probability,out=route.outputs[0];
  if(route.evidenceStatus==='unresolved'||!p||!Number.isSafeInteger(p.numerator)||!Number.isSafeInteger(p.denominator)
    ||p.numerator<0||p.denominator<=0||p.numerator>p.denominator||!out)return null;
  let quantity=out.quantity;
  if(quantity===undefined&&out.quantityDistribution?.length) {
    const options=out.quantityDistribution;
    if(options.some(x=>x.weight===null||!Number.isFinite(x.weight)||x.weight!<0||x.quantity<0))return null;
    if(Math.abs(options.reduce((n,x)=>n+x.weight!,0)-1)>1e-8)return null;
    quantity=options.reduce((n,x)=>n+x.quantity*x.weight!,0);
  }
  return quantity!==undefined&&Number.isFinite(quantity)&&quantity>=0?quantity*p.numerator/p.denominator:null;
}

/** Deterministic output only. Random/conditional recipes require a different bounded trial executor. */
export function recipeYield(recipe:SourceRecipe,source:SourceCatalogue,skills:Record<string,number>):number|null {
  const y=recipe.semantics?.yield;
  if(y?.kind==='deterministic')return recipe.outputQuantity;
  if(y?.kind==='skill-dependent-integer') {
    const rune=source.runes.get(recipe.productItemId),level=rune&&skills[rune.skill];
    if(!rune||!rune.hasPlacedGenericEntranceAndAltar||!Number.isSafeInteger(level)||level!<rune.level)return null;
    return y.divisor?Math.floor(level!/y.divisor)+1:1;
  }
  return null;
}
