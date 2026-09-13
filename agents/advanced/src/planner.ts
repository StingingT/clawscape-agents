import { Goal, type Observation } from "./contracts.ts";

export function predicateMet(p: Goal["success_predicates"][number], o: Observation): boolean {
  switch (p.kind) {
    case "skill_at_least": return (o.skills.find(s => s.name === p.skill)?.base ?? -1) >= p.value;
    case "inventory_at_least": return o.inventory.filter(i => i.id === p.item_id).reduce((n,i) => n + i.count, 0) >= p.value;
    case "free_slots_at_least": return o.capacity !== null && o.capacity - o.inventory.length >= p.value;
    case "at_tile": return JSON.stringify(o.position) === JSON.stringify(p.tile);
  }
}
export function validateGraph(goals: Goal[]): void {
  const byId = new Map(goals.map(g => [g.goal_id, g]));
  if (byId.size !== goals.length) throw new Error("DUPLICATE_GOAL");
  const visit = (id: string, path: Set<string>) => {
    if (path.has(id)) throw new Error("CYCLIC_PREREQUISITES");
    const goal = byId.get(id);
    if (!goal) throw new Error("MISSING_PREREQUISITE");
    for (const parent of goal.prerequisites) visit(parent, new Set([...path, id]));
  };
  for (const goal of goals) visit(goal.goal_id, new Set());
}
export function feasibleGoals(raw: unknown[], o: Observation, methods: Set<string>, budgetGp: number) {
  const goals = raw.map(g => Goal.parse(g));
  validateGraph(goals);
  const complete = (id: string) => goals.find(g => g.goal_id === id)!.success_predicates.every(p => predicateMet(p, o));
  return goals.filter(g => g.profile_id === o.profile_id && !complete(g.goal_id)
    && g.prerequisites.every(complete) && g.resource_budget <= budgetGp
    && g.candidate_methods.some(m => methods.has(m)));
}
/** Goal generation consumes catalog identifiers, never guessed game IDs. */
export function proposeGoals(o: Observation, catalog: { food_id: number; food_target: number; training_skill: string; training_cap?: number; methods: string[] }): Goal[] {
  if (o.capacity === null || o.unavailable.includes("inventory") || !o.connected) return [];
  const make = (suffix: string, description: string, priority: number, predicate: Goal["success_predicates"][number], method: string) => Goal.parse({
    schema_version: "1.0", goal_id: "goal:" + suffix, objective_id: "self-sufficient-pve-v1",
    description, profile_id: o.profile_id, priority, prerequisites: [], candidate_methods: [method],
    selected_method: null, resource_budget: 0, success_predicates: [predicate],
    abort_conditions: ["STALE_STATE", "UNEXPECTED_DAMAGE", "NO_PROGRESS"],
    evidence_refs: ["snapshot:" + o.seq], status: "PROPOSED", rationale: description,
  });
  const cap=Math.min(99,catalog.training_cap??99);
  if(!Number.isInteger(cap)||cap<1)throw new Error('INVALID_TRAINING_CAP');
  const goals = [
    make("bank", "Free working inventory while protecting supplies", 100, { kind: "free_slots_at_least", value: 4 }, "bank"),
    make("food", "Maintain supplies for a supported trip", 80, { kind: "inventory_at_least", item_id: catalog.food_id, value: catalog.food_target }, "supply"),
    make("train", "Reach next supported combat level", 40, { kind: "skill_at_least", skill: catalog.training_skill,
      value: Math.min(cap,(o.skills.find(s => s.name === catalog.training_skill)?.base ?? 1) + 1) }, "train"),
  ];
  goals[2]!.prerequisites = ["goal:food","goal:bank"];
  const allowed = new Set(catalog.methods);
  if (!o.skills.some(s => s.name === catalog.training_skill)) allowed.delete("train");
  // Capped XP is not additional combat capability. Supplies/equipment remain
  // useful; reaching a cap neither retires a skill nor invents a new discipline.
  return feasibleGoals(goals, o, allowed, 0).sort((a,b) => b.priority - a.priority);
}
