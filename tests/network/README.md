# Network acceptance boundary

`tests/e2e/measurement.spec.ts` performs three independent nearby development trials in separate Chromium processes.
The fixture encodes source frame numbers in visible text and pixel cells. Paused positions calibrate pixel readback before timing.
The observer pairs decoded frames using independently calibrated browser-to-runner clocks, with explicit sampling and quantization uncertainty.
Control application latency uses native player events and stays separate from ACKs and decoded-frame skew.
Raw samples, trial summaries, and limitations are saved under `.misc/e2e/results/` by `make test-e2e`.

The DESIGN section 13 impairment profiles, physical-display observation, reference-host capacity checks, and cross-region acceptance remain Stage 5.
Headless decoded-frame observations do not measure panel refresh or physical display latency.
