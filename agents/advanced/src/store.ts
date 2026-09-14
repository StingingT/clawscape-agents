import { Database } from "bun:sqlite";
import type { ActionCommand, ActionResult } from "./contracts.ts";

/** One private SQLite database per character/world; no game-save access. */
export class Store {
  readonly db: Database;
  constructor(path: string) {
    this.db = new Database(path, { create: true });
    this.db.run("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=3000");
    this.db.run([
      "CREATE TABLE IF NOT EXISTS records(seq INTEGER PRIMARY KEY AUTOINCREMENT,",
      "kind TEXT NOT NULL,id TEXT NOT NULL,at INTEGER NOT NULL,body TEXT NOT NULL,UNIQUE(kind,id));",
      "CREATE TABLE IF NOT EXISTS actions(id TEXT PRIMARY KEY,command TEXT NOT NULL,result TEXT NOT NULL);",
      "CREATE TABLE IF NOT EXISTS control(singleton INTEGER PRIMARY KEY CHECK(singleton=1),",
      "mode TEXT NOT NULL,lease TEXT,owner TEXT,expires INTEGER NOT NULL,disabled INTEGER NOT NULL);",
      "INSERT OR IGNORE INTO control VALUES(1,'STOPPED',NULL,NULL,0,0);",
    ].join(" "));
  }
  append(kind: string, id: string, body: unknown): boolean {
    return this.db.query("INSERT OR IGNORE INTO records(kind,id,at,body) VALUES(?,?,?,?)")
      .run(kind, id, Date.now(), JSON.stringify(body)).changes === 1;
  }
  records<T>(kind: string): T[] {
    return this.db.query("SELECT body FROM records WHERE kind=? ORDER BY seq")
      .all(kind).map(row => JSON.parse((row as { body: string }).body) as T);
  }
  action(id: string): { command: ActionCommand; result: ActionResult } | null {
    const row = this.db.query("SELECT command,result FROM actions WHERE id=?")
      .get(id) as { command: string; result: string } | null;
    return row ? { command: JSON.parse(row.command), result: JSON.parse(row.result) } : null;
  }
  allActions(): { command: ActionCommand; result: ActionResult }[] {
    return (this.db.query("SELECT command,result FROM actions").all() as { command: string; result: string }[])
      .map(r => ({ command: JSON.parse(r.command) as ActionCommand, result: JSON.parse(r.result) as ActionResult }))
      ;
  }
  unsettled(): { command: ActionCommand; result: ActionResult }[] {
    return this.allActions().filter(({result:r})=>!((r.status==='SUCCEEDED'&&r.evidence.length>0)||r.status==='REJECTED'||r.status==='EXPIRED'
      ||r.status==='CANCELLED'&&!/MAY_STILL|OUTCOME_UNKNOWN|PREEMPTED/.test(r.reason)));
  }
  pending(): { command: ActionCommand; result: ActionResult }[] {
    return this.allActions().filter(r => ["QUEUED", "RUNNING"].includes(r.result.status));
  }
  createAction(command: ActionCommand, result: ActionResult): void {
    if (this.pending().length) throw new Error("RECONCILE_PENDING");
    this.db.query("INSERT INTO actions VALUES(?,?,?)").run(command.action_id, JSON.stringify(command), JSON.stringify(result));
    this.append("actions", command.action_id + ":QUEUED", { command, result });
  }
  result(result: ActionResult): void {
    this.db.query("UPDATE actions SET result=? WHERE id=?").run(JSON.stringify(result), result.action_id);
    this.append("actions", result.action_id + ":" + result.status + ":" + result.reason, result);
  }
  control() {
    return this.db.query("SELECT * FROM control").get() as {
      mode: string; lease: string | null; owner: string | null; expires: number; disabled: number;
    };
  }
  acquire(owner: string, now: number): string {
    return this.db.transaction(() => {
      const c = this.control();
      if (c.disabled) throw new Error("HARD_DISABLED");
      if (c.mode === "MANUAL") throw new Error("MANUAL_TAKEOVER");
      if (c.lease && c.expires > now) throw new Error("CONTROL_OWNED");
      if (this.pending().length) throw new Error("RECONCILE_PENDING_BEFORE_RESTART");
      const lease = crypto.randomUUID();
      this.db.query("UPDATE control SET mode='RUNNING',lease=?,owner=?,expires=?")
        .run(lease, owner, now + 5000);
      this.append("events", crypto.randomUUID(), { kind: "CONTROL_ACQUIRED", owner, at: now });
      return lease;
    }).immediate();
  }
  /** Reconciliation owns the same lease but does NOT authorize game actions. */
  acquireRecovery(owner: string, now: number): string {
    return this.db.transaction(() => {
      const c = this.control();
      if (c.disabled) throw new Error("HARD_DISABLED");
      if (["MANUAL", "PAUSED"].includes(c.mode)) throw new Error("MANUAL_TAKEOVER");
      if (c.lease && c.expires > now) throw new Error("CONTROL_OWNED");
      const lease = crypto.randomUUID();
      this.db.query("UPDATE control SET mode='RECONCILING',lease=?,owner=?,expires=?").run(lease,owner,now+5000);
      return lease;
    }).immediate();
  }
  promoteRecovery(lease: string, now: number): void {
    this.db.transaction(() => {
      const c = this.control();
      if (c.disabled || c.mode !== 'RECONCILING' || c.lease !== lease || c.expires <= now) throw new Error('CONTROL_REVOKED');
      if (this.unsettled().length) throw new Error('RECONCILE_PENDING_BEFORE_RESTART');
      this.db.query("UPDATE control SET mode='RUNNING' WHERE lease=?").run(lease);
    }).immediate();
  }
  renew(lease: string, now: number): void {
    const c = this.control();
    if (c.disabled || !["RUNNING","RECONCILING"].includes(c.mode) || c.lease !== lease || c.expires <= now) throw new Error("CONTROL_REVOKED");
    this.db.query("UPDATE control SET expires=? WHERE lease=?").run(now + 5000, lease);
  }
  setControl(mode: "PAUSED" | "STOPPED" | "MANUAL" | "DISABLED"): void {
    this.db.transaction(() => {
      this.db.query("UPDATE control SET mode=?,lease=NULL,owner=NULL,expires=0,disabled=?")
        .run(mode, mode === "DISABLED" || this.control().disabled ? 1 : 0);
      for (const p of this.pending()) {
        if (p.result.status === "QUEUED") this.result({ ...p.result, status: "CANCELLED", reason: "CONTROL_REVOKED", at: Date.now() });
      }
      this.append("events", crypto.randomUUID(), { kind: mode, at: Date.now() });
    }).immediate();
  }
  releaseManual(): void {
    if (this.control().disabled) throw new Error("HARD_DISABLED");
    this.setControl("STOPPED");
  }
  close() { this.db.close(); }
}
