# Deployment

This directory contains the OVS application image build and deployment examples.
The [design](../specs/DESIGN.md) keeps playback in memory and stores persistent metadata in `/data`.

The [Dockerfile](Dockerfile) builds all three modules using the repository root as its build context.
[Dockerfile.dockerignore](Dockerfile.dockerignore) defines the files included in that context.
`make image`, `make deploy`, and the Compose example select this Dockerfile automatically.

## Remote deployment

Run these commands from the repository root on the development machine:

```bash
make deploy HOST=ovs-prod URL=https://203.0.113.10
make deploy HOST=ovs-prod
make deploy-status HOST=ovs-prod
make deploy-logs HOST=ovs-prod
make deploy-restart HOST=ovs-prod
make deploy-stop HOST=ovs-prod
```

Replace the documentation IP with a real public address. `HOST` is an SSH config
alias or `user@host`. Use SSH config for keys, ports, and jump hosts. Deployment
uses noninteractive SSH authentication and preserves host-key checks; establish
the trusted SSH connection before deploying. No SSH password is stored.

The local machine needs Go, Node, Make, Docker 28 or later with Buildx, and OpenSSH. The remote
machine needs Linux amd64 or arm64, Docker Engine and CLI, a normal POSIX login
environment, and permission to use Docker without an interactive sudo prompt.
Docker must run on that remote host: the helper checks host ports and mounts
configuration from its filesystem. Rootless Docker must support the chosen
published ports. The tool does not install Docker or change host firewall rules.

The command detects the remote CPU architecture, builds the application locally,
and streams the image through SSH to `docker image load`. Managed HTTPS also
transfers the pinned Caddy image. The remote machine does not need a registry
account, Git, Go, Node, curl, or access to GitHub or Docker Hub. The local machine
needs access to build dependencies, images, and Compose release downloads.

Deployment uses the same default `IMAGE` as `make image`. On the checked-out `main`
branch, a valid `vYYYY-MM-DD` release tag pointing directly at `HEAD` selects
`ovs:vYYYY-MM-DD`. Otherwise, the image is `ovs:dev`, including detached HEAD and
checkouts without Git metadata. Dates must be valid calendar dates. If several
release tags point at `HEAD`, the newest date wins.
Set `IMAGE=my-ovs:testing` to build, transfer, and run a custom tag.

Deployment shows numbered steps, completion or failure, elapsed time, and remote
substeps through configuration validation, container replacement, and health checks.
Compose downloads and helper/Compose uploads show percentage bars when their size
is known. The streamed image archive has no known total: its activity bar shows
local bytes read, average throughput, and elapsed time. Transfer completion also
waits for the remote image load to succeed; it does not replace image verification.
No image archive is stored locally for progress reporting.

Progress uses stderr. Interactive terminals show live bars and colored status;
`NO_COLOR=1 make deploy HOST=ovs-prod` disables color. Redirected output and
`TERM=dumb` use plain text, with transfer updates every ten seconds and on completion.
Status, restart, stop, and logs commands also show their preparation steps.

Compatible Compose installations (2.24 or later, including newer major versions)
are reused. If Compose is missing, the tool downloads version 5.6.1 locally,
checks its official SHA-256 checksum, and installs the remote user CLI plugin.
An existing incompatible plugin is preserved; a deployment-local executable is
used instead. Automatically installed versions are fixed and do not self-update.
Caddy uses `caddy:2.11.7-alpine`. Update these pins with deployment validation.

### Configuration

| Make variable     | Default                                                 | Meaning                                                                        |
| ----------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `HOST`            | Required                                                | SSH destination                                                                |
| `URL`             | Saved value                                             | Public origin; required for the first deployment                               |
| `IMAGE`           | `ovs:vYYYY-MM-DD` on tagged `main`; otherwise `ovs:dev` | Application image tag built locally and used remotely                          |
| `DEPLOY_DIR`      | Remote `~/.local/share/ovs`                             | Absolute remote configuration directory                                        |
| `PROXY`           | Saved value, initially `auto`                           | `auto` selects direct HTTP or managed HTTPS; `external` uses an existing proxy |
| `PROXY_NETWORK`   | Saved value                                             | Existing Docker network for an external container proxy                        |
| `TRUSTED_PROXIES` | Saved value                                             | Trusted proxy CIDRs; required for an external container proxy                  |
| `PROXY_SUBNET`    | Saved value, initially `172.30.0.0/24`                  | Dedicated private IPv4 /24; select another range if it overlaps                |

