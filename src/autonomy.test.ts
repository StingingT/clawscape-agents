import { expect, test } from 'bun:test';
import { preferActive, recordAutonomy, progressTimedOut } from './autonomy';

const state = (x = 3200) => ({ player: { worldX: x, worldZ: 3200, level: 0, lifeId: 1, hp: 10 }, inventory: [], equipment: [], skills: [] });

test('map loading cannot reset the five minute progress deadline',()=>{
 const m:any={};recordAutonomy(m,state(),state(),{id:'travel',type:'walkTo'},1000,true);
 recordAutonomy(m,state(),state(),{id:'travel',type:'walkTo'},301000,true);
 expect(progressTimedOut(m,301001)).toBe(true);
});
test('combat XP during wait is verified progress',()=>{
 const m:any={};const after:any={...state(),skills:[{name:'Attack',experience:100,level:2}]};
 expect(recordAutonomy(m,state(),after,{id:'continue-combat',type:'wait'},1000,true).progress).toBe(true);
});

test('productive work is preferred over a stale wait Q-value', () => {
  expect(preferActive([{ id: 'wait', type: 'wait' }, { id: 'travel', type: 'walkTo' }]).map(a => a.id)).toEqual(['travel']);
});

test('a repeated action without state progress becomes a blocker', () => {
  const memory: any = {};
  expect(recordAutonomy(memory, state(), state(), { id: 'training-observe-empty', type: 'wait' }, 1).stalled).toBe(false);
  expect(recordAutonomy(memory, state(), state(), { id: 'training-observe-empty', type: 'wait' }, 2).stalled).toBe(true);
});

test('movement resets the stall count for an exploration action', () => {
  const memory: any = {};
  recordAutonomy(memory, state(), state(), { id: 'autonomy-explore', type: 'walkTo' }, 1);
  expect(recordAutonomy(memory, state(), state(3201), { id: 'autonomy-explore', type: 'walkTo' }, 2).stalled).toBe(false);
  expect(memory.stalled['autonomy-explore'].count).toBe(0);
});

test('map loading is transient work, not a route failure', () => {
  const memory: any = {};
  expect(recordAutonomy(memory, state(), state(), { id: 'travel', type: 'walkTo' }, 1, true).stalled).toBe(false);
  expect(memory.stalled.travel.count).toBe(0);
});

test('a zero-yield resource action is not kept alive by incidental HP changes', () => {
  const memory: any = {};
  const before = state();
  const after = { ...state(), player: { ...state().player, hp: 11 } };
  const action = { id: 'economy-willow-1308-3113-3494', type: 'interactLoc' };
  expect(recordAutonomy(memory, before, after, action, 1).stalled).toBe(false);
  expect(recordAutonomy(memory, before, after, action, 2).stalled).toBe(true);
});

test('an alternating preparation cycle is blocked even when each transfer changes local state', () => {
  const memory: any = {};
  const deposited = { ...state(), inventory: [{ id: 1, count: 1 }] };
  recordAutonomy(memory, state(), state(), { id: 'open-bank', type: 'interactNpc' }, 1, false, 'goal-production', false);
  recordAutonomy(memory, state(), deposited, { id: 'deposit-cargo', type: 'bankDeposit' }, 2, false, 'goal-production', false);
  recordAutonomy(memory, state(), state(), { id: 'open-bank', type: 'interactNpc' }, 3, false, 'goal-production', false);
  expect(recordAutonomy(memory, state(), deposited, { id: 'deposit-cargo', type: 'bankDeposit' }, 4, false, 'goal-production', false).stalled).toBe(true);
});

test('changing goals clears the old action-cycle evidence', () => {
  const memory: any = {};
  recordAutonomy(memory, state(), state(), { id: 'open-bank', type: 'interactNpc' }, 1, false, 'old-goal', false);
  recordAutonomy(memory, state(), state(), { id: 'open-bank', type: 'interactNpc' }, 2, false, 'old-goal', false);
  expect(recordAutonomy(memory, state(), state(), { id: 'open-bank', type: 'interactNpc' }, 3, false, 'new-goal', false).stalled).toBe(false);
});
