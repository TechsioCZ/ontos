import fs from 'node:fs';
import { expect, test } from '@rstest/core';
import { Schema } from 'effect';

const workspaceRoot = new URL('../../../../', import.meta.url);
const readJson = <JsonSchema extends Schema.ConstraintDecoder<unknown>>(
  relativePath: string,
  schema: JsonSchema,
): JsonSchema['Type'] =>
  Schema.decodeUnknownSync(schema)(
    JSON.parse(fs.readFileSync(new URL(relativePath, workspaceRoot), 'utf-8')),
  );
const readText = (relativePath: string) =>
  fs.readFileSync(new URL(relativePath, workspaceRoot), 'utf-8');

const TopologySchema = Schema.Struct({
  shell: Schema.Struct({
    authentication: Schema.Struct({
      kind: Schema.String,
      owners: Schema.Array(Schema.String),
    }),
    moduleFederation: Schema.Struct({
      remotes: Schema.Array(Schema.Struct({ id: Schema.String })),
    }),
    verticalRefs: Schema.Array(Schema.String),
  }),
  verticals: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      moduleFederation: Schema.Struct({ exposes: Schema.Array(Schema.String) }),
    }),
  ),
});

test('keeps authentication in the existing Shell/Core ownership boundary', () => {
  const topology = readJson('topology/reference-topology.json', TopologySchema);
  const ownershipSource = readText('topology/ownership.json');
  const shellPackageSource = readText('apps/shell-super-app/package.json');
  const { authentication, moduleFederation, verticalRefs } = topology.shell;
  const installedVerticalIds = topology.verticals.map(({ id }) => id);
  const browserRemoteIds = topology.verticals
    .filter(({ moduleFederation: remote }) => remote.exposes.length > 0)
    .map(({ id }) => id);

  expect(authentication.kind).toBe('shell-core-capability');
  expect(authentication.owners).toEqual(['shell-super-app', 'core-runtime']);
  expect(installedVerticalIds).toEqual(['party-registry']);
  expect(verticalRefs).toEqual(installedVerticalIds);
  expect(browserRemoteIds).toEqual(['party-registry']);
  expect(moduleFederation.remotes.map(({ id }) => id)).toEqual(browserRemoteIds);
  expect(fs.existsSync(new URL('verticals/auth', workspaceRoot))).toBe(false);
  expect(shellPackageSource).not.toContain('@app/auth');
  expect(ownershipSource).not.toContain('"id":"auth"');
});

test('keeps the Contacts page in the Party Registry lazy browser allowlist', () => {
  const source = readText('apps/shell-super-app/src/api/vertical-clients.ts');
  const lazyRemotes = [...source.matchAll(/import\('(?<remote>[^']+)'\)/gu)].map(
    (match) => match.groups?.['remote'],
  );
  const componentKeys = [...source.matchAll(/componentKey: '(?<key>[^']+)'/gu)].map(
    (match) => match.groups?.['key'],
  );
  expect(lazyRemotes).toEqual(['partyRegistry/PageContacts']);
  expect(componentKeys).toEqual(['party.registry.page-contacts']);
});
