// Adapter for source-tree tools and tests. The game loads its module from scripts/.
import {WebSocket,WebSocketServer} from 'ws';
import {send} from '../shared/protocol.mjs';
import {createPhoneHub as createHub} from '../../scripts/phone/phone-hub.mjs';
export const createPhoneHub=options=>createHub({...options,send,WebSocket,WebSocketServer});
