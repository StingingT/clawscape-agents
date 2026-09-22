/** Bound noisy unchanged planner reports without hiding a state transition.
 * This is observability only: it has no authority over planning or dispatch. */
export class StatusReporter {
  private last?:{key:string;at:number};
  constructor(private readonly intervalMs=60_000) {}
  shouldReport(key:string,now=Date.now()):boolean {
    if(!this.last||this.last.key!==key||now-this.last.at>=this.intervalMs){
      this.last={key,at:now};return true;
    }
    return false;
  }
}
