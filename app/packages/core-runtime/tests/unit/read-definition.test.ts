import { fileURLToPath } from 'node:url';

import { NodeFileSystem } from '@effect/platform-node';
import { Effect, FileSystem, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { defineSystemModuleEntrypoint } from '../../src/modules/module-entrypoint.ts';
import {
  defineRead,
  defineReadConditionalPermission,
  defineReadResourcePermission,
  validateReadDescriptorInput,
} from '../../src/reads/definition.ts';

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
it('accepts an immutable conjunctive Resource permission declaration', () => {
  const resourcePermission = defineReadResourcePermission<{
    readonly profileId: string;
  }>(({ profileId }) => ({
    permission: 'read',
    resource: {
      moduleId: 'commerce.customer-context',
      resourceId: profileId,
      resourceType: 'retail-profile',
    },
  }));
  const entrypoint = defineSystemModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'context_permission', permission: 'module.access' },
    entrypointKey: 'core.shell.profile',
    moduleKey: 'core.shell',
    role: 'api',
  });

  expect(Object.isFrozen(resourcePermission)).toBe(true);
  expect(Object.keys(resourcePermission)).toEqual(['kind']);
  expect(() =>
    validateReadDescriptorInput({
      entrypoint,
      legalEntityScope: 'required',
      owningModuleKey: 'core.shell',
      resourcePermission,
    }),
  ).not.toThrow();
});
it('accepts only finite exact conditional permission branches bound to entrypoint permission', () => {
  const ProfileIdSchema = Schema.String.pipe(Schema.brand('ConditionalReadProfileId'));
  const SubjectSchema = Schema.Union([
    Schema.Struct({ kind: Schema.Literal('GUEST') }),
    Schema.Struct({
      kind: Schema.Literal('PROFILE'),
      profileId: ProfileIdSchema,
    }),
  ]);
  const InputSchema = Schema.Struct({ subject: SubjectSchema });
  type Input = typeof InputSchema.Type;
  type Subject = typeof SubjectSchema.Type;
  const conditional = defineReadConditionalPermission<Input, Subject>({
    branches: {
      GUEST: {
        requiredKinds: ['module'],
        resolve: () => [{ kind: 'module', moduleId: 'core.shell' }],
      },
      PROFILE: {
        requiredKinds: ['resource', 'resource_read'],
        resolve: (_input, subject) => [
          {
            kind: 'resource',
            resource: {
              moduleId: 'core.shell',
              resourceId: subject.profileId,
              resourceType: 'profile',
            },
          },
          {
            kind: 'resource_read',
            permission: 'read',
            resource: {
              moduleId: 'core.shell',
              resourceId: subject.profileId,
              resourceType: 'profile',
            },
          },
        ],
      },
    },
    permissionKey: 'profile.resolve',
    select: (input) => input.subject,
  });
  expect(Object.isFrozen(conditional)).toBe(true);
  expect(Object.isFrozen(conditional.branchTags)).toBe(true);
  expect(conditional.branchTags).toEqual(['GUEST', 'PROFILE']);

  expect(() =>
    defineRead(
      {
        accessKind: 'detail',
        entrypoint: defineSystemModuleEntrypoint({
          access: 'read',
          authorization: {
            kind: 'context_permission',
            permission: 'profile.resolve',
          },
          entrypointKey: 'core.shell.conditional-profile',
          moduleKey: 'core.shell',
          role: 'api',
        }),
        evidencePolicy: {
          captureMode: 'metadata_only',
          policyKey: 'core.shell.conditional-profile.v1',
        },
        inputSchema: InputSchema,
        legalEntityScope: 'required',
        owningModuleKey: 'core.shell',
        permissionTarget: 'conditional',
        policies: [],
        readKey: 'core.shell.conditional-profile',
        resultSchema: Schema.Void,
        schemaVersion: '1',
      },
      () => Effect.succeed({ evidence: { resultCount: 0 }, result: undefined }),
      () => Effect.succeed({}),
      conditional,
    ),
  ).not.toThrow();

  expect(() =>
    defineRead(
      {
        accessKind: 'detail',
        entrypoint: defineSystemModuleEntrypoint({
          access: 'read',
          authorization: {
            kind: 'context_permission',
            permission: 'different.permission',
          },
          entrypointKey: 'core.shell.conditional-mismatch',
          moduleKey: 'core.shell',
          role: 'api',
        }),
        evidencePolicy: {
          captureMode: 'metadata_only',
          policyKey: 'core.shell.conditional-mismatch.v1',
        },
        inputSchema: InputSchema,
        legalEntityScope: 'required',
        owningModuleKey: 'core.shell',
        permissionTarget: 'conditional',
        policies: [],
        readKey: 'core.shell.conditional-mismatch',
        resultSchema: Schema.Void,
        schemaVersion: '1',
      },
      () => Effect.succeed({ evidence: { resultCount: 0 }, result: undefined }),
      () => Effect.succeed({}),
      conditional,
    ),
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
