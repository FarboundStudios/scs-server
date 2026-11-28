# Run the HeavyMP server on Linux with Docker

The image provides Node.js 22 with SQLite support and installs the locked production dependencies. The Server Manager and game processes run as the image’s non-root `node` user.

## Build and start

Run these commands from the server repository. Replace `YOUR_STEAM_ID64` with the owner’s SteamID64.

```sh
docker build -t heavymp-server .
docker volume create heavymp-data
docker run -d --name heavymp --restart unless-stopped --stop-timeout 30 \
  --mount source=heavymp-data,target=/var/lib/heavymp \
  -p 127.0.0.1:30007-30012:30007-30012/tcp \
  -e MANAGER_ADMIN_STEAM_IDS=YOUR_STEAM_ID64 \
  -e MANAGER_PUBLIC_URL=http://127.0.0.1:30007 \
  heavymp-server
```

Open `http://127.0.0.1:30007/manager/` on the Linux host. Sign in through Steam and use **Instances** to import a full server pack or create a server. Start the desired game instance from the Manager. The container starts the Manager with the games stopped.

The example publishes the primary port and five additional ports to the host’s loopback interface. If you create an instance outside this range, publish its port too. A remote deployment needs an HTTPS reverse proxy that forwards WebSocket upgrades and permits large pack uploads and downloads. Set `MANAGER_PUBLIC_URL` to the HTTPS origin users open for the primary Manager. Set the matching **Public HTTPS origin** on each additional instance.

## Data and updates

The named volume contains the writable `data`, `addons`, `logs`, and `scripts` directories and the Manager’s `.env` file. Each additional instance has its own directory under `data/instances`. A bind mount can replace the named volume when its directory is writable by UID/GID 1000.

Build a new image from the updated repository, stop and replace the container, and attach the same volume. Keep a separate volume backup if you need host configuration and logs. Server packs are portable instance backups and can be imported directly from the **Instances** page of another Manager.

```sh
docker logs -f heavymp
docker stop heavymp
```
