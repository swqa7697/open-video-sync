import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

import { readVersions } from '../../../scripts/versions.mjs';

const root = new URL('../', import.meta.url);
const version = readVersions().helper;
const code = await readFile(new URL('helper.user.js', root), 'utf8');
const parser = await readFile(new URL('bridge-json.js', root), 'utf8');
const codecs = await readFile(new URL('media-codecs.js', root), 'utf8');
const source = code
  .replaceAll('{{HELPER_VERSION}}', version)
  .replace('/* OVS_BRIDGE_JSON */', parser.replace(/^export /, ''))
  .replace('/* OVS_MEDIA_CODECS */', codecs.replace(/^export /m, ''));
// Development checkouts can change the helper without changing its release version.
const build = createHash('sha256').update(source).digest('hex');
const release = { version, protocol: 1, build };
const body = source.replaceAll('{{HELPER_BUILD}}', build);
await mkdir(new URL('dist/', root), { recursive: true });
await writeFile(new URL('dist/helper.user.js', root), body);
await writeFile(
  new URL('dist/release.json', root),
  `${JSON.stringify(release)}\n`,
);
