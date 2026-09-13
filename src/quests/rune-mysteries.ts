import { distance, validTile, type Tile } from '../navigation/geometry';
import { isFood, isThreatened } from '../runtime-policy';

export type QuestAction = { id: string; type: string; fields?: Record<string, any>; waitTicks: number };
export type QuestMemory = {
  character: string; stage?: number; journalAt?: string; evidence?: string;
  needsJournal?: boolean; tabSelected?: boolean; completed?: boolean; returned?: boolean;
  blocked?: string; failures?: number; actions?: number;
  itinerary?: Tile[]; itineraryKey?: string;
  preparingFood?: boolean;
  foodUnavailable?: Record<string, number>;
};
export const QUEST_ITEMS = [1438, 290, 291]; // Air talisman, Research package, Notes (2004 names).
export const QUEST_JOURNAL = 8134;
export const QUEST_BUTTON = 7335;
// Low-level travel detours south of the bear spawned at (3176,3223).
// Its source wander range is 13, size 2 and hunt range 1. These are route
// hints, not collision edits or a guarantee of safety in the live world.
export const SOUTH_ROAD: Tile[] = [
  {x:3202,z:3200,level:0}, {x:3148,z:3200,level:0}, {x:3120,z:3208,level:0},
];
export const EAST_ROAD: Tile[] = [
  {x:3274,z:3428,level:0}, {x:3274,z:3330,level:0},
  {x:3238,z:3275,level:0}, {x:3222,z:3218,level:0},
];
export const TRANSITIONS = {
  castleUp: { id: 1738, at: { x: 3204, z: 3229, level: 0 }, approach: { x: 3205, z: 3228, level: 0 }, exit: { x: 3205, z: 3228, level: 1 }, option: 'Climb-up' },
  castleDown: { id: 1739, at: { x: 3204, z: 3229, level: 1 }, approach: { x: 3205, z: 3228, level: 1 }, exit: { x: 3205, z: 3228, level: 0 }, option: 'Climb-down' },
  towerDown: { id: 2147, at: { x: 3104, z: 3162, level: 0 }, approach: { x: 3105, z: 3162, level: 0 }, exit: { x: 3104, z: 9576, level: 0 }, option: 'Climb-down' },
  towerUp: { id: 2148, at: { x: 3103, z: 9576, level: 0 }, approach: { x: 3104, z: 9576, level: 0 }, exit: { x: 3105, z: 3162, level: 0 }, option: 'Climb-up' },
} as const;
export const QUEST_NPCS = {
  duke: { typeId: 741, name: /^Duke Horacio$/i, approach: { x: 3211, z: 3220, level: 1 } },
  sedridor: { typeId: 300, name: /^(Sedridor|Head wizard)$/i, approach: { x: 3103, z: 9572, level: 0 } },
  aubury: { typeId: 553, name: /^Aubury$/i, approach: { x: 3253, z: 3402, level: 0 } },
};
const at = (s: any): Tile => ({ x: s.player?.worldX, z: s.player?.worldZ, level: s.player?.level });
const clean = (s: string) => s.replace(/@[a-z0-9]{3}@/gi, '').replace(/<[^>]*>/g, '').replace(/\|/g, ' ').replace(/\s+/g, ' ').trim();
export function journalText(s: any): string {
  if (s.interface?.interfaceId !== QUEST_JOURNAL || !s.interface.isOpen) return '';
  return clean((s.interface.debugInfo ?? []).map((line: string) => {
    const raw = /text=(.*)$/.exec(line)?.[1];
    if (!raw) return '';
    try { return JSON.parse(raw); } catch { return ''; }
  }).join(' '));
}
export function journalStage(s: any): number | undefined {
  const text = journalText(s);
  if (!/Rune Mysteries/i.test(text)) return;
  if (/QUEST COMPLETE!/i.test(text)) return 6;
  if (/I should take the notes to Sedridor/i.test(text)) return 5;
  if (/I should speak to Aubury again/i.test(text)) return 4;
  if (/I should take this Research Package/i.test(text)) return 3;
  if (/I should talk to the Head Wizard again/i.test(text)) return 2;
  if (/I need to find the Head Wizard/i.test(text)) return 1;
  if (/I can start this quest by speaking to/i.test(text)) return 0;
}
export function questDialogue(options: any[]): any | undefined {
  const valid = options.filter(o => Number.isInteger(o.index));
  const patterns = [/have you any quests for me/i, /^Sure, no problem\.?$/i,
    /I'm looking for the head wizard/i, /^Ok, here you are\.?$/i,
    /^Yes, certainly\.?$/i, /I have been sent here with a package for you/i,
    /click here to continue|^continue$/i];
  for (const pattern of patterns) { const found = valid.find(o => pattern.test(o.text)); if (found) return found; }
  return undefined; // No random first-option or rune-shop purchase fallback.
}

