import { expect, it } from '@app/effect-rstest';
import { DateTime, Effect, Option, Schema, Predicate } from 'effect';
import {
  decodeActionPayload,
  decodeActionResult,
  defineAction,
  defineActionResourcePermission,
  validateActionDescriptorInput,
} from '../../src/actions/definition.ts';
import { defineGlobalPolicy, defineMicroverticalPolicy } from '../../src/actions/policy.ts';
import {
  defineSystemModuleEntrypoint,
  defineTenantModuleEntrypoint,
} from '../../src/modules/module-entrypoint.ts';

it.effect('defines an immutable typed descriptor and decodes typed payloads and results', () =>
  Effect.gen(function* definesAnImmutableTypedDescriptorAndDecodesTyped() {
    const registration = defineAction(
      {
        accessEvidencePolicy: { captureMode: 'metadata_only', policyKey: 'counter.read.v1' },
        actionKey: 'shell.counter.change',
        auditProfile: 'standard',
        domainErrorSchema: Schema.Never,
        domainEvents: {},
        entrypoint: defineSystemModuleEntrypoint({
          access: 'write',
          authorization: { kind: 'action_execution', provisioning: 'tenant_membership_default' },
          entrypointKey: 'shell.counter.change',
          moduleKey: 'core.shell',
          role: 'action',
        }),
        idempotency: 'required',
        legalEntityScope: 'optional',
        owningModuleKey: 'core.shell',
        payloadSchema: Schema.Struct({ amount: Schema.Finite }),
        policies: [],
        resultSchema: Schema.Struct({ total: Schema.Finite }),
        schemaVersion: '1',
      },
      (payload) => Effect.succeed({ total: payload.amount }),
    );

    const payload = yield* decodeActionPayload(registration.descriptor.payloadSchema, {
      amount: 4,
    });
    const result = yield* decodeActionResult(registration.descriptor.resultSchema, {
      total: payload.amount,
    });

    expect(payload).toEqual({ amount: 4 });
    expect(result).toEqual({ total: 4 });
    expect(Object.isFrozen(registration)).toBe(true);
    expect(Object.isFrozen(registration.descriptor)).toBe(true);
    expect(Object.isFrozen(registration.descriptor.policies)).toBe(true);
  }),
);

it('keeps the Resource permission resolver private behind an immutable declaration', () => {
  const permission = defineActionResourcePermission<{ readonly counterpartyId: string }>(
    ({ counterpartyId }) => ({
      permission: 'write',
      resource: {
        moduleId: 'party.registry',
        resourceId: counterpartyId,
        resourceType: 'counterparty',
      },
    }),
  );

  expect(Object.isFrozen(permission)).toBe(true);
  expect(Object.keys(permission)).toEqual(['kind']);
  expect(permission.kind).toBe('resource');
  expect('resolver' in permission).toBe(false);
});

it('requires trusted Legal Entity scope for a Counterparty permission declaration', () => {
  const entrypoint = defineTenantModuleEntrypoint({
    access: 'write',
    authorization: { kind: 'action_execution', provisioning: 'tenant_membership_default' },
    entrypointKey: 'party.registry.create-counterparty',
    moduleKey: 'party.registry',
    role: 'action',
  });
  expect(() =>
    validateActionDescriptorInput({
      entrypoint,
      legalEntityPermission: 'manage_counterparty',
      legalEntityScope: 'optional',
      owningModuleKey: 'party.registry',
      policies: [],
    }),
  ).toThrow();
  expect(() =>
    validateActionDescriptorInput({
      entrypoint,
      legalEntityPermission: 'manage_counterparty',
      legalEntityScope: 'required',
      owningModuleKey: 'party.registry',
      policies: [],
    }),
  ).not.toThrow();
});

it.effect('uses Schema.Void for a no-payload Action', () =>
  Effect.gen(function* usesSchemaVoidForANopayloadAction() {
    const registration = defineAction(
      {
        accessEvidencePolicy: { captureMode: 'metadata_only', policyKey: 'cache.read.v1' },
        actionKey: 'shell.cache.refresh',
        auditProfile: 'minimal',
        domainErrorSchema: Schema.Never,
        domainEvents: {},
        entrypoint: defineSystemModuleEntrypoint({
          access: 'write',
          authorization: { kind: 'action_execution', provisioning: 'tenant_membership_default' },
          entrypointKey: 'shell.cache.refresh',
          moduleKey: 'core.shell',
          role: 'action',
        }),
        idempotency: 'optional',
        legalEntityScope: 'optional',
        owningModuleKey: 'core.shell',
        payloadSchema: Schema.Void,
        policies: [],
        resultSchema: Schema.Void,
        schemaVersion: '1',
      },
      () => Effect.void,
    );

    // oxlint-disable-next-line unicorn/no-useless-undefined -- Required argument exercises the no-payload contract.
    const payload = yield* decodeActionPayload(registration.descriptor.payloadSchema, undefined);
    const invalid = yield* Effect.flip(
      decodeActionPayload(registration.descriptor.payloadSchema, {}),
    );

    expect(payload).toBeUndefined();
    expect(Predicate.isTagged(invalid, 'ActionPayloadValidationError')).toBe(true);
  }),
);

