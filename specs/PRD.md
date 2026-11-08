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
- Host Preferences: The room creator uses three Boolean checkboxes to allow everyone to control playback, allow everyone to change videos and episodes, and wait for participants. The first two default off; waiting defaults on. Synchronization uses automatic internal defaults.
- Browser Player: Provide a web player for selecting and watching supported videos within a room
  - Show the target frame and time when hovering over the progress bar. Keep previews inside the bar edges without seeking shared playback. Prepare Bilibili thumbnails asynchronously and progressively cache all compressed sheets. Downloads from different CDNs run independently; playback activity must not repeatedly cancel thumbnails. Recover automatically from temporary thumbnail failures, and never wait for thumbnails during video preparation, switching, or buffering. Use browser-local decoding for local files; retain the time when an image is unavailable.
  - For Bilibili, support AV1, HEVC, and AVC when the participant's browser can decode them. Preserve the preferred or highest playable quality, then prefer AV1 → HEVC → AVC within that quality. Skip unsupported representations automatically.
  - Offer a video-surface context menu through right-click or keyboard, with video statistics and shortcut help. Bilibili adds a canonical original-page link, local danmaku visibility, and reload danmaku. Keep the reload action only in this context menu. Opening, closing, and using the menu must not accidentally toggle shared playback.
  - Show browser-local video statistics in a persistent, nonmodal player overlay, including available resolution, frame rate, selected audio/video bitrates and codecs, current/total segments, forward playable buffer, and aggregate real-time media download activity with recent history. Mark estimates and hide unsupported fields. Exclude MIME type, player type, hosts, dropped frames, and per-track speed fields. Offer local snapshot copy/download and component versions. Statistics and shortcut help also have Quick actions entries. Never upload or persist statistics.
- Interface Language: Support English and Simplified Chinese. Follow the device language by default, with English fallback. Allow immediate browser-local overrides that survive reloads.
- Viewport Layout: Keep the application header, main structure, and primary actions within the viewport without document or main-panel scrolling. Adapt spacing and secondary descriptions to short screens. Fit the player to the source video's aspect ratio and use the largest size permitted by the available width and height. Fit the outer room card to the video plus any visible member pane and borders, with unused space outside the card. Do not impose a fixed room-width cap. Display the full source without stretching or added black bars. Let room content end naturally when it does not need the full height. Long lists, dialog content, and detail popovers may scroll internally; never hide an essential action to suppress overflow.
- Stable Forms: Keep form actions in place while loading, previewing media, or displaying results and errors. Use compact summaries and show long text in a separate detail popover without moving the form. Combine optional controls with existing rows instead of reserving empty sections.
- Appearance: Use a muted, cool accent by default and allow local accent changes. Default to dark mode and allow manual light/dark choices through settings or Quick actions. Remember browser-local choices and respect reduced motion. Keep playback and keyboard actions immediate.
- Application Settings: Keep the GitHub repository Star button with its current Star count on desktop and narrow screens, server status, settings, and user identity on the right of the header. Use the OVS play mark as the browser tab icon. Group appearance, language, notifications, and About in the settings menu. Show notifications as bottom toasts with a browser-local left/center/right position, defaulting to right. About separates build identity in its header from the bundled Sync service, Web frontend, and Helper script versions. Show the full image reference for every build. Official releases hide the Git commit; development builds show the commit when available and a dirty label for uncommitted source changes. Do not display a separate Git tag. Determine release status from the build-time image selection rule.
- Quick Actions: Open a searchable menu with Cmd/Ctrl + K or an entry beside the OVS logo. Support English/Chinese action search, `/` command matching, and `$` or direct Bilibili link/BV/SS/EP input. Prefill video selection for explicit confirmation. Respect current room permissions and keep keyboard interaction immediate.
- Synchronized Playback: Keep play, pause, seeking, playback speed, and playback position aligned across participants according to room preferences
  - Pause shared playback at the target after every manual seek, whether playing, paused, or waiting. Resume only after an explicit play action.
- Online Video Support: Support Bilibili video links in the first release, including loading and displaying danmaku; more sources (like YouTube) are planned after the first release
  - Accept BV video identifiers, SS season identifiers, EP episode identifiers, and their canonical video or bangumi links. Season selection starts at the first main episode, independent of account history. Preserve the exact episode for joining and reloading members. Require each member's own platform access; reject trial-only streams as full-episode playback.
  - For multipart videos and collections, show a selectable episode list beside room members through tabs. Also offer episodes in Quick actions: `@` lists episodes, `@number` locates an item by its original list number, and `@keywords` filters titles. Keep numbers stable after filtering. Members can browse; the host or members with video selection permission select the episode for everyone. Switching episodes starts playback from zero, subject to waiting and browser autoplay permission. Keep the search available with an error after a failed switch, and close Quick actions after server confirmation.
