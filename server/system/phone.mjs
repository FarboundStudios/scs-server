// Adapter for source-tree tools and tests. The game loads its module from scripts/.
import {send} from '../shared/protocol.mjs';
import {createPhoneNetwork as createNetwork} from '../../scripts/phone/phone.mjs';
export const createPhoneNetwork=options=>createNetwork({...options,send});
