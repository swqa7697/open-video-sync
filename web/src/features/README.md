# Feature boundaries

`identity/` owns profile editing and explicit identity reset. `rooms/` owns membership, sharing, and host-management views.
The application shell owns request cancellation and uncertain HTTP retries. Serializable Pinia state keeps credentials in memory only.
Player timers and adapter ownership stay outside serializable stores. The room view exposes controller permission and wait for everyone.
Sharing retrieves reusable host-only invitations. Replaced pages dispose playback and require an explicit reload to take over again.

`media/MediaPicker.vue` owns browser-local selection and preparation for inline home creation and room replacement.
It prepares fingerprints against the random creation ID and retains only a browser-local file reference for handoff.
`media/HelperNotice.vue` checks the bundled helper requirement and a non-owning helper probe, with one notice per detected condition per visit.
`components/Modal.vue` uses native modal focus containment and restores the trigger on dismissal.
The application shell automatically redeems invitations. Unknown creation outcomes check the known room ID instead of a directory.
