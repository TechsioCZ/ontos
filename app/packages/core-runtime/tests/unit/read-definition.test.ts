import { fixtureOwnerContract, fixtureOwnerModule, ownerPermissionTarget } from '../support/owner-permission-target.ts';
import { fileURLToPath } from 'node:url';

import { NodeFileSystem } from '@effect/platform-node';
import { Effect, FileSystem, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { AccessDeclarationError } from '../../src/authorization/access-declaration-error.ts';
import type { AccessFieldGroupInput } from '../../src/authorization/access-declaration.ts';
import { defineTenantModuleEntrypoint, defineSystemModuleEntrypoint } from '../../src/modules/module-entrypoint.ts';
import {
  defineRead,
  defineReadOwnerPermission,
  defineReadConditionalPermission,
  defineReadResourcePermission,
  getReadAccessTargetResolver,
  getReadOwnerFactsResolver,
  getReadPermissionTargetResolver,
  validateReadDescriptorInput,
} from '../../src/reads/definition.ts';
import type { ReadDescriptorValidationInput } from '../../src/reads/definition.ts';
import { accessCarrierErrorReason, fixtureReadAccess } from '../support/access-declaration-fixtures.ts';

const modulePermissionTarget = () => ({ kind: 'module', moduleId: 'core.shell' }) as const;
it('defines immutable read metadata while keeping handler and service factory private', () => {
  const registration = defineRead(
    {
      accessDeclaration: fixtureReadAccess('core.shell'),
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
it('retains an exact owner permission resolver as an immutable read declaration', () => {
  const registration = defineRead(
    {
      accessDeclaration: fixtureReadAccess(fixtureOwnerModule),
      accessKind: 'detail',
      entrypoint: defineTenantModuleEntrypoint({
        access: 'read',
        authorization: { kind: 'context_permission', permission: 'fixture.read' },
        entrypointKey: 'commerce.fixture.configuration',
        moduleKey: fixtureOwnerModule,
        role: 'api',
      }),
      evidencePolicy: { captureMode: 'metadata_only', policyKey: 'commerce.fixture.configuration.v1' },
      inputSchema: Schema.Struct({}),
      legalEntityScope: 'required',
      owningModuleKey: fixtureOwnerModule,
      permissionTarget: 'owner_permission',
      policies: [],
      readKey: 'commerce.fixture.configuration',
      resultSchema: Schema.String,
      schemaVersion: '1',
    },
    () => Effect.succeed({ evidence: { resultCount: 1 }, result: 'ok' }),
    () => Effect.succeed({}),
    defineReadOwnerPermission(fixtureOwnerContract, (_input, scope) => ownerPermissionTarget(scope)),
  );
  expect(Object.keys(registration)).toEqual(['descriptor']);
  expect(registration.descriptor.permissionTarget).toBe('owner_permission');
  expect(Object.isFrozen(registration.descriptor)).toBe(true);
  const foreignEntrypoint = defineTenantModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'context_permission', permission: 'fixture.read' },
    entrypointKey: 'commerce.foreign.configuration',
    moduleKey: 'commerce.foreign',
    role: 'api',
  });
  expect(() =>
    defineRead(
      {
        ...registration.descriptor,
        entrypoint: foreignEntrypoint,
        owningModuleKey: 'commerce.foreign',
        readKey: 'commerce.foreign.configuration',
      },
      () => Effect.succeed({ evidence: { resultCount: 1 }, result: 'ok' }),
      () => Effect.succeed({}),
      defineReadOwnerPermission(fixtureOwnerContract, (_input, scope) => ownerPermissionTarget(scope)),
    ),
  ).toThrow();
  expect(() =>
    defineRead(
      registration.descriptor,
      () => Effect.succeed({ evidence: { resultCount: 1 }, result: 'ok' }),
      () => Effect.succeed({}),
      (_input, scope) => ({ kind: 'owner_permission', ownerPermission: ownerPermissionTarget(scope) }),
    ),
  ).toThrow();
});
it('requires an explicit valid owner-scoped read entrypoint', () => {
  expect(() =>
    validateReadDescriptorInput({
      accessDeclaration: fixtureReadAccess('core.shell'),
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
      accessDeclaration: fixtureReadAccess('core.shell'),
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
        accessDeclaration: fixtureReadAccess('core.shell'),
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
        accessDeclaration: fixtureReadAccess('core.shell'),
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
          accessDeclaration: fixtureReadAccess('core.shell'),
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
      accessDeclaration: fixtureReadAccess('core.shell'),
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

it('declares two independent resource reads while rejecting duplicate canonical and oversized plans', () => {
  interface Input {
    readonly kind: 'GUEST' | 'PROFILE';
  }
  const declaration = () =>
    defineReadConditionalPermission<Input, Input>({
      branches: {
        GUEST: { requiredKinds: ['module'], resolve: () => [{ kind: 'module', moduleId: 'core.shell' }] },
        PROFILE: {
          requiredKinds: ['owner_permission', 'resource_read', 'resource_read'],
          resolve: () => [],
        },
      },
      ownerContract: fixtureOwnerContract,
      permissionKey: 'module.access',
      select: (input) => input,
    });
  expect(declaration).not.toThrow();
  for (const requiredKinds of [
    ['module', 'module'],
    ['owner_permission', 'owner_permission'],
    ['resource_read'],
    ['module', 'resource_read', 'resource_read', 'resource_read'],
  ] as const) {
    expect(() =>
      defineReadConditionalPermission<Input, Input>({
        branches: {
          GUEST: { requiredKinds: ['module'], resolve: () => [] },
          PROFILE: { requiredKinds, resolve: () => [] },
        },
        ownerContract: fixtureOwnerContract,
        permissionKey: 'module.access',
        select: (input) => input,
      }),
    ).toThrow();
  }
});

const declaredReadDescriptor = () =>
  ({
    accessDeclaration: {
      key: 'core.shell.list.read',
      kind: 'read' as const,
      modes: ['run'] as const,
      placement: { group: 'shell', level: 'basic' as const },
      risk: 'routine' as const,
      selectors: [] as const,
    },
    accessKind: 'list',
    entrypoint: defineSystemModuleEntrypoint({
      access: 'read' as const,
      authorization: {
        kind: 'context_permission' as const,
        permission: 'module.access',
      },
      entrypointKey: 'core.shell.list',
      moduleKey: 'core.shell',
      role: 'api' as const,
    }),
    evidencePolicy: { captureMode: 'metadata_only' as const, policyKey: 'core.shell.list.evidence.v1' },
    inputSchema: Schema.Struct({}),
    legalEntityScope: 'forbidden' as const,
    owningModuleKey: 'core.shell',
    permissionTarget: 'module' as const,
    policies: [],
    readKey: 'core.shell.list',
    resultSchema: Schema.Array(
      Schema.Struct({
        people: Schema.Array(
          Schema.Struct({
            salary: Schema.Struct({
              amount: Schema.optionalKey(Schema.Number),
              currencyCode: Schema.optionalKey(Schema.String),
            }),
          }),
        ),
      }),
    ),
    schemaVersion: '1',
  }) as const;

/** One `field_read` group of the governed read; the negative controls override one rule each. */
const declaredReadSalaries = (overrides: Partial<AccessFieldGroupInput> = {}): AccessFieldGroupInput => ({
  fieldClass: 'salaries',
  fields: ['people.salary.amount', 'people.salary.currencyCode'],
  key: 'core.shell.list.read-salaries',
  kind: 'field_read',
  modes: ['run'],
  placement: { group: 'shell', level: 'extended' },
  risk: 'sensitive',
  selectors: [],
  ...overrides,
});

const readHandler = () => Effect.succeed({ evidence: { resultCount: 0 }, result: [] });
const readServices = () => Effect.succeed(Object.freeze({}));

const declaredReadWithGroups = (accessFieldGroups: readonly AccessFieldGroupInput[]) =>
  defineRead({ ...declaredReadDescriptor(), accessFieldGroups }, readHandler, readServices, modulePermissionTarget);

const declaredReadWithoutDeclaration = () => {
  const { accessDeclaration, ...rest } = declaredReadDescriptor();
  expect(accessDeclaration.key).toBe('core.shell.list.read');
  return rest;
};

const defineProtectedRead = () =>
  defineRead(declaredReadWithoutDeclaration(), readHandler, readServices, modulePermissionTarget);

it('refuses a protected governed read that declares no access carrier (O62)', () => {
  expect(defineProtectedRead).toThrow(AccessDeclarationError);
  expect(accessCarrierErrorReason(defineProtectedRead)).toBe(
    'core.shell.list is context_permission: a protected entrypoint must declare accessDeclaration, accessWorkload or accessActor (O62)',
  );
  // Negative control: an unprotected read carries no access metadata and is accepted as-is.
  expect(() =>
    defineRead(
      {
        ...declaredReadWithoutDeclaration(),
        entrypoint: defineSystemModuleEntrypoint({
          access: 'read',
          authorization: { kind: 'authenticated_principal' },
          entrypointKey: 'core.shell.list',
          moduleKey: 'core.shell',
          role: 'api',
        }),
      },
      readHandler,
      readServices,
      modulePermissionTarget,
    ),
  ).not.toThrow();
});

it('carries frozen field groups beside the declaration of a governed read (O58)', () => {
  const registration = declaredReadWithGroups([declaredReadSalaries()]);
  const groups = registration.descriptor.accessFieldGroups;
  expect(groups?.map((group) => [group.key, group.kind, group.fieldClass, group.fields])).toEqual([
    ['core.shell.list.read-salaries', 'field_read', 'salaries', ['people.salary.amount', 'people.salary.currencyCode']],
  ]);
  expect(Object.isFrozen(groups)).toBe(true);
  expect(Object.isFrozen(groups?.[0]?.fields)).toBe(true);
  expect(Object.isFrozen(registration.descriptor)).toBe(true);

  for (const invalid of [
    // A write group cannot be carried by a read.
    declaredReadSalaries({ kind: 'field_write' }),
    // A sensitive class demands at least sensitive risk.
    declaredReadSalaries({ risk: 'routine' }),
    // Reads only run.
    declaredReadSalaries({ modes: ['run', 'propose'] }),
    // A group needs its own key inside the read module.
    declaredReadSalaries({ key: 'core.shell.list.read' }),
    declaredReadSalaries({ key: 'other.module.list.read-salaries' }),
    // The group governs named paths and is never record-scoped.
    declaredReadSalaries({ fields: [] }),
    declaredReadSalaries({ selectors: ['team'] }),
  ]) {
    expect(() => declaredReadWithGroups([invalid])).toThrow(AccessDeclarationError);
  }
  // Field access needs the parent record access (O58).
  expect(() =>
    defineRead(
      { ...declaredReadWithoutDeclaration(), accessFieldGroups: [declaredReadSalaries()] },
      readHandler,
      readServices,
      modulePermissionTarget,
    ),
  ).toThrow(AccessDeclarationError);
});

const declaredReadWithResult = (resultSchema: Schema.ConstraintDecoder<unknown>, fields: readonly string[]) =>
  defineRead(
    { ...declaredReadDescriptor(), accessFieldGroups: [declaredReadSalaries({ fields })], resultSchema },
    readHandler,
    readServices,
    modulePermissionTarget,
  );

it('refuses a field group whose governed result path the result schema requires (O17, O58)', () => {
  // A caller without the group receives the record without the path, so a required property would
  // fail the result and HTTP success schemas and answer a server error instead of the redacted record.
  expect(() =>
    declaredReadWithResult(Schema.Struct({ salary: Schema.Number, title: Schema.String }), ['salary']),
  ).toThrow(
    'Read core.shell.list: field group core.shell.list.read-salaries governs salary, but the result schema requires it: a caller without core.shell.list.read-salaries receives the record without salary, so declare it with Schema.optionalKey in the result schema (O17, O58)',
  );
  // A path the result never carries governs nothing, so it is refused too.
  expect(() => declaredReadWithResult(Schema.Struct({ title: Schema.String }), ['salary'])).toThrow(
    'Read core.shell.list: field group core.shell.list.read-salaries governs salary, but the result schema has no such property',
  );
  // Negative controls: `optionalKey` and `optional` both let the projection omit the property.
  expect(() =>
    declaredReadWithResult(Schema.Struct({ salary: Schema.optionalKey(Schema.Number) }), ['salary']),
  ).not.toThrow();
  expect(() =>
    declaredReadWithResult(Schema.Struct({ salary: Schema.optional(Schema.Number) }), ['salary']),
  ).not.toThrow();
});

const postalAddress = Schema.Struct({ city: Schema.String });
const optionalOrigin = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('PARTY_BACKED'), partyRef: Schema.String }),
  Schema.Struct({ kind: Schema.Literal('COMMERCE_ONLY'), postalAddress: Schema.optionalKey(postalAddress) }),
]);
const requiredOrigin = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('PARTY_BACKED'), partyRef: Schema.String }),
  Schema.Struct({ kind: Schema.Literal('COMMERCE_ONLY'), postalAddress }),
]);
const savedAddresses = <Origin extends typeof optionalOrigin | typeof requiredOrigin>(origin: Origin) =>
  Schema.Struct({ addresses: Schema.Array(Schema.Struct({ label: Schema.optionalKey(Schema.String), origin })) });

