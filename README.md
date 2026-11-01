<p align="center">
  <img src="modules/web/src/assets/favicon.svg" alt="Open Video Sync" width="96" />
</p>

<h1 align="center">Open Video Sync</h1>

<p align="center">
  <strong>A private, self-hosted app for watching videos together</strong>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Go-1.27%2B-00ADD8?logo=go&logoColor=white" alt="Go 1.27+" />
  <img src="https://img.shields.io/badge/Vue-3-4FC08D?logo=vuedotjs&logoColor=white" alt="Vue 3" />
  <img src="https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white" alt="TypeScript" />
  <img src="https://img.shields.io/badge/SQLite-003B57?logo=sqlite&logoColor=white" alt="SQLite" />
  <img src="https://img.shields.io/badge/Docker_Compose-2496ED?logo=docker&logoColor=white" alt="Docker Compose" />
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-GPL--3.0-blue" alt="License: GPL-3.0" /></a>
</p>

<p align="center">
  <a href="#start-ovs">Start OVS</a> ·
  <a href="#watch-together">Watch together</a> ·
  <a href="#configuration-and-data">Configuration</a> ·
  <a href="#project-documentation">Documentation</a>
</p>

---

Open Video Sync (OVS) is a private, self-hosted app for watching videos together. Each participant supplies their own media; OVS synchronizes playback without uploading, storing, or relaying video.

The initial release is in development. OVS supports:

- **Private rooms** with reusable invitation links and codes, without registration.
- **Synchronized play, pause, and seeking**, with optional waiting for everyone.
- **Local video files and Bilibili videos** with quality selection, episodes, and danmaku.
- **Host controls** for room settings, media selection, invitations, and participants.
- **English and Simplified Chinese**, light and dark modes, and browser-local preferences.

> [!NOTE]
> Use desktop Chromium or Firefox. Video formats depend on browser and device decoding support. Player shortcuts keep hidden controls hidden; volume keys still show the numeric volume overlay. The header GitHub button shows the repository Star count when GitHub is reachable.

---

## Start OVS

Install Docker with Compose, then run from the repository root:

```bash
export IMAGE=ovs:local
docker compose -f deploy/compose.yaml up -d --build --wait
```

Open <http://127.0.0.1:8080>. Application data stays in the `ovs-data` volume across container replacements.

### LAN access

For LAN access, set the server's address and the exact URL participants will open:

```bash
OVS_BIND_ADDR=192.168.1.10 OVS_PUBLIC_ORIGIN=http://192.168.1.10:8080 \
  docker compose -f deploy/compose.yaml up -d --build --wait
```

Replace the example address with your server's address. Direct HTTP works without certificates. For HTTPS or deployment over SSH, follow the [deployment guide](deploy/README.md).

> [!IMPORTANT]
> Choose a stable public URL before sharing invitations or installing the Bilibili helper.

---

## Watch together

1. Open OVS and optionally set a display name. Your browser remembers your anonymous identity.
2. Select a Bilibili video or local file on the home page, then create a room.
3. Share the invitation link or code. Participants open the link or paste the code on the home page.
4. Each participant prepares the video. For local playback, everyone selects their own copy of the same file.
5. Select **Play**. The host chooses whether everyone can control playback and whether to wait for everyone.

### Bilibili

For Bilibili, each participant needs Tampermonkey and the instance-specific **OVS playback helper** offered by OVS. Confirm installation in Tampermonkey, then reload the OVS tab. Each participant uses their own Bilibili access; platform credentials stay in their browser.

### Rooms and preferences

Invitations remain reusable until the host replaces them or closes the room. A room closes when everyone leaves, with a short grace for disconnected pages. After a server restart, rooms resume paused at the beginning.

Volume, mute, quality, danmaku, language, and appearance affect only your browser. Use **Settings** in the header to change application preferences.

### Keyboard shortcuts

| Shortcut                                        | Action             |
| ----------------------------------------------- | ------------------ |
| <kbd>Space</kbd> / <kbd>K</kbd>                 | Play or pause      |
| <kbd>Left</kbd> / <kbd>Right</kbd>              | Seek five seconds  |
| <kbd>Up</kbd> / <kbd>Down</kbd>                 | Adjust volume      |
| <kbd>M</kbd>                                    | Mute               |
| <kbd>D</kbd>                                    | Toggle danmaku     |
| <kbd>F</kbd>                                    | Fullscreen         |
| <kbd>Cmd</kbd> / <kbd>Ctrl</kbd> + <kbd>K</kbd> | Open Quick actions |

Shortcuts respect text inputs, menus, and dialogs. If the browser blocks autoplay, select **Enable playback** in the player.

---

## Configuration and data

| Variable              | Default    | Purpose                          |
| --------------------- | ---------- | -------------------------------- |
| `OVS_PUBLIC_ORIGIN`   | _Required_ | Exact public URL of the instance |
| `OVS_LISTEN_ADDR`     | `:8080`    | Application listener             |
| `OVS_DATA_DIR`        | `/data`    | Persistent application data      |
| `OVS_LOG_LEVEL`       | `info`     | `debug`, `info`, `warn`, `error` |
| `OVS_TRUSTED_PROXIES` | Empty      | Trusted reverse-proxy CIDRs      |

The Compose example supplies `OVS_PUBLIC_ORIGIN=http://127.0.0.1:8080` by default. See the [deployment guide](deploy/README.md) for proxy settings, HTTPS, logs, and updates.

> [!WARNING]
> Keep `/data` private and preserve it across replacements. To copy it, stop OVS and copy the whole directory, including SQLite sidecars, ownership, and file modes. Run one OVS process per data directory. Playback position is not saved.

---

## Project documentation

- [Deployment](deploy/README.md)
- [Development and validation](CONTRIBUTING.md)
- [Product requirements](specs/PRD.md), [technical design](specs/DESIGN.md), and [application protocol](specs/WIRE.md)
- [Changelog](CHANGELOG.md)

---

## License

[GNU General Public License v3.0](LICENSE)
