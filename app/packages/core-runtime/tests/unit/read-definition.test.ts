// @effect-diagnostics asyncFunction:off nodeBuiltinImport:off
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { Effect, Schema } from 'effect';
import { defineRead, validateReadDescriptorInput } from '../../src/reads/definition.ts';
import { defineSystemModuleEntrypoint } from '../../src/modules/module-entrypoint.ts';

const modulePermissionTarget = () => ({ kind: 'module', moduleId: 'core.shell' }) as const;

test('defines immutable read metadata while keeping handler and service factory private', () => {
  const registration = defineRead(
    {
      accessKind: 'list',
      entrypoint: defineSystemModuleEntrypoint({
        access: 'read',
        entrypointKey: 'core.shell.list',
        moduleKey: 'core.shell',
        role: 'api',
      }),
      evidencePolicy: { captureMode: 'metadata_only', policyKey: 'core.shell.list.evidence.v1' },
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
  assert.deepEqual(Object.keys(registration), ['descriptor']);
  assert.equal(Object.isFrozen(registration.descriptor), true);
  assert.equal(Object.isFrozen(registration.descriptor.policies), true);
});

test('requires an explicit valid owner-scoped read entrypoint', () => {
  assert.throws(() =>
    validateReadDescriptorInput({
      entrypoint: defineSystemModuleEntrypoint({
        access: 'read',
        entrypointKey: 'core.foreign.detail',
        moduleKey: 'core.foreign',
        role: 'api',
      }),
      legalEntityScope: 'forbidden',
      owningModuleKey: 'core.shell',
    }),
  );
});

test('supports every governed access kind and rejects forged scope metadata', () => {
  for (const accessKind of ['detail', 'download', 'export', 'list', 'report', 'search'] as const) {
    assert.doesNotThrow(() =>
      defineRead(
        {
          accessKind,
          entrypoint: defineSystemModuleEntrypoint({
            access: 'read',
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
    );
  }
  assert.throws(() =>
    validateReadDescriptorInput({
      entrypoint: defineSystemModuleEntrypoint({
        access: 'read',
        entrypointKey: 'core.shell.valid',
        moduleKey: 'core.shell',
        role: 'api',
      }),
      legalEntityScope: 'implicit',
      owningModuleKey: 'core.shell',
    }),
  );
});

test('keeps low-level read runtime construction and Core schema out of package exports', async () => {
  const [indexSource, packageSource] = await Promise.all([
    readFile(new URL('../../src/index.ts', import.meta.url), 'utf-8'),
    readFile(new URL('../../package.json', import.meta.url), 'utf-8'),
  ]);
  assert.doesNotMatch(indexSource, /\bmakeReadRuntime,?$/mu);
  assert.doesNotMatch(packageSource, /"\.\/db\/schema"/u);
});
