import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { readVersions } from '../../../scripts/versions.mjs';

const root = new URL('../', import.meta.url);
const release = { version: readVersions().helper, protocol: 1 };
const code = await readFile(new URL('helper.user.js', root), 'utf8');
const parser = await readFile(new URL('bridge-json.js', root), 'utf8');
const body = code
  .replaceAll('{{HELPER_VERSION}}', release.version)
  .replace('/* OVS_BRIDGE_JSON */', parser.replace(/^export /, ''));
await mkdir(new URL('dist/', root), { recursive: true });
await writeFile(new URL('dist/helper.user.js', root), body);
await writeFile(
  new URL('dist/release.json', root),
  `${JSON.stringify(release)}\n`
);
