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

## Deploy behind aaPanel on a Hostinger VPS

1. Point a DNS `A` record for your server subdomain at the VPS IPv4 address. Allow inbound TCP 80 and 443 in the active Hostinger and host firewalls. Keep Docker’s published ports on `127.0.0.1` so aaPanel’s Nginx handles public traffic. See [Hostinger’s firewall guide](https://www.hostinger.com/support/8172641-how-to-use-a-managed-vps-firewall-at-hostinger/).
2. Install or enable Docker in aaPanel. In **Terminal** or over SSH, run the build and start commands above from the server repository. Set `MANAGER_ADMIN_STEAM_IDS` to your SteamID64. Replace the loopback `MANAGER_PUBLIC_URL` line with these three lines, using your own hostname.

   ```sh
   -e MANAGER_PUBLIC_URL=https://mp.example.com \
   -e PUBLIC_HOST=mp.example.com \
   -e PUBLIC_PORT=443 \
   ```

   Verify that `curl -fsS http://127.0.0.1:30007/manager/api/public/v1/server` returns JSON on the VPS. For a fresh installation, the game status will be `stopped`.
3. In aaPanel, go to **Website → Proxy Project → Add proxy**. Create a default project for `mp.example.com` with target `http://127.0.0.1:30007`. Keep the original request path, enable **WebSocket** and issue a certificate in **SSL**. The root proxy forwards the Manager, public discovery, game WebSocket, and content downloads. See [aaPanel’s proxy guide](https://www.aapanel.com/docs/Function/proxy.html).
4. For a large server pack, open the root proxy’s custom Nginx configuration and set the upload limit above your pack size. This example allows requests up to 20 GiB and streams uploads and downloads without proxy buffering. Set the root proxy to use HTTP/1.1 upstream, which is also needed for WebSocket upgrades. Update existing directives in the same block if aaPanel has already set them. Make sure the VPS has room for both the uploaded pack and the extracted files. See [Nginx’s proxy documentation](https://nginx.org/en/docs/http/ngx_http_proxy_module.html).

   ```nginx
   client_max_body_size 20g;
   proxy_request_buffering off;
   proxy_buffering off;
   ```

5. Open `https://mp.example.com/manager/` and sign in with the configured Steam account. To move an existing server, use **Instances → Import server pack** and enter its own public HTTPS origin in the import dialog. The Instances list shows the port assigned to the imported server. Repeat the proxy setup with that server’s hostname and assigned port, then start the imported instance. Test its public discovery URL over HTTPS, then add the instance’s HTTPS origin to the HeavyMP Launcher.

## Data and updates

The named volume contains the writable `data`, `addons`, `logs`, and `scripts` directories and the Manager’s `.env` file. Each additional instance has its own directory under `data/instances`. A bind mount can replace the named volume when its directory is writable by UID/GID 1000.

Build a new image from the updated repository, stop and replace the container, and attach the same volume. Keep a separate volume backup if you need host configuration and logs. Server packs are portable instance backups and can be imported directly from the **Instances** page of another Manager.

```sh
docker logs -f heavymp
docker stop heavymp
```
