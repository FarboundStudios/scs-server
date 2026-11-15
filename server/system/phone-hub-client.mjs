// Adapter for source-tree tools and tests. The game loads its module from scripts/.
import WebSocket from 'ws';
import {send} from '../shared/protocol.mjs';
import {createPhoneHubClient as createClient} from '../../scripts/phone/phone-hub-client.mjs';
export {phoneHubConfig} from '../../scripts/phone/phone-hub-client.mjs';
export const createPhoneHubClient=options=>createClient({...options,send,WebSocket});
