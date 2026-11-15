// Source-tree adapter for tests. The production relay has no static chat import.
import {sendSerialized} from '../shared/protocol.mjs';
import {createServerMessages} from './messages.mjs';
import {createChat as createPlayerChat} from '../../scripts/_shared/player-chat.mjs';
export const createChat=options=>createPlayerChat({...options,messages:createServerMessages(options),sendSerialized});
