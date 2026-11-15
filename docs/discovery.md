# Community server discovery API

Use `GET /manager/api/public/v1/server` on the same HTTPS origin as the
Manager and game WebSocket. This route requires no account, cookies or service
keys. It reports only instance metadata and aggregate counts.

Example response while the game is stopped:

```json
{
  "schema": 1,
  "service": "HeavyMP",
  "edition": "community",
  "id": "community",
  "name": "HeavyMP Community Server",
  "status": "stopped",
  "online": false,
  "serverVersion": "1.0.0",
  "gameVersion": "1.62.3.3s",
  "protocol": 1,
  "playerCount": 0,
  "maxPlayers": 2000,
  "map": null,
  "connection": {
    "auth": "guest",
    "room": "HeavyMP",
    "transport": "websocket",
    "path": "/heavymp"
  },
  "endpoints": {
    "health": "/health",
    "players": "/players",
    "manifest": "/content/manifest"
  }
}
```

- `status` is one of `stopped`, `starting`, `running`, `stopping` or
  `crashed`. The instance can be saved to a launcher list in any state.
- `map`, when available, contains the active `module` and `revision`. The
  manifest route provides the full content list, which a launcher should
  verify before connecting.
- `connection.auth` is `guest`. The client connects directly with its display
  name and a persistent local identity. Discovery does not transmit credentials.
- All connection paths resolve against the origin the user selected.
  Identify favourites by origin since different communities can use the
  same instance ID. This API doesn't register instances in a central list.

## Example launcher integration

Call the adapter from the launcher's main process with the address the user
entered. For Electron, pass `net.fetch` when using Electron networking.

```js
import {discoverCommunityServer} from './server-discovery.mjs';

const server = await discoverCommunityServer('https://server.example.org');

if (server.online) {
  console.log(server.name, server.gameVersion, server.playerCount);
  console.log(server.websocketUrl, server.endpoints.manifest);
}
```

For a local first run, use `npm run discover -- http://127.0.0.1:30007`.
The adapter accepts HTTP only on loopback for development. It rejects
redirects and builds connection URLs on the selected origin.