Saved connection and proxy settings are reused when a variable is omitted. `IMAGE`
uses the current local branch and exact release tag or an explicit override on each deployment.
Explicitly passing a new `URL` changes the public origin. Choose the final origin before inviting people:
an origin change affects browser identities, invitation links, and the helper's
installation scope. Returning to `PROXY=auto` clears external network/trust settings.

Direct HTTP publishes the URL port (80 if omitted). Managed HTTPS requires port
443 and publishes TCP 80/443 through Caddy only. OVS has no host port in this mode.
Both public IPv4 and IPv6 origins are supported, subject to host Docker networking
and public reachability. Caddy uses a fixed address outside the Docker network's
dynamic allocation range; OVS trusts only that address.

For a public IP, Caddy explicitly uses Let's Encrypt's `shortlived` ACME profile
and a default server name for IP clients without SNI. These certificates last
160 hours. Caddy renews them on the remote server without the development machine.
Private IPs are rejected for automatic public certificates. Domain origins use
Caddy's normal automatic HTTPS. Certbot is not needed.

The CA must reach a validation endpoint: HTTP-01 uses TCP 80 and TLS-ALPN-01 uses
TCP 443. DNS-01 cannot validate IP addresses. Mainland China servers have the same
technical requirements; test outbound ACME and inbound validation reachability
on the actual server. A certificate request is not a substitute for cloud security
group or provider network configuration.

### Existing proxies

For an existing host proxy:

```bash
make deploy HOST=ovs-prod URL=https://watch.example.com PROXY=external
```

OVS publishes `127.0.0.1:8080`. Add `reverse_proxy 127.0.0.1:8080` to the existing
Caddy site yourself. The deployment tool derives the trusted Compose gateway when
no explicit CIDRs are supplied. It does not edit or reload an existing proxy.
The public verification step succeeds after the existing proxy is configured.

For an existing container proxy, create its private network and fixed proxy
address first, then supply both values:

```bash
make deploy HOST=ovs-prod URL=https://watch.example.com PROXY=external \
  PROXY_NETWORK=existing-proxy TRUSTED_PROXIES=172.31.0.2/32
```

Configure that proxy to reach `ovs:8080` on the shared network. OVS publishes no
host port in this mode. Existing services on ports 80/443 are not stopped or
reconfigured. Select external mode when those ports already belong to a proxy.

### State and failure handling

The Compose project is always `ovs`. An ownership volume records the canonical
deployment directory. Changing `DEPLOY_DIR` cannot silently start another database.
Managed volumes are `ovs-managed-data`, `ovs-managed-caddy-data`, and
`ovs-managed-caddy-config`; the ownership marker is `ovs-managed-owner`. Do not
delete these volumes during normal operations. No command prunes application data.

The remote directory contains versioned configurations, helper binaries, an
operation lock, `active.json`, and `successful.json`. `active.json` identifies the
last activated attempt, including a failed startup. `successful.json` identifies
the last deployment that passed public checks. A retry uses active settings so
operators can diagnose and repair the attempted release. Configuration and image
preparation failures leave the running application unchanged.

The tool verifies execution configuration and layer digests after transfer, then
records the remote image IDs. This supports both
classic and containerd Docker image stores, whose image IDs can differ. Once
images and configurations are valid, OVS stops before the replacement starts.
Startup or schema initialization failures preserve the data and report an error. There is no
automatic image downgrade, database rollback, or backup command. Rebuilding the
same tag replaces its image reference. Release configurations and recorded image
IDs remain available for diagnosis; remove obsolete images manually only after
checking that no deployment uses them.

The tool waits up to five minutes for public readiness and UI checks. HTTPS must
pass normal trust-chain, host, and expiry validation; redirects are not accepted.
A public-check timeout returns an error while leaving containers running so Caddy
can retry certificate acquisition. Check `deploy-logs`, fix network/configuration
problems, then use `deploy-status` or deploy again.

