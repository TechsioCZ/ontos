import { fileURLToPath } from 'node:url';

import { NodeFileSystem } from '@effect/platform-node';
import { Effect, FileSystem, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { defineSystemModuleEntrypoint } from '../../src/modules/module-entrypoint.ts';
import { defineRead, validateReadDescriptorInput } from '../../src/reads/definition.ts';

const modulePermissionTarget = () => ({ kind: 'module', moduleId: 'core.shell' }) as const;
it('defines immutable read metadata while keeping handler and service factory private', () => {
  const registration = defineRead(
    {
      accessKind: 'list',
      entrypoint: defineSystemModuleEntrypoint({
        access: 'read',
        authorization: {
          kind: 'context_permission',
          permission: 'module.access',
        },
        entrypointKey: 'core.shell.list',
        moduleKey: 'core.shell',
        role: 'api',
      }),
      evidencePolicy: {
        captureMode: 'metadata_only',
        policyKey: 'core.shell.list.evidence.v1',
      },
      inputSchema: Schema.Struct({}),
      legalEntityScope: 'forbidden',
      owningModuleKey: 'core.shell',
      permissionTarget: 'module',
      policies: [],
      readKey: 'core.shell.list',
      resultSchema: Schema.Array(Schema.String),
      schemaVersion: '1',
    },
    () => Effect.succeed({ evidence: { resultCount: 0 }, result: [] }),
    () => Effect.succeed(Object.freeze({})),
    modulePermissionTarget,
  );
  expect(Object.keys(registration)).toEqual(['descriptor']);
  expect(Object.isFrozen(registration.descriptor)).toBe(true);
  expect(Object.isFrozen(registration.descriptor.policies)).toBe(true);
});
it('requires an explicit valid owner-scoped read entrypoint', () => {
  expect(() =>
    validateReadDescriptorInput({
      entrypoint: defineSystemModuleEntrypoint({
        access: 'read',
        authorization: {
          kind: 'context_permission',
          permission: 'module.access',
        },
        entrypointKey: 'core.foreign.detail',
        moduleKey: 'core.foreign',
        role: 'api',
      }),
      legalEntityScope: 'forbidden',
      owningModuleKey: 'core.shell',
    }),
  ).toThrow();
});
it('supports every governed access kind and rejects forged scope metadata', () => {
  for (const accessKind of ['detail', 'download', 'export', 'list', 'report', 'search'] as const) {
    expect(() =>
      defineRead(
        {
          accessKind,
          entrypoint: defineSystemModuleEntrypoint({
            access: 'read',
            authorization: {
              kind: 'context_permission',
              permission: 'module.access',
            },
            entrypointKey: `core.shell.${accessKind}`,
            moduleKey: 'core.shell',
            role: 'api',
          }),
          evidencePolicy: {
            captureMode: 'metadata_only',
            policyKey: `core.shell.${accessKind}.v1`,
          },
          inputSchema: Schema.Void,
          legalEntityScope: 'forbidden',
          owningModuleKey: 'core.shell',
          permissionTarget: 'module',
          policies: [],
          readKey: `core.shell.${accessKind}`,
          resultSchema: Schema.Void,
          schemaVersion: '1',
        },
        () => Effect.succeed({ evidence: { resultCount: 0 }, result: undefined }),
        () => Effect.succeed({}),
        modulePermissionTarget,
        accessKind === 'search' ? () => [] : undefined,
      ),
    ).not.toThrow();
  }
  expect(() =>
    validateReadDescriptorInput({
      entrypoint: defineSystemModuleEntrypoint({
        access: 'read',
        authorization: {
          kind: 'context_permission',
          permission: 'module.access',
        },
        entrypointKey: 'core.shell.valid',
        moduleKey: 'core.shell',
        role: 'api',
      }),
      legalEntityScope: 'implicit',
      owningModuleKey: 'core.shell',
    }),
  ).toThrow();
});
it.layer(NodeFileSystem.layer)('read package boundary', (suite) => {
  suite.effect('keeps low-level read runtime construction and Core schema out of package exports', () =>
    Effect.gen(function* readPackageBoundary() {
      const fs = yield* FileSystem.FileSystem;
      const [indexSource, packageSource] = yield* Effect.all(
        [
          fs.readFileString(fileURLToPath(new URL('../../src/index.ts', import.meta.url))),
          fs.readFileString(fileURLToPath(new URL('../../package.json', import.meta.url))),
        ],
        { concurrency: 'unbounded' },
      );
      expect(indexSource).not.toMatch(/\bmakeReadRuntime,?$/mu);
      expect(packageSource).not.toMatch(/"\.\/db\/schema"/u);
    }),
  );
});
