# Deployment examples

These examples deploy the current OVS application, including room and playback features.
The [design](../specs/DESIGN.md) keeps playback in memory and stores persistent metadata in `/data`.

## Direct HTTP

Build the image with `make image`. Start the Compose application from the repository root:

```bash
docker compose -f deploy/compose.yaml up -d --wait
```

The default publication is `127.0.0.1:8080`. The named volume preserves `/data` across container replacement.
The application runs without root privileges and with a read-only root filesystem.
Use `docker compose -f deploy/compose.yaml down` to stop and remove containers. Keep the named volume for persistence.

Compose passes `OVS_PUBLIC_ORIGIN`, `OVS_LOG_LEVEL`, and `OVS_TRUSTED_PROXIES` to the application.
`OVS_BIND_ADDR` is Compose-only: it selects the host address for the published port, and OVS never reads it.
For LAN access, set `OVS_BIND_ADDR` to the host's LAN interface address. Set `OVS_PUBLIC_ORIGIN` to the matching reachable browser origin.
Direct HTTP requires no certificate provisioning. HTTP does not provide transport confidentiality.

## Caddy on the host

Keep the OVS publication on loopback (the default `OVS_BIND_ADDR=127.0.0.1`). Set `OVS_PUBLIC_ORIGIN=https://watch.example.com` before starting Compose.
Merge [Caddyfile.host.example](Caddyfile.host.example) into the operator's Caddy configuration.
Use the actual domain. Configure DNS and allow the network access required by that Caddy installation.
Reload the existing Caddy service with its normal operator command. Set the trusted proxy as described [below](#trusted-proxy-addresses).

## Caddy in another container

Run Caddy separately on a private network shared only with OVS. Give Caddy a static address outside the network's dynamic range, so no other container can receive it:

```bash
docker network create --subnet 172.30.0.0/24 --ip-range 172.30.0.128/25 ovs-proxy
docker run -d --name caddy --network ovs-proxy --ip 172.30.0.2 -p 80:80 -p 443:443 \
  -v "$PWD/deploy/Caddyfile.container.example:/etc/caddy/Caddyfile:ro" \
  -v caddy-data:/data -v caddy-config:/config caddy:2
OVS_PUBLIC_ORIGIN=https://watch.example.com OVS_TRUSTED_PROXIES=172.30.0.2/32 \
  docker compose -f deploy/compose.yaml -f deploy/compose.caddy.yaml up -d --wait
```

Edit a copy of [Caddyfile.container.example](Caddyfile.container.example) with the actual domain before mounting it.
The [overlay](compose.caddy.yaml) removes the OVS host port and attaches OVS to `ovs-proxy`, where Caddy reaches it as `ovs:8080`. It needs Compose 2.24 or later.
Give Caddy separate certificate/configuration volumes. Mount the application `/data` volume only into OVS.

## Existing Caddy

Add the appropriate site block to the existing installation. Preserve global settings and unrelated sites.
Do not install another Caddy instance or manage certificates inside OVS.
Do not enable request-body logging in the application or proxy.

Give each OVS instance its own host name. Browsers share cookies across ports of one host, so two instances on one host name (for example HTTP on one port and HTTPS on another) overwrite each other's session cookie.

## Trusted proxy addresses

OVS limits session bootstrap, room creation, and invitation redemption per client address.
Behind a proxy, every request arrives from the proxy. Without `OVS_TRUSTED_PROXIES`, all clients share the proxy's limits.
With it, OVS reads `X-Forwarded-For` only from the listed peers and uses the rightmost address that is not a trusted proxy.

| Topology | Publication | `OVS_TRUSTED_PROXIES` |
| --- | --- | --- |
| Binary on the host behind host Caddy | `OVS_LISTEN_ADDR=127.0.0.1:8080` | `127.0.0.1/32,::1/128` |
| Compose behind host Caddy | Default loopback `OVS_BIND_ADDR` | The Compose network gateway as `/32` |
| Caddy in another container | No host port (`compose.caddy.yaml`) | Caddy's static address, such as `172.30.0.2/32` |

For Compose behind host Caddy, start once, read the gateway, then set it and start again:

```bash
docker compose -f deploy/compose.yaml up -d --wait
docker network inspect deploy_default --format '{{(index .IPAM.Config 0).Gateway}}'
OVS_TRUSTED_PROXIES=<gateway>/32 docker compose -f deploy/compose.yaml up -d --wait
```

The network is recreated after `down`; check the gateway again after that.
Connections to a published loopback port reach the container from that gateway, so trust it only when the port is not published on another interface.

- Trust only proxy addresses that clients cannot reach directly. Never set trust while OVS is published on a LAN or public interface.
- Caddy replaces a client-supplied `X-Forwarded-For` by default. If Caddy itself sits behind a CDN with Caddy `trusted_proxies`, add the CDN ranges to `OVS_TRUSTED_PROXIES` too.
- A wrong or stale value fails safe: clients share the proxy's limits again. It never lets a client choose its own address.

## Proxy reloads

A Caddy reload closes open WebSocket connections. Browsers reconnect automatically and keep their room, epoch, and selected media.
If every connection in a room closed, the room pauses. Any allowed controller can select **Play together** again.

## Operations and validation

The container health check invokes `/ovs healthcheck`. Allow more than ten seconds for graceful termination; Compose allows fifteen seconds.
Before you copy `/data`, stop OVS and follow the stopped-directory copy note in the [root README](../README.md#deploy-and-operate).
Preserve `/data` across upgrades and use a binary compatible with its schema. Playback restarts paused at zero.
Development installations upgrading from application protocol v1 need the [legacy invitation transition](../specs/development-upgrade.md). OVS has no backup/restore command or automated downgrade workflow.

`make image-smoke` checks fresh non-root startup, read-only operation, route boundaries, exclusive ownership, clean shutdown, and container replacement with one volume.
`make proxy-smoke` runs `compose.yaml` with `compose.caddy.yaml` behind `caddy:2` and a local certificate authority.
It checks HTTPS pages, the `Secure` cookie, the helper scope, trusted-proxy client addresses, a same-epoch socket reconnect after `caddy reload --force`, and a clean stop.
Both checks retain sanitized evidence under ignored `.misc/` and remove their containers, networks, and volumes.
Certificate issuance and DNS belong to the operator's Caddy installation.
Release acceptance ran Chrome and Firefox journeys over direct LAN HTTP and through a host Caddy with a local certificate authority. That Caddy proxied to the Compose behind host Caddy setup above, with the Compose gateway as the trusted `/32`.
The journeys included live Bilibili with danmaku and room socket reconnects after `caddy reload`. An existing Caddy installation uses the same site block, but it was not tested separately.
