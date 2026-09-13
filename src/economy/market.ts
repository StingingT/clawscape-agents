import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { cashReserve, usable } from '../goals/planner';
import type { GearCatalog } from '../goals/catalog';
import { isFletchedOutput, type Action } from '../progression-policy';
import { bowArrowCap } from '../runtime-policy';

export const PEERS = ['clawscout', 'stinger', 'coincrafter', 'featherer'];
export const TRANSFER_BLOCKER = 'Player Trade option is not labelled in live state; item-offer transfer not live-verified. No automatic transfer or rendezvous.';
const FRESH = 30 * 60_000;
const count = (items: any[], id: number) => items.filter(i => i.id === id).reduce((n,i)=>n+Number(i.count),0);
const compact = (items:any[]) => [...new Set(items.map(i=>i.id))].map(id=>({id,name:items.find(i=>i.id===id).name,count:count(items,id)}));
const hash = (v:any) => createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0,20);
export type Quote = { item:number; price:number; at:number; kind:'npc-buy'|'npc-sell'|'external-sale'; source:string; verified?:boolean; seller?:string; buyer?:string };

// Local transfers do not establish inflation or create household wealth.
// An ask is not a sale. Require independent, verified trades for a market median.
export function marketMedian(quotes:Quote[], item:number, now:number):number|null {
  const rows=quotes.filter(q=>q.item===item && q.kind==='external-sale' && q.verified && q.at<=now && now-q.at<FRESH
    && q.price>0 && Number.isFinite(q.price) && q.seller && q.buyer && q.seller.toLowerCase()!==q.buyer.toLowerCase()
    && !(PEERS.includes(q.seller.toLowerCase()) && PEERS.includes(q.buyer.toLowerCase())));
  if(new Set(rows.map(q=>q.seller!.toLowerCase()+':'+q.buyer!.toLowerCase())).size<3)return null;
  const prices=rows.map(q=>q.price).sort((a,b)=>a-b), m=Math.floor(prices.length/2);
  return prices.length%2?prices[m]!:(prices[m-1]!+prices[m]!)/2;
}
export function bargain(input:{quantity:number; sellerOutside:number; sellerCost:number; buyerOutside:number; budget:number; handling:number; market?:number|null}) {
  if(!Object.values(input).filter(v=>v!==null&&v!==undefined).every(v=>typeof v==='number'&&Number.isFinite(v)&&v>=0)
    || !Number.isInteger(input.quantity)||input.quantity<1)return null;
  // Both parties must strictly improve on their outside option after a handling
  // allowance. Budgets are separate from prices, never inferred from wealth.
  const floor=Math.ceil(Math.max(input.sellerOutside,input.sellerCost)*input.quantity+input.handling+1);
  const ceiling=Math.floor(Math.min(input.budget,input.buyerOutside*input.quantity-input.handling-1));
  if(floor>ceiling)return null;
  const ask=Math.max(floor,Math.min(ceiling,Math.round((input.market??input.buyerOutside)*input.quantity)));
  const counter=Math.floor((floor+ask)/2);
  return {floor,ceiling,ask,counter,quantity:input.quantity};
}
export function peerDemand(s:any, character:string, catalog:GearCatalog, bank:any[]=[]) {
  const inv=s.inventory??[], eq=s.equipment??[], cash=count(inv,995)+count(bank,995), budget=Math.max(0,cash-cashReserve(cash));
  const family=character==='stinger'?'bow':'melee';
  const held=Math.max(0,...catalog.items.filter(g=>g.family===family&&count([...inv,...eq,...bank],g.id)>0).map(g=>g.quality));
  const result=catalog.items.filter(g=>g.family===family&&usable(g,s)&&g.quality>held).map(g=>({id:g.id,name:g.name,quantity:1,quality:g.quality}));
  if(character==='stinger') {
    const tiers=['bronze','iron','steel','mithril','adamant','rune'];
    const cap=bowArrowCap(s.combatStyle?.weaponName??'');
    const ammo=[882,884,886,888,890,892].filter((_,i)=>i+1<=cap);
    const reserve=ammo.reduce((n,id)=>n+count([...inv,...eq,...bank],id),0);
    if(reserve<100)ammo.forEach((id,i)=>result.unshift({id,name:tiers[i]+' arrow',quantity:Math.min(100,100-reserve),quality:0}));
  }
  return {budget,items:character==='coincrafter'?[]:result};
}

