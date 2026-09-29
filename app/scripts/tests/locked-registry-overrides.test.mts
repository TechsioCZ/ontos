import { readFileSync } from 'node:fs';

import { expect, it } from 'effect-rstest';

import { lockedRegistryOverrides } from '../locked-registry-overrides.mjs';

const lockfile = `---
lockfileVersion: '9.0'

importers:

  .:
    configDependencies: {}
---
lockfileVersion: '9.0'

packages:

  '@effect/platform-node-shared@4.0.0-rc.117':
    resolution: {integrity: sha512-a}

  effect@4.0.0-rc.117:
    resolution: {integrity: sha512-b}

  aliased@npm:other@1.0.0:
    resolution: {integrity: sha512-e}

  semver@6.3.1:
    resolution: {integrity: sha512-c}

  semver@7.7.2:
    resolution: {integrity: sha512-d}

  drizzle-orm@https://codeload.example/drizzle-orm.tgz:
    resolution: {tarball: https://codeload.example/drizzle-orm.tgz}
`;

it('pins every package the lockfile resolves to exactly one registry version', () => {
  expect(lockedRegistryOverrides(lockfile)).toEqual({
    '@effect/platform-node-shared': '4.0.0-rc.117',
    effect: '4.0.0-rc.117',
  });
});

it('pins the Effect platform cohort that the runtime install used to float past', () => {
  const overrides = lockedRegistryOverrides(readFileSync(new URL('../../pnpm-lock.yaml', import.meta.url), 'utf-8'));
  expect(overrides['@effect/platform-node-shared']).toBe(overrides.effect);
});