`deploy-status` reports the release, image ID, running version, container health,
public reachability, and certificate expiration. `deploy-logs` follows the last
100 lines. `deploy-restart` restarts only OVS, without rebuilding. `deploy-stop`
stops the managed services without deleting volumes. Deploy again to start the
whole stack after stopping it.

Manual Compose installations are not automatically migrated. Stop the old
installation, preserve a stopped copy of its entire data directory, and explicitly
plan the volume transfer before switching tools. Do not delete the old volume to
silence an ownership conflict. The original manual recipes below remain supported.

### Remote deployment validation

`make deploy-smoke` uses a disposable SSH server and a privileged, isolated Docker
daemon. It never mounts the host Docker socket into the fixture. Prepare the OVS
image with `make image` and pull `caddy:2.11.7-alpine` first. The test requires SSH
client tools and network access for fixture and Compose downloads. It checks
Compose bootstrap, image transfer, updates, data preservation, failed preparation,
stop/restart, and IP HTTPS/WebSocket with a test CA. Test CA injection exists only
in the test executable, not the deployment command. Evidence is retained under
`.misc/deploy-smoke`; fixture containers, volumes, and synthetic private keys are
removed after the test.

The local fixture does not verify public CA issuance or renewal. Those checks
require a real public server and remain a separate acceptance step.

## Direct HTTP

Build the image with `make image`. Start the Compose application from the repository root:

```bash
export IMAGE="ovs:$(node scripts/versions.mjs image-tag)"
docker compose -f deploy/compose.yaml up -d --wait
```

Compose requires `IMAGE` in the shell environment for all manual recipes below.
The export command selects the release tag on tagged `main` or `dev`, matching the default tag from `make image`.
Export `IMAGE` again in a new shell or after changing branches, commits, or tags. For a custom image name, export that name before `make image`.

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

| Topology                             | Publication                         | `OVS_TRUSTED_PROXIES`                           |
| ------------------------------------ | ----------------------------------- | ----------------------------------------------- |
| Binary on the host behind host Caddy | `OVS_LISTEN_ADDR=127.0.0.1:8080`    | `127.0.0.1/32,::1/128`                          |
| Compose behind host Caddy            | Default loopback `OVS_BIND_ADDR`    | The Compose network gateway as `/32`            |
| Caddy in another container           | No host port (`compose.caddy.yaml`) | Caddy's static address, such as `172.30.0.2/32` |

For Compose behind host Caddy, start once, read the gateway, then set it and start again:

```bash
docker compose -f deploy/compose.yaml up -d --wait
docker network inspect deploy_default --format '{{(index .IPAM.Config 0).Gateway}}'
OVS_TRUSTED_PROXIES= < gateway > /32 docker compose -f deploy/compose.yaml up -d --wait
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
Before you copy `/data`, stop OVS and follow the stopped-directory copy note in the [root README](../README.md#configuration-and-data).
Preserve `/data` across upgrades and use a binary compatible with its schema. Playback restarts paused at zero.
OVS has no backup/restore command or automated downgrade workflow.

`make image-smoke` checks fresh non-root startup, read-only operation, route boundaries, exclusive ownership, clean shutdown, and container replacement with one volume.
`make proxy-smoke` runs `compose.yaml` with `compose.caddy.yaml` behind `caddy:2` and a local certificate authority.
It checks HTTPS pages, the `Secure` cookie, the helper scope, trusted-proxy client addresses, a same-epoch socket reconnect after `caddy reload --force`, and a clean stop.
Both checks retain sanitized evidence under ignored `.misc/` and remove their containers, networks, and volumes.
Certificate issuance and DNS belong to the operator's Caddy installation.
Release acceptance ran Chrome and Firefox journeys over direct LAN HTTP and through a host Caddy with a local certificate authority. That Caddy proxied to the Compose behind host Caddy setup above, with the Compose gateway as the trusted `/32`.
The journeys included live Bilibili with danmaku and room socket reconnects after `caddy reload`. An existing Caddy installation uses the same site block, but it was not tested separately.