export class RuneMysteries {
  constructor(public memory: QuestMemory) {
    memory.needsJournal = true; memory.tabSelected = false;
    // Recompute from the real restart position; never reuse an obsolete road.
    memory.itinerary=[]; memory.itineraryKey=undefined;
  }
  summary() { return { quest: 'Rune Mysteries', stage: this.memory.stage ?? 'unknown', complete: this.memory.completed === true, returned: this.memory.returned === true, blocker: this.memory.blocked, journalAt: this.memory.journalAt, evidence: this.memory.evidence }; }
  block(reason: string) { this.memory.blocked = reason; }
  private action(id: string, type: string, fields = {}, waitTicks = 2): QuestAction { return { id: `quest-${id}`, type, fields, waitTicks }; }
  private walk(id: string, target: Tile) { return this.action(id, 'walkTo', { ...target, reason: 'Rune Mysteries verified-route leg' }); }
  observe(before: any, after: any, action: QuestAction, result?: any) {
    const m = this.memory;
    m.actions = (m.actions ?? 0) + 1;
    if (before.player?.lifeId !== after.player?.lifeId || Number(after.player?.respawnCount ?? 0) > Number(before.player?.respawnCount ?? 0)) { m.needsJournal = true; m.itinerary = []; return this.block('respawned-during-quest'); }
    if (after.player?.hp < before.player?.hp || isThreatened(after)) return this.block('damage-or-combat-during-quest');
    if (result?.success === false || result?.error || result?.navigation?.status === 'blocked') return this.block(`action-failed:${action.id}`);
    if(action.id==='quest-recover-health') {
      const id=(before.inventory??[]).find((i:any)=>i.slot===action.fields?.slot)?.id;
      const count=(s:any)=>(s.inventory??[]).filter((i:any)=>i.id===id).reduce((n:number,i:any)=>n+i.count,0);
      if(id===undefined || count(after)>=count(before) || after.player.hp<=before.player.hp) return this.block('quest-healing-unverified');
    }
    if (action.id === 'quest-select-tab') m.tabSelected = true;
    if (action.id === 'quest-pick-food' && (after.inventory ?? []).filter((i:any)=>i.id===1965).reduce((n:number,i:any)=>n+i.count,0)
      <= (before.inventory ?? []).filter((i:any)=>i.id===1965).reduce((n:number,i:any)=>n+i.count,0)) {
      // Plants deplete and nearby-loc snapshots can briefly retain them. Do not
      // count a pickup without inventory evidence; choose another observed crop.
      m.foodUnavailable ??= {}; m.foodUnavailable[`${action.fields?.x},${action.fields?.z}`]=Date.now()+60000;
      return;
    }
    if (action.id === 'quest-read-journal') {
      const stage = journalStage(after);
      if (stage === undefined) return this.block('quest-journal-unavailable');
      if (m.stage !== stage) { m.itinerary = []; m.itineraryKey = undefined; m.failures = 0; m.actions = 0; }
      m.stage = stage; m.completed = stage === 6; m.returned = false; m.needsJournal = false; m.tabSelected = false;
      m.journalAt = new Date().toISOString(); m.evidence = journalText(after).slice(-700);
    }
    if (action.id.startsWith('quest-transition-')) {
      const transition = TRANSITIONS[action.id.slice('quest-transition-'.length) as keyof typeof TRANSITIONS];
      if (!transition || distance(at(after), transition.exit) > 1) return this.block('transition-arrival-unverified');
      m.failures = 0;
    }
    if ((action.type === 'talkToNpc' || action.type === 'clickDialogOption') && !after.dialog?.isOpen) {
      m.needsJournal = true; m.tabSelected = false;
      m.failures = (m.failures ?? 0) + 1;
      if (m.failures > 3) this.block('quest-dialogue-no-stage-progress');
    }
    if ((m.actions ?? 0) > 300) this.block('quest-stage-action-budget');
  }
  private transition(key: keyof typeof TRANSITIONS, s: any): QuestAction {
    const t = TRANSITIONS[key];
    if (distance(at(s), t.approach) > 0) return this.walk(`approach-${key}`, t.approach);
    const loc = (s.nearbyLocs ?? []).find((l: any) => l.id === t.id && l.x === t.at.x && l.z === t.at.z && l.level === t.at.level && l.reachable === true);
    const option = loc?.optionsWithIndex?.find((o: any) => o.text.toLowerCase() === t.option.toLowerCase());
    if (!option || !Number.isInteger(option.opIndex)) { this.block(`transition-not-observed:${key}`); return this.action('blocked', 'wait'); }
    return this.action(`transition-${key}`, 'interactLoc', { x: loc.x, z: loc.z, locId: loc.id, optionIndex: option.opIndex }, 6);
  }
  private npc(key: keyof typeof QUEST_NPCS, s: any): QuestAction {
    const n = QUEST_NPCS[key];
    if (distance(at(s), n.approach) > 4) return this.walk(`approach-${key}`, n.approach);
    const npc = (s.nearbyNpcs ?? []).find((p: any) => n.name.test(p.name) && p.reachable === true && Number.isInteger(p.index)
      && (p.typeId === undefined || p.typeId === n.typeId));
    if (!npc) {
      if (distance(at(s), n.approach) > 0) return this.walk(`approach-${key}`, n.approach);
      this.block(`quest-npc-not-observed:${key}`); return this.action('blocked', 'wait');
    }
    return this.action(`talk-${key}`, 'talkToNpc', { npcIndex: npc.index, reason: `Rune Mysteries: speak to ${key}` }, 3);
  }
  private surface(destination: 'castle' | 'tower' | 'aubury', s: any): QuestAction | undefined {
    const p = at(s), m = this.memory;
    const key = `${m.stage}:${destination}`;
    if (m.itineraryKey !== key) {
      // Surface travel is kept east of Varrock's dark wizards and south of the
      // Draynor jail guards. Coordinates are source/map-checked approach hints;
      // Navigator still proves every same-plane leg and handles crossed doors.
      const lumbridge = { x: 3222, z: 3218, level: 0 };
      const eastRoad = EAST_ROAD;
      if (destination === 'aubury') m.itinerary = [
        ...(p.x<3195 && p.z<3250 ? [SOUTH_ROAD[1]!,SOUTH_ROAD[0]!] : []),
        ...(p.z>3384 ? [] : [lumbridge, ...eastRoad.slice(0, 3).reverse()]),
        {x:3253,z:3410,level:0},QUEST_NPCS.aubury.approach];
      else m.itinerary = [...(p.z > 3320 ? eastRoad : p.z > 3230 ? [eastRoad[2]!, lumbridge] : [lumbridge]),
        ...(destination === 'tower' ? SOUTH_ROAD : [])];
      if(destination==='tower' && p.x<3274 && p.z>3384 && p.z<3426)
        m.itinerary.unshift({x:3238,z:3426,level:0}); // Depart north, away from the shop's roaming mugger.
      // Already at the tower (e.g. just climbed out): do not take a redundant
      // Lumbridge loop on a resumed tower trip.
      if (destination === 'tower' && p.x < 3120 && p.z < 3180) m.itinerary = [];
      // Aubury needs TWO conversations. A changed quest stage at the same
      // service is not a reason to repeat the entire Lumbridge travel circuit.
      if (destination === 'aubury' && distance(p, QUEST_NPCS.aubury.approach)<=20) m.itinerary=[];
      m.itineraryKey = key;
    }
    while (m.itinerary?.length && distance(p, m.itinerary[0]!) === 0) m.itinerary.shift();
    return m.itinerary?.length ? this.walk(`road-${destination}`, m.itinerary[0]!) : undefined;
  }
  private prepareFood(s: any): QuestAction | undefined {
    const inv=s.inventory ?? [], m=this.memory;
    const food=inv.filter(isFood).reduce((n:number,i:any)=>n+Number(i.count),0);
    if (food>=8) { m.preparingFood=false; m.itinerary=[]; m.itineraryKey=undefined; return; }
    if (at(s).level!==0 || at(s).z>9000) { this.block('food-resupply-needs-surface'); return; }
    if (s.bank?.isOpen) {
      // Finish banking the batch; never drop quest items, tools, cash or food.
      const log=inv.find((i:any)=>/^(logs|oak logs|willow logs|maple logs|yew logs|magic logs)$/i.test(i.name));
      if(log) return this.action('bank-logs-for-quest','bankDeposit',{slot:log.slot,amount:28});
      return this.action('close-food-bank','closeModal');
    }
    if (inv.length>17) {
      if(!inv.some((i:any)=>/^(logs|oak logs|willow logs|maple logs|yew logs|magic logs)$/i.test(i.name))) { this.block('quest-inventory-space-required');return; }
      const booth=(s.nearbyLocs??[]).find((l:any)=>/bank booth/i.test(l.name)&&l.reachable===true&&l.optionsWithIndex?.some((o:any)=>/^use-quickly$/i.test(o.text)));
      if(booth) return this.action('open-food-bank','interactLoc',{x:booth.x,z:booth.z,locId:booth.id,optionIndex:booth.optionsWithIndex.find((o:any)=>/^use-quickly$/i.test(o.text)).opIndex},3);
      const bank={x:3094,z:3491,level:0};
      if(distance(at(s),bank)===0){this.block('food-preparation-bank-unavailable');return;}
      return this.walk('food-bank',bank);
    }
    // Source m49_51 has ordinary (not Draynor Manor quest) cabbage plants.
    // This is a free emergency travel reserve, not a claim of optimal combat food.
    const patch={x:3195,z:3286,level:0};
    if(distance(at(s),patch)>4) return this.walk('food-patch',patch);
    const plant=(s.nearbyLocs??[]).filter((l:any)=>l.id===1161&&l.level===0&&l.x>=3194&&l.x<=3200&&l.z>=3285&&l.z<=3295&&l.reachable===true
      && (m.foodUnavailable?.[`${l.x},${l.z}`]??0)<Date.now())
      .sort((a:any,b:any)=>distance(at(s),a)-distance(at(s),b))
      .find((l:any)=>l.optionsWithIndex?.some((o:any)=>/^pick$/i.test(o.text)));
    if(plant) return this.action('pick-food','interactLoc',{x:plant.x,z:plant.z,locId:plant.id,optionIndex:plant.optionsWithIndex.find((o:any)=>/^pick$/i.test(o.text)).opIndex},3);
    if(distance(at(s),patch)>0)return this.walk('food-patch',patch);
    this.block('food-plants-unavailable');return;
  }
  next(s: any): QuestAction | undefined {
    const m = this.memory, p = at(s);
    if (!s.inGame || !s.player || s.player.isDead) { this.block('no-live-player'); return; }
    if (!validTile(p) || !Number.isInteger(s.tick) || !Number.isFinite(s.player.hp) || !Number.isFinite(s.player.maxHp) || s.player.maxHp<=0) { this.block('incomplete-quest-observation');return; }
    if (m.blocked) return;
    if (isThreatened(s)) { this.block('combat-before-quest'); return; }
    if (s.dialog?.isOpen) {
      if (s.dialog.isWaiting) return this.action('dialog-wait', 'wait');
      const option = questDialogue(s.dialog.options ?? []);
      if (!option) { this.block('unrecognized-quest-dialogue'); return; }
      return this.action('dialog', 'clickDialogOption', { optionIndex: option.index });
    }
    if (m.needsJournal || m.stage === undefined) {
      if (s.modalOpen) return this.action('close-before-journal', 'closeModal');
      return m.tabSelected ? this.action('read-journal', 'clickComponent', { componentId: QUEST_BUTTON })
        : this.action('select-tab', 'setTab', { tabIndex: 2 });
    }
    if (m.preparingFood && s.bank?.isOpen) return this.prepareFood(s);
    if (s.modalOpen || s.bank?.isOpen || s.shop?.isOpen) return this.action('close-interface', 'closeModal');
    if (m.completed) {
      if (p.z > 9500 && p.z < 9600 && p.x > 3070 && p.x < 3130) return this.transition('towerUp', s);
      if (p.level === 1 && p.x >= 3200 && p.x < 3220 && p.z >= 3200 && p.z < 3240) return this.transition('castleDown', s);
      if (p.level !== 0) { this.block('unsupported-return-plane'); return; }
      m.returned = true; return;
    }
    // Travel with a reserve. Do not drag a low-HP economy character past
    // aggressive NPCs just because the quest itself has no required combat.
    const healthTarget=s.player.maxHp<=15 ? s.player.maxHp : Math.ceil(s.player.maxHp*.9);
    if(s.player.hp<healthTarget) {
      const food=(s.inventory??[]).find(isFood);
      if(food && Number.isInteger(food.slot)) return this.action('recover-health','useInventoryItem',
        {slot:food.slot,optionIndex:food.optionsWithIndex.find((o:any)=>/^eat$/i.test(o.text)).opIndex},3);
      this.block('quest-health-reserve-required'); return;
    }
    if ((s.inventory ?? []).filter(isFood).reduce((n: number, i: any) => n + Number(i.count), 0) < 2) m.preparingFood=true;
    if(m.preparingFood) { const prep=this.prepareFood(s); if(prep||m.blocked)return prep; }
    if ((s.inventory ?? []).length > 25) { this.block('quest-inventory-space-required'); return; }
    const stage = m.stage!;
    const has = (id: number) => (s.inventory ?? []).some((i: any) => i.id === id && i.count > 0);
    // A missing package/notes is recovered from its giver, not guessed from
    // Runecraft level or an unrelated talisman. Banked items need withdrawal.
    let destination: 'duke' | 'sedridor' | 'aubury' = stage === 0 ? 'duke' : stage === 1 ? (has(1438) ? 'sedridor' : 'duke')
      : stage === 2 ? 'sedridor' : stage === 3 ? (has(290) ? 'aubury' : 'sedridor') : stage === 4 ? 'aubury' : has(291) ? 'sedridor' : 'aubury';
    if (p.level === 1 && p.x >= 3200 && p.x < 3225 && p.z >= 3200 && p.z < 3240) return destination === 'duke' ? this.npc('duke', s) : this.transition('castleDown', s);
    const basement = p.level === 0 && p.z > 9500 && p.z < 9600 && p.x > 3070 && p.x < 3130;
    if (basement) return destination === 'sedridor' ? this.npc('sedridor', s) : this.transition('towerUp', s);
    if (p.level !== 0 || p.z > 9000) { this.block('unsupported-quest-origin'); return; }
    const road = this.surface(destination === 'duke' ? 'castle' : destination === 'sedridor' ? 'tower' : 'aubury', s);
    if (road) return road;
    return destination === 'duke' ? this.transition('castleUp', s) : destination === 'sedridor' ? this.transition('towerDown', s) : this.npc('aubury', s);
  }
}