it('follows a governed path through arrays, nested structs, unions and classes (O17, O58)', () => {
  const fields = ['addresses.label', 'addresses.origin.postalAddress'];
  expect(() => declaredReadWithResult(savedAddresses(optionalOrigin), fields)).not.toThrow();
  // The union branch that names the path requires it; the branch without it does not excuse that.
  expect(() => declaredReadWithResult(savedAddresses(requiredOrigin), fields)).toThrow(
    'governs addresses.origin.postalAddress, but the result schema requires it',
  );
  // A list read: the path applies to every element of a root array.
  expect(() =>
    declaredReadWithResult(Schema.Array(Schema.Struct({ value: Schema.optionalKey(Schema.String) })), ['value']),
  ).not.toThrow();
  expect(() => declaredReadWithResult(Schema.Array(Schema.Struct({ value: Schema.String })), ['value'])).toThrow(
    'governs value, but the result schema requires it',
  );
  // A class is followed into its fields, like a struct.
  class Governed extends Schema.Class<Governed>('Governed')({
    hidden: Schema.String,
    shown: Schema.optionalKey(Schema.String),
  }) {}
  expect(() => declaredReadWithResult(Schema.Struct({ item: Governed }), ['item.shown'])).not.toThrow();
  expect(() => declaredReadWithResult(Schema.Struct({ item: Governed }), ['item.hidden'])).toThrow(
    'governs item.hidden, but the result schema requires it',
  );
});

