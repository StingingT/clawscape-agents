import type { CloseReason } from './runtime.ts';

/** A single interactive panel owns one manager. A real EOF ends that panel;
 * a Herdr client detach does not close its server-owned terminal stream. */
export class PanelLifecycle {
  private task?:Promise<void>;
  private stopping=false;
  private readonly manager:{close:(reason?:CloseReason)=>Promise<void>};
  private readonly beforeClose:()=>void;private readonly afterClose:()=>Promise<void>;
  constructor(manager:{close:(reason?:CloseReason)=>Promise<void>},beforeClose:()=>void,afterClose:()=>Promise<void>){
    this.manager=manager;this.beforeClose=beforeClose;this.afterClose=afterClose;
  }
  get accepting(){return !this.stopping;}
  shutdown(reason:CloseReason):Promise<void> {
    if(this.task)return this.task;
    this.stopping=true;
    // Install the one-shot promise before callbacks can re-enter via readline.close.
    this.task=Promise.resolve().then(async()=>{
      let error:unknown;
      try{this.beforeClose();}catch(e){error=e;}
      try{await this.manager.close(reason);}catch(e){error??=e;}
      try{await this.afterClose();}catch(e){error??=e;}
      if(error)throw error;
    });return this.task;
  }
}
