export function actionReady(failure: {count?:number;until?:number}|undefined, now=Date.now()):boolean {
  return (failure?.until??0)<=now;
}
