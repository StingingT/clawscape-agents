// No game connection or character actions. The DB contains no account tokens.
import { PeerMarket } from '../src/economy/market';
import { loadGearCatalog } from '../src/goals/catalog';
import { resolve } from 'node:path';
const market=new PeerMarket(resolve(import.meta.dir,'../data/shared/market.sqlite'),'observer',loadGearCatalog());
console.log(JSON.stringify(market.overview(),null,2));market.close();
