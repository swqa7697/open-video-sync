import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

export interface SampleFile {
  size: number;
  slice(start: number, end: number): { arrayBuffer(): Promise<ArrayBuffer> };
}
function u64(n: number): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(n));
  return b;
}
// The exact v1 byte encoding is shared with specs/fixtures/local-fingerprints-v1.json.
export async function fingerprint(
  file: SampleFile,
  roomId: string,
): Promise<string> {
  if (
    !/^[a-f0-9]{32}$/.test(roomId) ||
    !Number.isSafeInteger(file.size) ||
    file.size < 1 ||
    file.size > 17592186044416
  )
    throw new Error('Invalid local file.');
  const hash = sha256.create(),
    encoder = new TextEncoder();
  for (const value of ['ovs-local-v1', roomId]) {
    const bytes = encoder.encode(value);
    hash.update(u64(bytes.length)).update(bytes);
  }
  hash.update(u64(file.size));
  const length = Math.min(file.size, 1048576);
  for (const offset of [
    0,
    Math.floor((file.size - length) / 2),
    file.size - length,
  ]) {
    const bytes = new Uint8Array(
      await file.slice(offset, offset + length).arrayBuffer(),
    );
    if (bytes.length !== length) throw new Error('File read failed.');
    hash.update(u64(offset)).update(u64(length)).update(bytes);
  }
  return bytesToHex(hash.digest());
}