it('carries a decoded access declaration on a governed read and rejects an unprotected carrier', () => {
  const registration = defineRead(
    declaredReadDescriptor(),
    () => Effect.succeed({ evidence: { resultCount: 0 }, result: [] }),
    () => Effect.succeed(Object.freeze({})),
    modulePermissionTarget,
  );
  expect(registration.descriptor.accessDeclaration?.key).toBe('core.shell.list.read');
  expect(Object.isFrozen(registration.descriptor.accessDeclaration)).toBe(true);
  // Negative control: the carrier rules are entrypoint-bound, so an unprotected entrypoint is refused
  // even though it now carries a declaration.
  expect(() =>
    validateReadDescriptorInput({
      ...declaredReadDescriptor(),
      entrypoint: defineSystemModuleEntrypoint({
        access: 'read',
        authorization: { kind: 'authenticated_principal' },
        entrypointKey: 'core.shell.list',
        moduleKey: 'core.shell',
        role: 'api',
      }),
    }),
  ).toThrow(AccessDeclarationError);
});

const readAccessTarget = () => ({
  moduleKey: 'core.shell.records',
  recordKey: '6f1d5b6e-0d5b-4c1e-9f6b-2a3f0b9a4c11',
});

it('binds an accessTarget to the record-scoped declaration it serves (O9, O25, Q2)', () => {
  const recordTarget = readAccessTarget;
  const registration = defineRead(
    {
      ...declaredReadWithoutDeclaration(),
      accessDeclaration: { ...fixtureReadAccess('core.shell'), selectors: ['assigned'] },
      accessKind: 'detail',
      accessTarget: recordTarget,
      resultSchema: Schema.Array(Schema.String),
    },
    readHandler,
    readServices,
    modulePermissionTarget,
  );
  expect(registration.descriptor.accessTarget).toBe(recordTarget);
  expect(getReadAccessTargetResolver(registration)).toBe(recordTarget);

  const validate = (overrides: Partial<ReadDescriptorValidationInput>) => () =>
    validateReadDescriptorInput({
      ...declaredReadWithoutDeclaration(),
      accessDeclaration: { ...fixtureReadAccess('core.shell'), selectors: ['assigned'] },
      accessKind: 'detail',
      accessTarget: recordTarget,
      ...overrides,
    });
  const negativeControls: readonly [() => void, RegExp][] = [
    // A scope-wide capability returns no single record (Q2).
    [
      validate({ accessDeclaration: { ...fixtureReadAccess('core.shell'), selectors: [] } }),
      /accessTarget requires a record-scoped declaration/u,
    ],
    // A row-scoped read resolves its rows inside the owner query (O25).
    [validate({ accessKind: 'search' }), /declares no single accessTarget/u],
    [validate({ accessKind: 'list' }), /declares no single accessTarget/u],
    // A target without a declaration has no capability to decide it.
    [
      () =>
        validateReadDescriptorInput({
          ...declaredReadWithoutDeclaration(),
          accessKind: 'detail',
          accessTarget: recordTarget,
          entrypoint: defineSystemModuleEntrypoint({
            access: 'read',
            authorization: { kind: 'authenticated_principal' },
            entrypointKey: 'core.shell.list',
            moduleKey: 'core.shell',
            role: 'api',
          }),
        }),
      /requires the descriptor to declare its own accessDeclaration/u,
    ],
    [validate({ accessTarget: 'core.shell.records' }), /must be a resolver function/u],
  ];
  for (const [control, reason] of negativeControls) {
    expect(control).toThrow(reason);
  }
});

