# Network acceptance boundary

`tests/e2e/measurement.spec.ts` performs three independent nearby development trials in separate Chromium processes.
The fixture encodes source frame numbers in visible text and pixel cells. Paused positions calibrate pixel readback before timing.
The observer pairs decoded frames using independently calibrated browser-to-runner clocks, with explicit sampling and quantization uncertainty.
Control application latency uses native player events and stays separate from ACKs and decoded-frame skew.
Raw samples, trial summaries, and limitations are saved under `.misc/e2e/results/` by `make test-e2e`.

Validate the memory-owned runtime and playback behavior, then check representative cross-region latency, jitter, loss, asymmetry, and recovery.
[DESIGN section 13](../../specs/DESIGN.md#13-validation) defines the acceptance boundary without fixed capacity certification, physical-display measurements, universal timing thresholds, or statistical-significance gates.
Headless decoded-frame observations do not measure panel refresh or physical display latency.