it('keeps the private handler outside the public Action registration', () => {
  const registration = defineAction(
    {
      accessEvidencePolicy: { captureMode: 'metadata_only', policyKey: 'counter.read.v1' },
      actionKey: 'shell.counter.change',
      auditProfile: 'standard',
      domainErrorSchema: Schema.Never,
      domainEvents: {},
      entrypoint: defineSystemModuleEntrypoint({
        access: 'write',
        authorization: { kind: 'action_execution', provisioning: 'tenant_membership_default' },
        entrypointKey: 'shell.counter.change',
        moduleKey: 'core.shell',
        role: 'action',
      }),
      idempotency: 'required',
      legalEntityScope: 'optional',
      owningModuleKey: 'core.shell',
      payloadSchema: Schema.Struct({ amount: Schema.Finite }),
      policies: [],
      resultSchema: Schema.Finite,
      schemaVersion: '1',
    },
    (payload) => Effect.succeed(payload.amount),
  );

  expect('handler' in registration).toBe(false);
  expect(Object.keys(registration)).toEqual(['descriptor']);
});

it.effect('rejects invalid declared results through a typed error', () =>
  Effect.gen(function* rejectsInvalidDeclaredResultsThroughATypedError() {
    const error = yield* Effect.flip(
      decodeActionResult(Schema.Struct({ id: Schema.String }), { id: 1 }),
    );

    expect(Predicate.isTagged(error, 'ActionResultValidationError')).toBe(true);
    expect(error.code).toBe('action_result_invalid');
  }),
);

it.effect(
  'validates decoded DateTime and Option results through their encoded representation',
  () =>
    Effect.gen(function* validatesDecodedDateTimeAndOptionResultsThroughTheir() {
      const resultSchema = Schema.Struct({
        archivedAt: Schema.OptionFromNullOr(Schema.DateTimeUtcFromString),
        createdAt: Schema.DateTimeUtcFromString,
      });
      const decoded = yield* Schema.decodeUnknownEffect(resultSchema)({
        archivedAt: null,
        createdAt: '2026-09-07T10:30:00.000Z',
      });
      const result = yield* decodeActionResult(resultSchema, decoded);

      expect(Option.isNone(result.archivedAt)).toBe(true);
      expect(DateTime.formatIso(result.createdAt)).toBe('2026-09-07T10:30:00.000Z');
    }),
);

it('accepts global and same-owner Policy references and copies the collection', () => {
  const globalPolicy = defineGlobalPolicy<{ readonly amount: number }>({
    evaluate: () => Effect.void,
    policyKey: 'global.tenant-active.v1',
  });
  const modulePolicy = defineMicroverticalPolicy<{ readonly amount: number }, 'inventory.stock'>({
    evaluate: () => Effect.void,
    owningModuleKey: 'inventory.stock',
    policyKey: 'inventory.stock.available.v1',
  });
  const policies = [globalPolicy, modulePolicy];
  const registration = defineAction(
    {
      accessEvidencePolicy: { captureMode: 'metadata_only', policyKey: 'stock.read.v1' },
      actionKey: 'inventory.stock.reserve',
      auditProfile: 'standard',
      domainErrorSchema: Schema.Never,
      domainEvents: {},
      entrypoint: defineTenantModuleEntrypoint({
        access: 'write',
        authorization: { kind: 'action_execution', provisioning: 'tenant_membership_default' },
        entrypointKey: 'inventory.stock.reserve',
        moduleKey: 'inventory.stock',
        role: 'action',
      }),
      idempotency: 'required',
      legalEntityScope: 'optional',
      owningModuleKey: 'inventory.stock',
      payloadSchema: Schema.Struct({ amount: Schema.Finite }),
      policies,
      resultSchema: Schema.Void,
      schemaVersion: '1',
    },
    () => Effect.void,
  );

  policies.pop();
  expect(registration.descriptor.policies).toEqual([globalPolicy, modulePolicy]);
  expect(Object.isFrozen(registration.descriptor.policies)).toBe(true);
  expect(registration.descriptor.policies[0]).toBe(globalPolicy);
  expect(registration.descriptor.policies[1]).toBe(modulePolicy);
});