const recordOwnerFacts = () => ({ counterpartyId: '6f1d5b6e-0d5b-4c1e-9f6b-2a3f0b9a4c11' });

it('binds the owner-local facts of a read to the capability it declares (O70)', () => {
  const registration = defineRead(
    {
      ...declaredReadDescriptor(),
      accessKind: 'detail',
      accessOwnerFacts: recordOwnerFacts,
      resultSchema: Schema.Array(Schema.String),
    },
    readHandler,
    readServices,
    modulePermissionTarget,
  );
  expect(registration.descriptor.accessOwnerFacts).toBe(recordOwnerFacts);
  expect(getReadOwnerFactsResolver(registration)).toBe(recordOwnerFacts);

  const validate = (overrides: Partial<ReadDescriptorValidationInput>) => () =>
    validateReadDescriptorInput({ ...declaredReadDescriptor(), accessKind: 'detail', ...overrides });
  const negativeControls: readonly [() => void, RegExp][] = [
    // Facts name the records of a capability; they never stand in for the capability itself.
    [
      () =>
        validateReadDescriptorInput({
          ...declaredReadWithoutDeclaration(),
          accessKind: 'detail',
          accessOwnerFacts: recordOwnerFacts,
          entrypoint: defineSystemModuleEntrypoint({
            access: 'read',
            authorization: { kind: 'authenticated_principal' },
            entrypointKey: 'core.shell.list',
            moduleKey: 'core.shell',
            role: 'api',
          }),
        }),
      /accessOwnerFacts requires/u,
    ],
    // A resolver is a function, never an already-evaluated map (O5).
    [validate({ accessOwnerFacts: recordOwnerFacts() }), /access owner facts must be a resolver function/u],
  ];
  for (const [control, reason] of negativeControls) {
    expect(control).toThrow(reason);
  }
});

