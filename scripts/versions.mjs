import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

function gitOutput(root, ...args) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

function validImage(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 512 &&
    !/[\p{Cc}\s]/u.test(value)
  );
}

// Only an exact release tag on the checked-out main branch names a release image.
export function readImageTag(
  root = fileURLToPath(new URL('..', import.meta.url)),
) {
  try {
    root = realpathSync(root);
    if (
      realpathSync(gitOutput(root, 'rev-parse', '--show-toplevel')) !== root ||
      gitOutput(root, 'symbolic-ref', '--quiet', 'HEAD') !== 'refs/heads/main'
    )
      return 'dev';
    const tags = gitOutput(
      root,
      'tag',
      '--points-at',
      'HEAD',
      '--sort=-refname',
    );
    return (
      tags.split('\n').find((tag) => {
        if (!/^v[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(tag)) return false;
        const date = new Date(tag.slice(1));
        return (
          Number.isFinite(date.getTime()) &&
          date.toISOString().slice(0, 10) === tag.slice(1)
        );
      }) ?? 'dev'
    );
  } catch {
    return 'dev';
  }
}

// Docker receives this snapshot from the checkout; Git is not needed in the image.
export function readBuildInfo(
  root = fileURLToPath(new URL('..', import.meta.url)),
) {
  if (process.env.OVS_BUILD_INFO) {
    const info = JSON.parse(process.env.OVS_BUILD_INFO);
    if (
      !info ||
      Object.keys(info).sort().join(',') !== 'commit,dirty,image,release,tag' ||
      !validImage(info.image) ||
      typeof info.release !== 'boolean' ||
      typeof info.commit !== 'string' ||
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})?$/.test(info.commit) ||
      typeof info.dirty !== 'boolean' ||
      typeof info.tag !== 'string' ||
      info.tag.length > 256 ||
      /[\p{Cc}\s]/u.test(info.tag) ||
      (!info.commit && (info.dirty || info.tag || info.release))
    )
      throw new Error('Invalid OVS_BUILD_INFO.');
    return info;
  }
  const imageTag = readImageTag(root);
  const image = process.env.IMAGE || `ovs:${imageTag}`;
  if (!validImage(image)) throw new Error('Invalid IMAGE.');
  const build = { image, release: imageTag !== 'dev' };
  root = realpathSync(root);
  let commit;
  try {
    if (realpathSync(gitOutput(root, 'rev-parse', '--show-toplevel')) !== root)
      return { ...build, commit: '', dirty: false, tag: '' };
    commit = gitOutput(root, 'rev-parse', '--verify', 'HEAD');
  } catch {
    return { ...build, commit: '', dirty: false, tag: '' };
  }
  const dirty =
    gitOutput(root, 'status', '--porcelain=v1', '--untracked-files=normal') !==
    '';
  let tag = '';
  try {
    tag = gitOutput(root, 'describe', '--tags', '--exact-match', 'HEAD');
  } catch {
    // An untagged commit has no tag; do not report an ancestor's release tag.
  }
  return { ...build, commit, dirty, tag };
}

// Keep the manifest deliberately small: one table with three stable versions.
export function readVersions() {
  const raw = readFileSync(
    new URL('../versions.toml', import.meta.url),
    'utf8',
  );
  const versions = {};
  let table = false;
  for (const line of raw.split(/\r?\n/)) {
    const value = line.replace(/#.*$/, '').trim();
    if (!value) continue;
    if (value === '[versions]' && !table) {
      table = true;
      continue;
    }
    const match =
      /^(sync|web|helper)\s*=\s*"((?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*))"$/.exec(
        value,
      );
    if (!table || !match || Object.hasOwn(versions, match[1]))
      throw new Error(
        'Invalid versions.toml: expected one stable version per module',
      );
    versions[match[1]] = match[2];
  }
  if (Object.keys(versions).length !== 3)
    throw new Error('versions.toml must define sync, web, and helper');
  return versions;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const name = process.argv[2];
  if (name === 'build-info') {
    process.stdout.write(`${JSON.stringify(readBuildInfo())}\n`);
  } else if (name === 'image-tag') {
    process.stdout.write(`${readImageTag()}\n`);
  } else {
    const versions = readVersions();
    if (!Object.hasOwn(versions, name))
      throw new Error(
        'Usage: node scripts/versions.mjs sync|web|helper|image-tag|build-info',
      );
    process.stdout.write(`${versions[name]}\n`);
  }
}
