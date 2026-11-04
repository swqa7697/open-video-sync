// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, test, vi } from 'vite-plus/test';

import { readBuildInfo, readImageTag } from '../../scripts/versions.mjs';

afterEach(() => vi.unstubAllEnvs());

// These are isolated clones: no developer checkout or index is changed.
test('captures clean, tagged, dirty, and untagged checkouts and ignores parent repositories', () => {
  vi.stubEnv('OVS_BUILD_INFO', '');
  vi.stubEnv('IMAGE', '');
  const build = { image: 'ovs:dev', release: false };
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
    expect(readBuildInfo(checkout)).toEqual({
      ...build,
      commit,
      dirty: false,
      tag: '',
    });
    git('tag', 'build-info-fixture');
    expect(readBuildInfo(checkout)).toEqual({
      ...build,
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
    expect(readBuildInfo(checkout)).toEqual({
      ...build,
      commit,
      dirty: false,
      tag: '',
    });
    const archive = `${directory}/archive`;
    mkdirSync(archive);
    expect(readBuildInfo(archive)).toEqual({
      ...build,
      commit: '',
      dirty: false,
      tag: '',
    });
    expect(readImageTag(archive)).toBe('dev');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('uses an exact dated release tag only on main and otherwise uses dev', () => {
  vi.stubEnv('OVS_BUILD_INFO', '');
  vi.stubEnv('IMAGE', '');
  const root = fileURLToPath(new URL('../../', import.meta.url));
  mkdirSync(`${root}.misc`, { recursive: true });
  const checkout = mkdtempSync(`${root}.misc/image-tag-`);
  try {
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: checkout, encoding: 'utf8' }).trim();
    expect(readImageTag(checkout)).toBe('dev');
    git('init', '--quiet', '--initial-branch=main');
    expect(readImageTag(checkout)).toBe('dev');
    // Seed two commits without invoking add, commit, or push.
    execFileSync('git', ['fast-import', '--quiet'], {
      cwd: checkout,
      input:
        'commit refs/heads/main\nmark :1\ncommitter Image Test <image@example.invalid> 1 +0000\ndata 7\nfixture\n\n' +
        'commit refs/heads/main\ncommitter Image Test <image@example.invalid> 2 +0000\ndata 7\nfixture\nfrom :1\n\ndone\n',
    });
    expect(readImageTag(checkout)).toBe('dev');
    git('tag', 'v2026-11-03', 'HEAD^');
    for (const tag of [
      'v1.2.3',
      'v2026-2-03',
      'v2026-02-29',
      'v2026-02-30',
      'v2026-13-01',
      'v2026-11-02-rc1',
    ])
      git('tag', tag);
    expect(readImageTag(checkout)).toBe('dev');
    git('tag', 'v2024-02-29');
    expect(readImageTag(checkout)).toBe('v2024-02-29');
    git(
      '-c',
      'user.name=Image Test',
      '-c',
      'user.email=image@example.invalid',
      'tag',
      '--annotate',
      'v2026-11-02',
      '--message',
      'Synthetic release',
    );
    expect(readImageTag(checkout)).toBe('v2026-11-02');
    expect(readBuildInfo(checkout)).toMatchObject({
      image: 'ovs:v2026-11-02',
      release: true,
    });
    git('switch', '--quiet', '--create', 'dev');
    expect(readImageTag(checkout)).toBe('dev');
    expect(readBuildInfo(checkout)).toMatchObject({
      image: 'ovs:dev',
      release: false,
    });
    git('switch', '--quiet', '--detach');
    expect(readImageTag(checkout)).toBe('dev');
    git('switch', '--quiet', 'main');
    writeFileSync(`${checkout}/untracked-source.txt`, 'synthetic source\n');
    expect(readImageTag(checkout)).toBe('v2026-11-02');
    vi.stubEnv('IMAGE', 'registry.example.invalid:5000/team/ovs:testing');
    expect(readBuildInfo(checkout)).toMatchObject({
      image: 'registry.example.invalid:5000/team/ovs:testing',
      release: true,
    });
  } finally {
    rmSync(checkout, { recursive: true, force: true });
  }
});

test('accepts a container build snapshot and rejects malformed metadata', () => {
  const snapshot = {
    image: 'ovs:v2026-11-02',
    release: true,
    commit: 'a'.repeat(40),
    dirty: true,
    tag: 'v2026-11-02',
  };
  vi.stubEnv('OVS_BUILD_INFO', JSON.stringify(snapshot));
  expect(readBuildInfo()).toEqual(snapshot);
  for (const invalid of [
    { ...snapshot, commit: 'not-a-commit' },
    { ...snapshot, dirty: 'false' },
    { ...snapshot, tag: 'tag\nunsafe' },
    { ...snapshot, commit: '' },
    { ...snapshot, image: '' },
    { ...snapshot, image: 'ovs:dev\nunsafe' },
    { ...snapshot, release: 'false' },
  ]) {
    vi.stubEnv('OVS_BUILD_INFO', JSON.stringify(invalid));
    expect(() => readBuildInfo()).toThrow('Invalid OVS_BUILD_INFO.');
  }
});
