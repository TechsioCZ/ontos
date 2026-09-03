import fs from 'node:fs';
import { expect, test } from '@rstest/core';
import { Schema } from 'effect';

const workspaceRoot = new URL('../../../../', import.meta.url);
const readJson = <Value, Encoded>(relativePath: string, schema: Schema.Schema<Value, Encoded>) =>
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
  verticals: Schema.Array(Schema.Struct({ id: Schema.String })),
});

test('keeps authentication in the existing Shell/Core ownership boundary', () => {
  const topology = readJson('topology/reference-topology.json', TopologySchema);
  const ownershipSource = readText('topology/ownership.json');
  const shellPackageSource = readText('apps/shell-super-app/package.json');
  const { authentication, moduleFederation, verticalRefs } = topology.shell;
  const installedVerticalIds = topology.verticals.map(({ id }) => id);

  expect(authentication.kind).toBe('shell-core-capability');
  expect(authentication.owners).toEqual(['shell-super-app', 'core-runtime']);
  expect(installedVerticalIds).toEqual(['contacts', 'projects']);
  expect(verticalRefs).toEqual(installedVerticalIds);
  expect(moduleFederation.remotes.map(({ id }) => id)).toEqual(installedVerticalIds);
  expect(fs.existsSync(new URL('verticals/auth', workspaceRoot))).toBe(false);
  expect(shellPackageSource).not.toContain('@app/auth');
  expect(ownershipSource).not.toContain('"id":"auth"');
});
