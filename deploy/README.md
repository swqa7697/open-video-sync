# Deployment examples

These examples deploy the development template. They do not enable room or playback features.

## Direct HTTP

Build the image with `make image`. Start the Compose application from the repository root:

```bash
docker compose -f deploy/compose.yaml up -d --wait
```

The default publication is `127.0.0.1:8080`. The named volume preserves `/data` across container replacement.
The application runs without root privileges and with a read-only root filesystem.
Use `docker compose -f deploy/compose.yaml down` to stop and remove containers. Keep the named volume for persistence.

For LAN access, set `OVS_BIND_ADDR` to the host's LAN interface address. Set `OVS_PUBLIC_ORIGIN` to the matching reachable browser origin.
Direct HTTP requires no certificate provisioning. HTTP does not provide transport confidentiality.

## Caddy on the host

Keep the OVS publication on loopback. Set `OVS_PUBLIC_ORIGIN=https://watch.example.com` before starting Compose.
Merge [Caddyfile.host.example](Caddyfile.host.example) into the operator's Caddy configuration.
Use the actual domain. Configure DNS and allow the network access required by that Caddy installation.
Reload the existing Caddy service with its normal operator command.

## Caddy in another container

Run Caddy separately and connect Caddy and OVS to the same private Docker network.
Remove the OVS `ports` publication when Caddy is the only public entry point.
Use `reverse_proxy ovs:8080`, as shown in [Caddyfile.container.example](Caddyfile.container.example).
Set the OVS public origin to the HTTPS domain. Give Caddy separate certificate/configuration volumes.
Mount the application `/data` volume only into OVS.

## Existing Caddy

Add the appropriate site block to the existing installation. Preserve global settings and unrelated sites.
Do not install another Caddy instance or manage certificates inside OVS.
The template ignores forwarding headers. Future client-address features need an explicit proxy trust configuration.
Do not enable request-body logging in the application or proxy.

## Operations and validation

The container health check invokes `/ovs healthcheck`. Allow more than ten seconds for graceful termination; Compose allows fifteen seconds.
Use the stopped-directory backup procedure in the [root README](../README.md#storage-and-deployment).
Back up before a schema upgrade. Preserve the image and backup needed for a downgrade.

`make image-smoke` checks fresh non-root startup, read-only operation, route boundaries, exclusive ownership, clean shutdown, and container replacement with one volume.
The smoke check retains isolated database copies under ignored `.misc/image-smoke/` and removes its containers and volume.
Live DNS, certificate issuance, HTTPS journeys, and the Caddy arrangements above have not been validated.
