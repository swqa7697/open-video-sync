import { Blob } from 'node:buffer';
import { expect, test } from 'vite-plus/test';
import vectors from '../../../specs/fixtures/local-fingerprints-v1.json';
import { fingerprint } from './fingerprint-core';
test('sampled matching agrees with independent tiny, overlap, and separated reference vectors', async () => {
  for (const vector of vectors) {
    const bytes = new Uint8Array(vector.sizeBytes);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31) % 251;
    expect(await fingerprint(new Blob([bytes]), vector.roomId)).toBe(
      vector.digest
    );
    bytes[0] = bytes[0]! ^ 1;
    expect(await fingerprint(new Blob([bytes]), vector.roomId)).not.toBe(
      vector.digest
    );
  }
});