it('rejects cross-owner, string, copied, and missing Policy references at definition time', () => {
  const foreignPolicy = defineMicroverticalPolicy<unknown, 'billing.invoice'>({
    evaluate: () => Effect.void,
    owningModuleKey: 'billing.invoice',
    policyKey: 'billing.invoice.open.v1',
  });
  const descriptor = {
    accessEvidencePolicy: { captureMode: 'metadata_only', policyKey: 'stock.read.v1' },
    actionKey: 'inventory.stock.reserve',
    auditProfile: 'standard',
    domainErrorSchema: Schema.Never,
    domainEvents: {},
    entrypoint: defineTenantModuleEntrypoint({
      access: 'write',
      authorization: { kind: 'action_execution', provisioning: 'tenant_membership_default' },
      entrypointKey: 'inventory.stock.reserve',
      moduleKey: 'inventory.stock',
      role: 'action',
    }),
    idempotency: 'required',
    legalEntityScope: 'optional',
    owningModuleKey: 'inventory.stock',
    payloadSchema: Schema.Struct({ amount: Schema.Finite }),
    resultSchema: Schema.Void,
    schemaVersion: '1',
  } as const;
  const incompatiblePayloadPolicy = defineGlobalPolicy<{ readonly sku: string }>({
    evaluate: () => Effect.void,
    policyKey: 'global.sku-required.v1',
  });
  const compileOnlyInvalidReferences = () => {
    defineAction(
      {
        ...descriptor,
        // @ts-expect-error Policy payload input must accept the decoded Action payload.
        policies: [incompatiblePayloadPolicy],
      },
      () => Effect.void,
    );
    defineAction(
      {
        ...descriptor,
        // @ts-expect-error Raw Policy keys are not Policy object references.
        policies: ['inventory.stock.available.v1'],
      },
      () => Effect.void,
    );
  };

  expect(() =>
    defineAction(
      {
        ...descriptor,
        // @ts-expect-error A foreign MicroVertical Policy is rejected by the owner contract.
        policies: [foreignPolicy],
      },
      () => Effect.void,
    ),
  ).toThrow();
  expect(Predicate.isFunction(compileOnlyInvalidReferences)).toBe(true);
  expect(() =>
    validateActionDescriptorInput({
      ...descriptor,
      policies: ['inventory.stock.available.v1'],
    }),
  ).toThrow();
  expect(() =>
    validateActionDescriptorInput({ ...descriptor, policies: [{ ...foreignPolicy }] }),
  ).toThrow();
  expect(() => validateActionDescriptorInput(descriptor)).toThrow();
});

it('rejects Action entrypoint owner, scope, role/access, and forged immutability mismatches', () => {
  const registration = defineAction(
    {
      accessEvidencePolicy: { captureMode: 'metadata_only', policyKey: 'stock.read.v1' },
      actionKey: 'inventory.stock.reserve',
      auditProfile: 'standard',
      domainErrorSchema: Schema.Never,
      domainEvents: {},
      entrypoint: defineTenantModuleEntrypoint({
        access: 'write',
        authorization: { kind: 'action_execution', provisioning: 'tenant_membership_default' },
        entrypointKey: 'inventory.stock.reserve',
        moduleKey: 'inventory.stock',
        role: 'action',
      }),
      idempotency: 'required',
      legalEntityScope: 'optional',
      owningModuleKey: 'inventory.stock',
      payloadSchema: Schema.Void,
      policies: [],
      resultSchema: Schema.Void,
      schemaVersion: '1',
    },
    () => Effect.void,
  );
  expect(() =>
    validateActionDescriptorInput({
      ...registration.descriptor,
      entrypoint: defineTenantModuleEntrypoint({
        access: 'write',
        authorization: { kind: 'action_execution', provisioning: 'tenant_membership_default' },
        entrypointKey: 'billing.invoice.reserve',
        moduleKey: 'billing.invoice',
        role: 'action',
      }),
    }),
  ).toThrow();
  expect(() =>
    validateActionDescriptorInput({
      ...registration.descriptor,
      entrypoint: defineSystemModuleEntrypoint({
        access: 'write',
        authorization: { kind: 'action_execution', provisioning: 'tenant_membership_default' },
        entrypointKey: 'inventory.stock.reserve',
        moduleKey: 'inventory.stock',
        role: 'action',
      }),
    }),
  ).toThrow();
  expect(() =>
    validateActionDescriptorInput({
      ...registration.descriptor,
      entrypoint: defineTenantModuleEntrypoint({
        access: 'write',
        authorization: { kind: 'action_execution', provisioning: 'tenant_membership_default' },
        entrypointKey: 'core.modules.change-state',
        moduleKey: 'core.modules',
        role: 'action',
      }),
      owningModuleKey: 'core.modules',
    }),
  ).toThrow();
  expect(() =>
    validateActionDescriptorInput({
      ...registration.descriptor,
      entrypoint: { ...registration.descriptor.entrypoint },
    }),
  ).toThrow();
  expect(() =>
    validateActionDescriptorInput({
      ...registration.descriptor,
      legalEntityScope: 'implicit',
    }),
  ).toThrow();
});
