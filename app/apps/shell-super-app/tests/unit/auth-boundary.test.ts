import fs from 'node:fs';
import { expect, test } from '@rstest/core';

const workspaceRoot = new URL('../../../../', import.meta.url);
const readJson = (relativePath: string) =>
  JSON.parse(fs.readFileSync(new URL(relativePath, workspaceRoot), 'utf-8')) as Record<
    string,
    unknown
  >;

test('keeps authentication in the existing Shell/Core ownership boundary', () => {
  const topology = readJson('topology/reference-topology.json');
  const ownership = readJson('topology/ownership.json');
  const shellPackage = readJson('apps/shell-super-app/package.json');
  const shell = topology['shell'] as Record<string, unknown>;
  const authentication = shell['authentication'] as Record<string, unknown>;

  expect(authentication['kind']).toBe('shell-core-capability');
  expect(authentication['owners']).toEqual(['shell-super-app', 'core-runtime']);
  expect(
    (topology['verticals'] as readonly Record<string, unknown>[]).map((vertical) => vertical['id']),
  ).toEqual([]);
  expect(
    (
      (shell['moduleFederation'] as Record<string, unknown>)['remotes'] as readonly Record<
        string,
        unknown
      >[]
    ).map((remote) => remote['id']),
  ).toEqual([]);
  expect(fs.existsSync(new URL('verticals/auth', workspaceRoot))).toBe(false);
  expect(JSON.stringify(shellPackage)).not.toContain('@app/auth');
  expect(JSON.stringify(ownership)).not.toContain('"id":"auth"');
});