// SQLite transactions coordinate bookkeeping only. Every game command is still
// executed by the character's existing sole controller. No tokens enter this DB.
export class PeerMarket {
  db:Database;
  constructor(file:string,private character:string,private catalog:GearCatalog,private now=()=>Date.now(),private world='https://clawscape.xyz') {
    mkdirSync(dirname(file),{recursive:true}); this.db=new Database(file);
    // Every controller opens this shared, local coordination database. Set the
    // wait policy before schema work; asking SQLite to change journal mode on
    // every concurrent startup can itself take the exclusive lock and kill two
    // otherwise independent agents. A previous successful opener enables WAL.
    this.db.exec('PRAGMA busy_timeout=15000;');
    try { this.db.exec('PRAGMA journal_mode=WAL;'); }
    catch (error) {
      if (!/database is locked/i.test(error instanceof Error ? error.message : String(error))) throw error;
    }
    this.db.exec(`CREATE TABLE IF NOT EXISTS snapshots(world TEXT,character TEXT,at INTEGER,body TEXT,PRIMARY KEY(world,character));
      CREATE TABLE IF NOT EXISTS quotes(world TEXT,source TEXT,item INTEGER,kind TEXT,at INTEGER,price REAL,PRIMARY KEY(world,source,item,kind));
      CREATE TABLE IF NOT EXISTS deals(id TEXT PRIMARY KEY,world TEXT,seller TEXT,buyer TEXT,item INTEGER,body TEXT,stage TEXT,expires INTEGER);
      CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY,world TEXT,sender TEXT,target TEXT,body TEXT,status TEXT,at INTEGER);
      CREATE INDEX IF NOT EXISTS peer_message_queue ON messages(world,sender,status);`);
  }
  close(){this.db.close();}
  private rows(){return (this.db.query('SELECT character,body FROM snapshots WHERE world=? AND at>=?').all(this.world,this.now()-FRESH) as any[]).map(r=>({character:r.character,...JSON.parse(r.body)})).filter(r=>r.namespace===this.catalog.namespace);}
  private enqueue(target:string,body:string,key:string) {
    if(!PEERS.includes(target)||target===this.character)return;
    const id=hash([this.world,this.character,target,key,Math.floor(this.now()/FRESH)]);
    this.db.query('INSERT OR IGNORE INTO messages VALUES (?,?,?,?,?,?,?)').run(id,this.world,this.character,target,body,'queued',this.now());
  }
  observe(s:any,bank:any[],bankAt:number,production?:any) {
    if(!PEERS.includes(this.character))return;
    this.db.query("UPDATE messages SET status='superseded' WHERE world=? AND sender=? AND status='queued' AND body LIKE '%after my two current skills reach 99%'").run(this.world,this.character);
    const freshBank=bankAt>0&&this.now()-bankAt<FRESH?bank:[];
    const body={namespace:this.catalog.namespace,inventory:compact(s.inventory??[]),bank:compact(freshBank),bankAt:bankAt||null,
      equipment:compact(s.equipment??[]),demand:peerDemand(s,this.character,this.catalog,freshBank),
      skills:Object.fromEntries((s.skills??[]).map((v:any)=>[v.name.toLowerCase(),v.baseLevel??v.level])),
      production: this.character==='coincrafter'?{objective:'Maximize sustainable net wealth; train or gather when it advances that outcome',...production,transferBlocker:TRANSFER_BLOCKER}:undefined};
    this.db.query('INSERT OR REPLACE INTO snapshots VALUES (?,?,?,?)').run(this.world,this.character,this.now(),JSON.stringify(body));
    if(s.shop?.isOpen) {
      const source=String(s.shop.name??'shop')+':'+s.player.worldX+','+s.player.worldZ;
      for(const [kind,items,field] of [['npc-buy',s.shop.shopItems??[],'buyPrice'],['npc-sell',s.shop.playerItems??[],'sellPrice']] as const)for(const i of items) {
        if(!Number.isFinite(i[field])||i[field]<=0||kind==='npc-buy'&&!(i.count>0))continue;
        // General shops accept normal tradeable goods; specialty quotes for an
        // unsupported item are not a viable seller outside option.
        if(kind==='npc-sell'&&!/general/i.test(s.shop.name??'')&&!s.shop.shopItems?.some((r:any)=>r.id===i.id))continue;
        this.db.query('INSERT OR REPLACE INTO quotes VALUES (?,?,?,?,?,?)').run(this.world,source,i.id,kind,this.now(),i[field]);
      }
    }
    this.db.query("UPDATE messages SET status='expired' WHERE world=? AND status='queued' AND at<?").run(this.world,this.now()-FRESH);
    this.db.query("UPDATE deals SET stage='expired' WHERE world=? AND expires<? AND stage!='expired'").run(this.world,this.now());
    // Bounded retention, not an ever-growing tick log.
    this.db.query('DELETE FROM messages WHERE world=? AND at<?').run(this.world,this.now()-7*86400_000);
    this.db.query('DELETE FROM deals WHERE world=? AND expires<?').run(this.world,this.now()-7*86400_000);
    this.negotiate();
  }
  private negotiate(){
    const rows=this.rows(),mine=rows.find(r=>r.character===this.character);if(!mine)return;
    const producer=rows.find(r=>r.character==='coincrafter');
    if(this.character!=='coincrafter'&&mine.demand.items.length&&producer) {
      const ammo=mine.demand.items.some((i:any)=>i.quantity>1);
      this.enqueue('coincrafter',`Looking for ${this.character==='stinger'?(ammo?'arrows and a finished shortbow upgrade':'a finished shortbow upgrade'):'a better melee weapon'}. I can spare up to ${mine.demand.budget} gp after supplies. Anything worth buying?`,'request');
    }
    if(this.character==='coincrafter') for(const buyer of rows.filter(r=>r.character!==this.character&&r.demand?.items.length)) {
      const stock=[...mine.inventory,...mine.bank], demands=buyer.demand.items;
      const matches=demands.filter((d:any)=>count(stock,d.id)>0&&!mine.equipment.some((i:any)=>i.id===d.id));
      if(!matches.length){
        const unfinished=stock.some(isFletchedOutput),shafts=count(stock,52)>0;
        const requested=this.db.query("SELECT id FROM messages WHERE world=? AND sender=? AND target=? AND status IN ('submitted','echo-verified','submitted-unconfirmed') AND at>?").get(this.world,buyer.character,this.character,this.now()-FRESH);
        if(!requested)continue;
        this.enqueue(buyer.character,buyer.character==='stinger'
          ? `My ${unfinished?'banked bows are unstrung':'bow stock is not ready'}${shafts?', and shafts still need feathers and arrowheads':''}. I need to price the remaining materials before promising finished kit.`
          : 'I have no spare melee upgrade yet. I will compare making your gear against buying it; Mining and Smithing are options when the costs and likely return justify them.','stock-status-v2');
      }
      for(const d of matches){
        const quotes=this.db.query('SELECT kind,price FROM quotes WHERE world=? AND item=? AND at>=?').all(this.world,d.id,this.now()-FRESH) as any[];
        const sells=quotes.filter(q=>q.kind==='npc-sell').map(q=>q.price),buys=quotes.filter(q=>q.kind==='npc-buy').map(q=>q.price);
        if(!sells.length||!buys.length)continue; // unknown opportunity cost is not free
        const quantity=Math.min(d.quantity,count(stock,d.id)),terms=bargain({quantity,sellerOutside:Math.max(...sells),sellerCost:0,buyerOutside:Math.min(...buys),budget:buyer.demand.budget,handling:2});
        if(!terms)continue;
        // One active deal per buyer: cannot overcommit the same wallet/stock.
        if(this.db.query("SELECT id FROM deals WHERE world=? AND buyer=? AND stage!='expired'").get(this.world,buyer.character))break;
        const id=hash([this.world,this.character,buyer.character,d.id,Math.floor(this.now()/FRESH)]);
        const body={...terms,name:d.name,transferBlocker:TRANSFER_BLOCKER};
        this.db.query('INSERT OR IGNORE INTO deals VALUES (?,?,?,?,?,?,?,?)').run(id,this.world,this.character,buyer.character,d.id,JSON.stringify(body),'offered',this.now()+FRESH);
        this.enqueue(buyer.character,`I have ${quantity} ${d.name}. How about ${terms.ask} gp total? Both of us beat the shop prices I checked. Delivery is on hold until safe trading works.`,id+':ask');break;
      }
    }
    for(const deal of this.db.query("SELECT * FROM deals WHERE world=? AND expires>? AND stage IN ('offered','countered')").all(this.world,this.now()) as any[]){
      const terms=JSON.parse(deal.body);
      if(deal.buyer===this.character&&deal.stage==='offered'&&mine.demand.items.some((d:any)=>d.id===deal.item)&&mine.demand.budget>=terms.counter){
        this.db.query("UPDATE deals SET stage='countered' WHERE id=? AND stage='offered'").run(deal.id);
        this.enqueue(deal.seller,`Could you do ${terms.counter} gp for ${terms.quantity} ${terms.name}? That leaves my food and ammunition reserve intact.`,deal.id+':counter');
      } else if(deal.seller===this.character&&deal.stage==='countered'&&terms.counter>=terms.floor&&count([...mine.inventory,...mine.bank],deal.item)>=terms.quantity){
        this.db.query("UPDATE deals SET stage='agreed-pending-safe-transfer' WHERE id=? AND stage='countered'").run(deal.id);
        this.enqueue(deal.buyer,`${terms.counter} gp works for me. That is a provisional price, not a completed sale; we can settle once safe trading is available.`,deal.id+':agree');
      }
    }
  }
  next(s:any):Action|undefined {
    if(!PEERS.includes(this.character)||s.modalOpen||s.dialog?.isOpen||s.bank?.isOpen||s.shop?.isOpen||s.player?.combat?.inCombat||Number(s.player?.animId)>=0)return;
    // Social trade is optional. A longer cooldown prevents a queued or
    // unconfirmed message from monopolising an agent that should be training,
    // gathering, banking or travelling.
    const recent=this.db.query("SELECT id FROM messages WHERE world=? AND sender=? AND status IN ('submitted','echo-verified','submitted-unconfirmed') AND at>?").get(this.world,this.character,this.now()-300_000);
    if(recent)return;
    const row=this.db.query("SELECT * FROM messages WHERE world=? AND sender=? AND status='queued' ORDER BY at LIMIT 1").get(this.world,this.character) as any;
    if(row)return {id:'peer-message-'+row.id,type:'privateMessage',fields:{targetName:row.target,message:row.body},waitTicks:2};
  }
  before(action:Action){if(action.id.startsWith('peer-message-'))this.db.query("UPDATE messages SET status='submitted',at=? WHERE id=? AND status='queued'").run(this.now(),action.id.slice(13));}
  after(s:any,action:Action){
    if(!action.id.startsWith('peer-message-'))return;
    const echo=s.gameMessages?.some((m:any)=>m.fromSelf&&m.text?.toLowerCase()===String(action.fields?.message).toLowerCase());
    this.db.query('UPDATE messages SET status=? WHERE id=?').run(echo?'echo-verified':'submitted-unconfirmed',action.id.slice(13));
  }
  overview(){return {transferEnabled:false,blocker:TRANSFER_BLOCKER,agents:this.rows(),deals:(this.db.query('SELECT * FROM deals WHERE world=? AND expires>?').all(this.world,this.now()) as any[]).map(d=>({...d,body:JSON.parse(d.body)})),
    messages:this.db.query('SELECT sender,target,body,status,at FROM messages WHERE world=? ORDER BY at DESC LIMIT 12').all(this.world)};}
}
