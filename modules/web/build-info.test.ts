// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, test, vi } from 'vite-plus/test';

import { readBuildInfo } from '../../scripts/versions.mjs';

afterEach(() => vi.unstubAllEnvs());

// These are isolated clones: no developer checkout or index is changed.
test('captures clean, tagged, dirty, and untagged checkouts and ignores parent repositories', () => {
  vi.stubEnv('OVS_BUILD_INFO', '');
  const root = fileURLToPath(new URL('../../', import.meta.url));
  mkdirSync(`${root}.misc`, { recursive: true });
  const directory = mkdtempSync(`${root}.misc/build-info-`);
  try {
    const checkout = `${directory}/checkout`;
    execFileSync('git', ['clone', '--shared', '--quiet', root, checkout]);
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: checkout, encoding: 'utf8' }).trim();
    const commit = git('rev-parse', 'HEAD');
    // Isolate fixture tags from any release tags in the developer checkout.
    for (const tag of git('tag').split('\n').filter(Boolean))
      git('tag', '-d', tag);
    expect(readBuildInfo(checkout)).toEqual({ commit, dirty: false, tag: '' });
    git('tag', 'build-info-fixture');
    expect(readBuildInfo(checkout)).toEqual({
      commit,
      dirty: false,
      tag: 'build-info-fixture',
    });
    writeFileSync(`${checkout}/versions.toml`, '# synthetic modified source\n');
    expect(readBuildInfo(checkout).dirty).toBe(true);
    git('restore', 'versions.toml');
    writeFileSync(`${checkout}/untracked-source.txt`, 'synthetic source\n');
    expect(readBuildInfo(checkout).dirty).toBe(true);
    rmSync(`${checkout}/untracked-source.txt`);
    git('tag', '-d', 'build-info-fixture');
    expect(readBuildInfo(checkout)).toEqual({ commit, dirty: false, tag: '' });
    const archive = `${directory}/archive`;
    mkdirSync(archive);
    expect(readBuildInfo(archive)).toEqual({
      commit: '',
      dirty: false,
      tag: '',
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('accepts a container build snapshot and rejects malformed metadata', () => {
  const snapshot = { commit: 'a'.repeat(40), dirty: true, tag: 'v1.2.3' };
  vi.stubEnv('OVS_BUILD_INFO', JSON.stringify(snapshot));
  expect(readBuildInfo()).toEqual(snapshot);
  for (const invalid of [
    { ...snapshot, commit: 'not-a-commit' },
    { ...snapshot, dirty: 'false' },
    { ...snapshot, tag: 'tag\nunsafe' },
    { ...snapshot, commit: '' },
  ]) {
    vi.stubEnv('OVS_BUILD_INFO', JSON.stringify(invalid));
    expect(() => readBuildInfo()).toThrow('Invalid OVS_BUILD_INFO.');
  }
});
