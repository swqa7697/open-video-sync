import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Docker receives this snapshot from the checkout; Git is not needed in the image.
export function readBuildInfo(
  root = fileURLToPath(new URL('..', import.meta.url)),
) {
  if (process.env.OVS_BUILD_INFO) {
    const info = JSON.parse(process.env.OVS_BUILD_INFO);
    if (
      !info ||
      Object.keys(info).sort().join(',') !== 'commit,dirty,tag' ||
      typeof info.commit !== 'string' ||
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})?$/.test(info.commit) ||
      typeof info.dirty !== 'boolean' ||
      typeof info.tag !== 'string' ||
      info.tag.length > 256 ||
      /[\p{Cc}\s]/u.test(info.tag) ||
      (!info.commit && (info.dirty || info.tag))
    )
      throw new Error('Invalid OVS_BUILD_INFO.');
    return info;
  }
  root = realpathSync(root);
  const git = (...args) =>
    execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  let commit;
  try {
    if (realpathSync(git('rev-parse', '--show-toplevel')) !== root)
      return { commit: '', dirty: false, tag: '' };
    commit = git('rev-parse', '--verify', 'HEAD');
  } catch {
    return { commit: '', dirty: false, tag: '' };
  }
  const dirty =
    git('status', '--porcelain=v1', '--untracked-files=normal') !== '';
  let tag = '';
  try {
    tag = git('describe', '--tags', '--exact-match', 'HEAD');
  } catch {
    // An untagged commit has no tag; do not report an ancestor's release tag.
  }
  return { commit, dirty, tag };
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
    const versions = readVersions();
    process.stdout.write(
      `s${versions.sync}-w${versions.web}-h${versions.helper}\n`,
    );
  } else {
    const versions = readVersions();
    if (!Object.hasOwn(versions, name))
      throw new Error(
        'Usage: node scripts/versions.mjs sync|web|helper|image-tag|build-info',
      );
    process.stdout.write(`${versions[name]}\n`);
  }
}