- Local Video Support: Let each participant select a local video file -- all participants must prepare the same video themselves (OVS does not distribute it)
- Viewing History: Keep each anonymous identity's latest 100 watched Bilibili videos, preserving the exact episode or part. Record stable video identifiers, titles, and the last-viewed time; exclude local videos, rooms, members, playback progress, and platform credentials. Record only actual playback, not previews or autoplay probes. Merge repeat views, allow search, deletion, clearing, and pausing recording, and retain history after a room closes. Offer history in home selection, room replacement, and Quick actions. Selecting history still requires explicit creation or replacement confirmation and current room permissions.
- Platform Credentials: Keep video-platform login credentials and session information on the participant's device (browser) -- never send them to the OVS server
- Existing Access Rights: Participants use their own access to platform content (OVS does not grant access to restricted videos)

## Implementation Decisions

- Backend: Go
- Frontend: Vue 3, TypeScript, Vite, Pinia
- Database: SQLite
  - Schema: One complete definition that always reflects the current database structure. The schema version identifies a release and is independent of migration IDs; one release can include multiple migrations. Deployment applies only pending immutable migrations according to the applied ledger prefix while OVS is stopped, then records the release schema version. New databases use the latest complete schema directly. Ordinary startup and restart never migrate existing databases.
  - Persistence Only: Store identities, sessions, rooms, settings, memberships, invitations, the selected media descriptor, and bounded personal viewing history and recording preferences
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

- Keep invitations reusable until the host explicitly resets them or the room closes. Different participants and the host can reuse the same link or code. While the room remains open, sharing, failed joins, helper installation, reloads, departure, removal, and elapsed time never invalidate invitations. Invitations have no expiry. Preserve pending invitation entry across reloads until joining succeeds.
- Close rooms after everyone leaves. Explicit final departure closes immediately; disconnected pages have 30 seconds to return. Restored rooms have a 60-second startup reconnection window.
- After host departure, persist Everyone playback control without transferring host management. A returning host can explicitly change that setting.
- Create rooms with initial media directly on the home page. Invitation links enter automatically. Keep management in dialogs and playback controls inside the player, with local quality and danmaku controls and shared playback speed from 0.5× to 2× in 0.25× steps. Apply controller permissions to speed changes and preserve playback position, play intent, and waiting state.
- Confirm room departure in a dialog. The OVS logo uses the same leave-room confirmation and returns home in the current tab. Bound room content width on ultrawide screens.
- Toggle shared playback by clicking the video or using Space/K. Use Left/Right for seeking, Up/Down for 10% volume steps with a brief numeric volume overlay without a percent sign, M for mute, D for danmaku, S for browser-window fullscreen, and F for native fullscreen. Browser-window fullscreen fills the content area while keeping browser chrome. Offer a player-control button and Quick action. Use S or Esc to return, closing open overlays first; keep playback unchanged. Shortcuts keep already hidden player controls hidden while retaining the numeric volume overlay. Shortcuts work across the foreground OVS page without requiring player focus, including when ordinary page buttons retain focus. Keep native keyboard behavior inside inputs, menus, and dialogs; Enter still activates focused buttons. Preserve the focused target and use subtle color feedback without focus outlines. Continue playback and synchronization when the page is backgrounded while connected. Remember volume, mute, quality, and danmaku display area in this browser. Default to unmuted 50% volume, the highest playable quality, and half-screen danmaku. Use a dedicated quality menu and no player settings button. Provide separate click-operated buttons for danmaku visibility and preferences, with a chat-and-gear icon for preferences and keyboard access. Keep the four right-side icons equal in visible width and height, including the settings gear. Do not open preferences on hover or long press. Show an Episodes button only when multiple episodes are available and the member has video selection permission; open a list matching the quality and playback-speed menu style. Mark the current episode. Keep the sidebar list browsable with disabled selections for members without permission. Support Enter confirmation in video selection dialogs.
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
  - The playback bridge runs only on explicitly configured OVS pages, never on Bilibili pages or embedded frames
  - Offer one shared Watch in OVS entry on top-level Bilibili video and bangumi pages. Combine installed instance helpers into a menu of exact OVS origins. Import the current video and part or episode for preview and explicit creation or replacement in a room the current identity hosts. Keep room information and mutations inside OVS. Prefer the existing room tab for replacement; offer explicit opening and connection takeover when no tab responds. Keep unconfirmed submissions tied to their original request, and start replacements paused at zero.
- Platform Sessions: Leave video-platform authentication and credentials on the participant's device
  - Exclude cookies, login tokens, and credential-bearing playback URLs from synchronization messages
- **Bilibili Validation**: Before finalizing the Tampermonkey-assisted adapter, verify direct browser media delivery, playback control, state reporting, danmaku, and platform-session behavior in a separate proof of concept on HTTP and HTTPS OVS pages