const declaredReadWithoutPermissionTarget = () => {
  const { permissionTarget: _legacyTarget, ...rest } = declaredReadDescriptor();
  expect(_legacyTarget).toBe('module');
  return rest;
};

const protectedReadDescriptorWithoutLegacyTarget = () => {
  const { accessDeclaration, permissionTarget: _legacyTarget, ...rest } = declaredReadDescriptor();
  expect(accessDeclaration.key).toBe('core.shell.list.read');
  expect(_legacyTarget).toBe('module');
  return {
    ...rest,
    accessDeclaration,
    entrypoint: defineSystemModuleEntrypoint({
      access: 'read' as const,
      authorization: { kind: 'protected' as const },
      entrypointKey: 'core.shell.list',
      moduleKey: 'core.shell',
      role: 'api' as const,
    }),
  };
};

it('accepts a protected governed read that declares no legacy permission target or resolver (O62)', () => {
  const registration = defineRead(protectedReadDescriptorWithoutLegacyTarget(), readHandler, readServices);
  expect(registration.descriptor.permissionTarget).toBeUndefined();
  expect(getReadPermissionTargetResolver(registration)).toBeUndefined();
  // The declaration is still decoded, validated and frozen exactly as authored (O5).
  expect(registration.descriptor.accessDeclaration?.key).toBe('core.shell.list.read');
  expect(Object.isFrozen(registration.descriptor)).toBe(true);
  // The old shape stays accepted on the same protected entrypoint until C03b removes it (O68).
  expect(() =>
    defineRead(
      {
        ...protectedReadDescriptorWithoutLegacyTarget(),
        permissionTarget: 'module',
      },
      readHandler,
      readServices,
      modulePermissionTarget,
    ),
  ).not.toThrow();
  // Negative control: a read still on a legacy kind must name its target; absence is never an allow.
  expect(() => defineRead(declaredReadWithoutPermissionTarget(), readHandler, readServices)).toThrow(
    /closed governed-read vocabulary/u,
  );
  // Negative control: a protected read may not resolve a conditional target without its declaration.
  expect(() =>
    defineRead(
      { ...protectedReadDescriptorWithoutLegacyTarget(), permissionTarget: 'conditional' },
      readHandler,
      readServices,
    ),
  ).toThrow(/closed governed-read vocabulary/u);
});
