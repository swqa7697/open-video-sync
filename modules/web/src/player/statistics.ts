/** Browser-local snapshot. Bitrates use bits/s; download throughput uses bytes/s. */
export interface PlayerStatistics {
  width?: number;
  height?: number;
  frameRate?: number;
  frameRateEstimated?: boolean;
  videoBitrate?: number;
  audioBitrate?: number;
  videoCodec?: string;
  audioCodec?: string;
  videoSegment?: { current: number; total: number };
  audioSegment?: { current: number; total: number };
  bufferAheadSeconds: number;
  downloadBytesPerSecond?: number;
}

/** Only the range containing the playhead contributes playable forward buffer. */
export function forwardBuffer(video: HTMLVideoElement): number {
  const position = video.currentTime;
  for (let index = 0; index < video.buffered.length; index++) {
    if (
      video.buffered.start(index) <= position &&
      video.buffered.end(index) > position
    )
      return video.buffered.end(index) - position;
  }
  return 0;
}
