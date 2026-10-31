import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Keep the manifest deliberately small: one table with three stable versions.
export function readVersions() {
  const raw = readFileSync(
    new URL('../versions.toml', import.meta.url),
    'utf8'
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
        value
      );
    if (!table || !match || Object.hasOwn(versions, match[1]))
      throw new Error(
        'Invalid versions.toml: expected one stable version per module'
      );
    versions[match[1]] = match[2];
  }
  if (Object.keys(versions).length !== 3)
    throw new Error('versions.toml must define sync, web, and helper');
  return versions;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const versions = readVersions();
  const name = process.argv[2];
  if (name === 'image-tag') {
    process.stdout.write(
      `s${versions.sync}-w${versions.web}-h${versions.helper}\n`
    );
  } else {
    if (!Object.hasOwn(versions, name))
      throw new Error(
        'Usage: node scripts/versions.mjs sync|web|helper|image-tag'
      );
    process.stdout.write(`${versions[name]}\n`);
  }
}
