/** Source knowledge predicts outputs; only fresh, balanced observations can verify them. */
import type { SourceCatalogue } from '../catalog/source-catalogue.ts';
import type { SourceTask } from './source-methods.ts';
import { atRuneTemple, sourceCount } from './source-methods.ts';
import type { LiveState } from './world-model.ts';
import type { LiveCandidate, Verification } from './live-adapter.ts';

export function sourceOutcome(source:SourceCatalogue,task:SourceTask,before:LiveState,after:LiveState,action:LiveCandidate,original:Verification):Verification {
  if(original.status==='rejected'||original.status==='interrupted')return original;
  const unknown=(reason:string):Verification=>({status:'unknown',evidence:[],reason});
  const yes=(reason:string):Verification=>({status:'verified',evidence:[reason,`source-profile:${source.data.profile.id}`,`fresh-ticks:${before.tick}->${after.tick}`]});
  if(task.profileId!==source.data.profile.id||!before.player||!after.player||before.player.lifeId!==after.player.lifeId
    ||after.inGame!==true||!Number.isFinite(before.tick)||!Number.isFinite(after.tick)||after.tick<=before.tick
    ||!Array.isArray(before.inventory)||!Array.isArray(after.inventory))return unknown('Fresh same-life inventory and source identity required for source outcome.');
  for(const key of ['character','world','worldEpoch','sessionId','profileId'])
    if(before[key]!==undefined&&after[key]!==undefined&&before[key]!==after[key])return unknown('Source outcome observation identity changed.');
  const delta=(id:number)=>sourceCount(after.inventory,id)-sourceCount(before.inventory,id);
  if(task.kind==='rune-entry'&&action.type==='useItemOnLoc') {
    const rune=source.runes.get(task.itemId);
    return rune&&!atRuneTemple(source,task.itemId,before)&&atRuneTemple(source,task.itemId,after)
      &&sourceCount(after.inventory,rune.talismanItemId)>=1&&delta(rune.talismanItemId)===0
      ?yes('Matching rune temple entered; reusable matching talisman retained.'):unknown('Matching rune temple arrival not yet observed.');
  }
  if(task.kind==='shop'&&action.type==='shopBuy')return delta(task.itemId)===1&&delta(995)===-task.expectedPrice!
    ?yes(`Single item ${task.itemId} and exact quoted payment ${task.expectedPrice} GP reconciled.`):unknown('Source purchase item/payment do not match the quote.');
  if(task.kind!=='recipe'||!['useItemOnItem','useItemOnLoc','interactLoc','clickDialogOption'].includes(action.type))return original;
  const recipe=task.recipeId&&source.recipes.get(task.recipeId);if(!recipe)return unknown('Receipt recipe is unavailable.');
  const untouched=recipe.inputs.every(x=>delta(x.itemId!)===0)&&(recipe.tools??[]).every(x=>delta(x.itemId!)===0)&&delta(task.itemId)===0;
  // Opening a requested production panel is preparation, NOT recipe success. Director sees unchanged item facts.
  const panelNew=before.dialog?.isOpen!==true&&after.dialog?.isOpen===true||before.interface?.isOpen!==true&&after.interface?.isOpen===true;
  if(recipe.semantics?.capability==='knife-on-log-select-product'&&action.type==='useItemOnItem'&&untouched&&panelNew&&original.status==='verified')return original;
  const balanced=recipe.inputs.every(x=>delta(x.itemId!)===-x.quantity*task.batch!)
    &&(recipe.tools??[]).every(x=>delta(x.itemId!)===0)
    &&delta(task.itemId)===task.quantity;
  return balanced?yes(`Recipe ${recipe.id}: exact input/output batch ${task.batch}, reusable tools retained.`)
    :unknown('Source recipe output and consumed quantities not yet jointly verified; no success inferred from XP alone.');
}
