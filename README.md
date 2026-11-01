# Open Video Sync

Open Video Sync (OVS) is a private, self-hosted app for watching videos together. Each participant supplies their own media; OVS synchronizes playback without uploading, storing, or relaying video.

The initial release is in development. OVS supports:

- Private rooms with reusable invitation links and codes, without registration.
- Synchronized play, pause, and seeking, with optional waiting for everyone.
- Local video files and Bilibili videos with quality selection, episodes, and danmaku.
- Host controls for room settings, media selection, invitations, and participants.
- English and Simplified Chinese, light and dark modes, and browser-local preferences.

Use desktop Chromium or Firefox. Video formats depend on browser and device decoding support.

## Start OVS

Install Docker with Compose, then run from the repository root:

```bash
export IMAGE=ovs:local
docker compose -f deploy/compose.yaml up -d --build --wait
```

Open <http://127.0.0.1:8080>. Application data stays in the `ovs-data` volume across container replacements.

For LAN access, set the server's address and the exact URL participants will open:

```bash
OVS_BIND_ADDR=192.168.1.10 OVS_PUBLIC_ORIGIN=http://192.168.1.10:8080 \
  docker compose -f deploy/compose.yaml up -d --build --wait
```

Replace the example address with your server's address. Direct HTTP works without certificates. For HTTPS or deployment over SSH, follow the [deployment guide](deploy/README.md).
Choose a stable public URL before sharing invitations or installing the Bilibili helper.

## Watch together

1. Open OVS and optionally set a display name. Your browser remembers your anonymous identity.
2. Select a Bilibili video or local file on the home page, then create a room.
3. Share the invitation link or code. Participants open the link or paste the code on the home page.
4. Each participant prepares the video. For local playback, everyone selects their own copy of the same file.
5. Select Play. The host chooses whether everyone can control playback and whether to wait for everyone.

For Bilibili, each participant needs Tampermonkey and the instance-specific **OVS playback helper** offered by OVS. Confirm installation in Tampermonkey, then reload the OVS tab. Each participant uses their own Bilibili access; platform credentials stay in their browser.

Invitations remain reusable until the host replaces them or closes the room. A room closes when everyone leaves, with a short grace for disconnected pages. After a server restart, rooms resume paused at the beginning.
Volume, mute, quality, danmaku, language, and appearance affect only your browser. Use **Settings** in the header to change application preferences.

| Shortcut       | Action             |
| -------------- | ------------------ |
| Space / K      | Play or pause      |
| Left / Right   | Seek five seconds  |
| Up / Down      | Adjust volume      |
| M              | Mute               |
| D              | Toggle danmaku     |
| F              | Fullscreen         |
| Cmd / Ctrl + K | Open Quick actions |

Shortcuts respect text inputs, menus, and dialogs. If the browser blocks autoplay, select **Enable playback** in the player.

## Configuration and data

| Variable              | Default  | Purpose                          |
| --------------------- | -------- | -------------------------------- |
| `OVS_PUBLIC_ORIGIN`   | Required | Exact public URL of the instance |
| `OVS_LISTEN_ADDR`     | `:8080`  | Application listener             |
| `OVS_DATA_DIR`        | `/data`  | Persistent application data      |
| `OVS_LOG_LEVEL`       | `info`   | `debug`, `info`, `warn`, `error` |
| `OVS_TRUSTED_PROXIES` | Empty    | Trusted reverse-proxy CIDRs      |

The Compose example supplies `OVS_PUBLIC_ORIGIN=http://127.0.0.1:8080` by default. See the [deployment guide](deploy/README.md) for proxy settings, HTTPS, logs, and updates.

Keep `/data` private and preserve it across replacements. To copy it, stop OVS and copy the whole directory, including SQLite sidecars, ownership, and file modes. Run one OVS process per data directory. Playback position is not saved.

## Project documentation

- [Deployment](deploy/README.md)
- [Development and validation](CONTRIBUTING.md)
- [Product requirements](specs/PRD.md), [technical design](specs/DESIGN.md), and [application protocol](specs/WIRE.md)
- [Changelog](CHANGELOG.md)

## License

[GNU General Public License v3.0](LICENSE)
