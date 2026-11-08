import { readFileSync } from 'node:fs';
import { expect, test } from 'vite-plus/test';

import {
  decodeMedia,
  decodeProfilePatch,
  decodeRoomSettings,
} from './contracts';

const fixtures: {
  name: string;
  contract: string;
  valid: boolean;
  input: unknown;
}[] = JSON.parse(readFileSync('../../specs/fixtures/wire-v1.json', 'utf8'));

test.each(fixtures)(
  'shared wire values: $name',
  ({ contract, valid, input }) => {
    const decode = () => {
      switch (contract) {
        case 'profile':
          return decodeProfilePatch(input);
        case 'settings':
          return decodeRoomSettings(input);
        case 'media':
          return decodeMedia(input);
        default:
          throw new Error('unknown fixture contract');
      }
    };
    if (valid) expect(decode()).toEqual(input);
    else expect(decode).toThrow('invalid input');
  },
);

test('rejects values that JSON cannot represent before serialization', () => {
  const media = decodeMedia(
    fixtures.find((fixture) => fixture.name === 'local matching metadata')!
      .input,
  );
  for (const durationMs of [NaN, Infinity, -1, undefined]) {
    expect(() => decodeMedia({ ...media, durationMs })).toThrow(
      'invalid input',
    );
  }
});
