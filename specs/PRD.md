# Open Video Sync

## Concept

Open Video Sync (OVS) is a private, self-hosted web tool that lets users watch videos together with synchronized playback.

Keep the product small: select a video, create a room, share an invitation, and watch together. Use sensible defaults instead of technical settings or operator workflows.

## Requirements

- Self-Hosting: Run an independent instance on a suitable personal computer or cloud server -- not a public hosted service
- Control Only: Do not upload, store, proxy, relay, or redistribute video content through OVS
- Multiple Rooms: Support multiple viewing rooms at the same time, with independent settings and playback state
- Optional HTTPS: Keep HTTPS setup independent of core functionality
- Anonymous Identity: Let users participate without manual registration or sign-in -- they automatically retain their identity across visits and allow an optional display name or label
- Room Sharing: Let users create rooms, share invitation links or codes, and join shared rooms
- Host Preferences: The room creator chooses who can control playback and whether to wait for participants. Synchronization uses automatic internal defaults.
- Browser Player: Provide a web player for selecting and watching supported videos within a room
  - For Bilibili, support AV1, HEVC, and AVC when the participant's browser can decode them. Preserve the preferred or highest playable quality, then prefer AV1 → HEVC → AVC within that quality. Skip unsupported representations automatically.
- Interface Language: Support English and Simplified Chinese. Follow the device language by default, with English fallback. Allow immediate browser-local overrides that survive reloads.
- Appearance: Use a muted, cool accent by default and allow local accent changes. Default to dark mode and allow manual light/dark choices through settings or Quick actions. Remember browser-local choices and respect reduced motion. Keep playback and keyboard actions immediate.
- Application Settings: Keep only server status, settings, and user identity on the right of the header. Group appearance, language, notifications, and About in the settings menu. Show notifications as bottom toasts with a browser-local left/center/right position, defaulting to right. About shows the Sync service, Web frontend, and Helper script versions bundled in the deployed image.
- Quick Actions: Open a searchable menu with Cmd/Ctrl + K or an entry beside the OVS logo. Support English/Chinese action search, `/` command matching, and `$` or direct Bilibili link/BV input. Prefill video selection for explicit confirmation. Respect current room permissions and keep keyboard interaction immediate.
- Synchronized Playback: Keep play, pause, seeking, and playback position aligned across participants according to room preferences
- Online Video Support: Support Bilibili video links in the first release, including loading and displaying danmaku; more sources (like YouTube) are planned after the first release
  - For multipart videos and collections, show a selectable episode list beside room members through tabs. The host selects the episode for everyone.
- Local Video Support: Let each participant select a local video file -- all participants must prepare the same video themselves (OVS does not distribute it)
- Platform Credentials: Keep video-platform login credentials and session information on the participant's device (browser) -- never send them to the OVS server
- Existing Access Rights: Participants use their own access to platform content (OVS does not grant access to restricted videos)

## Implementation Decisions

- Backend: Go
- Frontend: Vue 3, TypeScript, Vite, Pinia
- Database: SQLite
  - DDL Changes: recorded schema migrations in repo
  - Persistence Only: Store identities, sessions, rooms, settings, memberships, invitations, and the selected media descriptor
  - Runtime State: Load persistent state into application memory at startup. Handle ordinary reads, authorization, playback, synchronization, readiness, waiting, and command deduplication in memory without SQL
  - Durable Changes: Write only when persistent information changes. Do not save playback progress, runtime counters, diagnostic samples, or command history
  - Restart: Retain rooms and selected media; start paused at position zero with fresh runtime state
- Packaging: Embed the built frontend into the Go application
  - All-In-One: Ship one Docker application container that serves the web UI, API, and WebSocket endpoint; no separate database service is required
  - Simple Setup: Provide a straightforward deployment and maintenance experience
- Persistent Storage: Store SQLite data in a persistent local volume mounted at /data, independent of the container lifecycle
- HTTPS: Let an optional external reverse proxy manage certificates and TLS
  - Support Caddy installed directly on the host or running in a separate container, including an existing Caddy installation
  - Provide SSH deployment and management from the development machine to a Linux server with Docker. Prepare Compose and optional containerized Caddy automatically. Support public IP or domain HTTPS with automatic certificate renewal and strict public endpoint verification.
- Transport: Use WebSocket for the initial release
  - Validate control-response latency and playback skew separately under cross-region latency, jitter, and packet loss

## Simplicity boundaries

- Keep invitations reusable until the host explicitly resets them or the room closes. Different participants and the host can reuse the same link or code. While the room remains open, sharing, failed joins, helper installation, reloads, departure, removal, and elapsed time never invalidate invitations. Apply no invitation expiry, including to legacy invitations. Preserve pending invitation entry across reloads until joining succeeds.
- Close rooms after everyone leaves. Explicit final departure closes immediately; disconnected pages have 30 seconds to return. Restored rooms have a 60-second startup reconnection window.
- After host departure, persist Everyone playback control without transferring host management. A returning host can explicitly change that setting.
- Create rooms with initial media directly on the home page. Invitation links enter automatically. Keep management in dialogs and playback controls inside the player, with local quality and danmaku controls but no speed menu.
- Confirm room departure in a dialog. Open the OVS logo in a new tab. Bound room content width on ultrawide screens.
- Toggle shared playback by clicking the video or using Space/K. Use Left/Right for seeking, Up/Down for 10% volume steps, M for mute, D for danmaku, and F for fullscreen. Shortcuts work across the foreground OVS page without requiring player focus, including when ordinary page buttons retain focus. Keep native keyboard behavior inside inputs, menus, and dialogs; Enter still activates focused buttons. Preserve the focused target and use subtle color feedback without focus outlines. Continue playback and synchronization when the page is backgrounded while connected. Remember volume, mute, and quality in this browser. Default to unmuted 50% volume and the highest playable quality. Use a dedicated quality menu. Remove the player settings button and open danmaku preferences by hovering its toggle; retain click-to-toggle, keyboard access, and a touch long-press path. Support Enter confirmation in video selection dialogs.
- Late joiners catch up when ready. A new page takes over playback from the same identity's previous page in that room.
- Do not add backup/restore commands, restored-credential invalidation, automatic database recovery, metrics services, or playback diagnostic telemetry.
- Do not expose drift thresholds, correction modes, waiting timeouts, late-join modes, or per-member waiting exclusions.
- Keep deployment to one application container and a persistent directory. Optional HTTPS remains external.
- Keep real browser and network validation proportional to the core product; do not require a capacity certification, laboratory display measurements, or statistical-significance gate for release.

## Player Integration

- Player Adapters: Define a common interface for loading media, playback controls, position queries, and state events.
  - Declare optional capabilities such as playback-rate changes and buffering detection
- Local Files: Play user-selected files locally in the browser -- exchange media-matching metadata and playback state only
- Bilibili Integration: Use a Tampermonkey companion userscript on the OVS page to access Bilibili from each participant's browser; watch video and danmaku in the OVS page's own player
  - Each Bilibili participant installs the helper; local-file playback does not require it
  - The helper runs only on explicitly configured OVS pages, never on Bilibili pages or embedded frames
- Platform Sessions: Leave video-platform authentication and credentials on the participant's device
  - Exclude cookies, login tokens, and credential-bearing playback URLs from synchronization messages
- **Bilibili Validation**: Before finalizing the Tampermonkey-assisted adapter, verify direct browser media delivery, playback control, state reporting, danmaku, and platform-session behavior in a separate proof of concept on HTTP and HTTPS OVS pages
