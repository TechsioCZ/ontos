import { historicalOwnerContract, historicalOwnerTarget } from '../support/historical-owner-targets.ts';
import {
  fixtureOwnerContract,
  fixtureOwnerModule,
  fixtureOwnerEndPermission,
  fixtureOwnerCreatePermission,
  ownerPermissionTarget,
} from '../support/owner-permission-target.ts';
import { DateTime, Effect, Option, Schema, Predicate } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  decodeActionPayload,
  decodeActionResult,
  defineAction,
  defineActionOwnerPermissions,
  defineActionResourcePermission,
  getActionAccessAmountResolver,
  getActionAccessTargetResolver,
  validateActionDescriptorInput,
} from '../../src/actions/definition.ts';
import { defineGlobalPolicy, defineMicroverticalPolicy } from '../../src/actions/policy.ts';
import { AccessDeclarationError } from '../../src/authorization/access-declaration-error.ts';
import { accessCarrierErrorReason, fixtureActionAccess } from '../support/access-declaration-fixtures.ts';
import type {
  AccessDeclarationInput,
  AccessFieldGroupInput,
  AccessWorkloadInput,
} from '../../src/authorization/access-declaration.ts';
import type { ActionDescriptorValidationInput } from '../../src/actions/definition.ts';
import { defineSystemModuleEntrypoint, defineTenantModuleEntrypoint } from '../../src/modules/module-entrypoint.ts';

const counterActionDescriptor = () =>
  ({
    // O62: a protected Action must declare its access.
    accessDeclaration: {
      key: 'core.shell.counter.change',
      kind: 'action' as const,
      modes: ['run'] as const,
      placement: { group: 'counter', level: 'basic' as const },
      risk: 'routine' as const,
      selectors: [] as const,
    },
    accessEvidencePolicy: {
      captureMode: 'metadata_only',
      policyKey: 'counter.read.v1',
    },
    actionKey: 'shell.counter.change',
    auditProfile: 'standard',
    domainErrorSchema: Schema.Never,
    domainEvents: {},
    entrypoint: defineSystemModuleEntrypoint({
      access: 'write',
      authorization: {
        kind: 'action_execution',
        provisioning: 'tenant_membership_default',
      },
      entrypointKey: 'shell.counter.change',
      moduleKey: 'core.shell',
      role: 'action',
    }),
    idempotency: 'required',
    legalEntityScope: 'optional',
    owningModuleKey: 'core.shell',
    payloadSchema: Schema.Struct({ amount: Schema.Finite }),
    policies: [],
    schemaVersion: '1',
  }) as const;

it.effect('defines an immutable typed descriptor and decodes typed payloads and results', () =>
  Effect.gen(function* definesAnImmutableTypedDescriptorAndDecodesTyped() {
    const registration = defineAction(
      {
        ...counterActionDescriptor(),
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
  const permission = defineActionResourcePermission<{
    readonly counterpartyId: string;
  }>(({ counterpartyId }) => ({
    permission: 'write',
    resource: {
      moduleId: 'party.registry',
      resourceId: counterpartyId,
      resourceType: 'counterparty',
    },
  }));

  expect(Object.isFrozen(permission)).toBe(true);
  expect(Object.keys(permission)).toEqual(['kind']);
  expect(permission.kind).toBe('resource');
  expect('resolver' in permission).toBe(false);
});

it('accepts conjunctive business and Resource permission declarations', () => {
  const entrypoint = defineTenantModuleEntrypoint({
    access: 'write',
    authorization: { kind: 'action_execution', provisioning: 'tenant_membership_default' },
    entrypointKey: 'commerce.customer-context.change-payment-term',
    moduleKey: 'commerce.customer-context',
    role: 'action',
  });
  const permission = 'retail.settings.payment_term_preference.manage';
  const ownerPermissions = defineActionOwnerPermissions(historicalOwnerContract(permission), (_payload, scope) => [
    historicalOwnerTarget(permission, {
      kind: 'retail_profile',
      legalEntityId: scope.legalEntityId ?? '',
      profileId: 'profile-1',
      tenantId: scope.tenantId,
    }),
  ]);
  const resourcePermission = defineActionResourcePermission(() => ({
    permission: 'write',
    resource: {
      moduleId: 'commerce.customer-context',
      resourceId: 'profile-1',
      resourceType: 'retail-profile',
    },
  }));

  expect(() =>
    validateActionDescriptorInput({
      accessDeclaration: fixtureActionAccess('commerce.customer-context'),
      entrypoint,
      legalEntityScope: 'required',
      ownerPermissions,
      owningModuleKey: 'commerce.customer-context',
      policies: [],
      resourcePermission,
    }),
  ).not.toThrow();
});

it('keeps plural owner permission declarations typed, immutable and bound to the Action owner', () => {
  const scope = { legalEntityId: 'entity-1', tenantId: 'tenant-1' };
  const declaration = defineActionOwnerPermissions(fixtureOwnerContract, () => [
    ownerPermissionTarget(scope, 'existing', {
      definition: fixtureOwnerEndPermission,
      transportObjectId: 'owner-conjunction',
    }),
    ownerPermissionTarget(scope, 'proposed', {
      definition: fixtureOwnerCreatePermission,
      transportObjectId: 'owner-conjunction',
    }),
  ]);
  const entrypoint = defineTenantModuleEntrypoint({
    access: 'write',
    authorization: { kind: 'action_execution', provisioning: 'tenant_membership_default' },
    entrypointKey: 'commerce.fixture.replace',
    moduleKey: fixtureOwnerModule,
    role: 'action',
  });
  expect(Object.isFrozen(declaration)).toBe(true);
  expect(() =>
    validateActionDescriptorInput({
      accessDeclaration: fixtureActionAccess(fixtureOwnerModule),
      entrypoint,
      legalEntityScope: 'required',
      ownerPermissions: declaration,
      owningModuleKey: fixtureOwnerModule,
      policies: [],
    }),
  ).not.toThrow();
  const foreignEntrypoint = defineTenantModuleEntrypoint({
    access: 'write',
    authorization: { kind: 'action_execution', provisioning: 'tenant_membership_default' },
    entrypointKey: 'commerce.other.replace',
    moduleKey: 'commerce.other',
    role: 'action',
  });
  expect(() =>
    validateActionDescriptorInput({
      accessDeclaration: fixtureActionAccess('commerce.other'),
      entrypoint: foreignEntrypoint,
      legalEntityScope: 'required',
      ownerPermissions: declaration,
      owningModuleKey: 'commerce.other',
      policies: [],
    }),
  ).toThrow();
});

it('requires trusted Legal Entity scope for a Counterparty permission declaration', () => {
  const entrypoint = defineTenantModuleEntrypoint({
    access: 'write',
    authorization: {
      kind: 'action_execution',
      provisioning: 'tenant_membership_default',
    },
    entrypointKey: 'party.registry.create-counterparty',
    moduleKey: 'party.registry',
    role: 'action',
  });
  expect(() =>
    validateActionDescriptorInput({
      accessDeclaration: fixtureActionAccess('party.registry'),
      entrypoint,
      legalEntityPermission: 'manage_counterparty',
      legalEntityScope: 'optional',
      owningModuleKey: 'party.registry',
      policies: [],
    }),
  ).toThrow();
  expect(() =>
    validateActionDescriptorInput({
      accessDeclaration: fixtureActionAccess('party.registry'),
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
        accessDeclaration: fixtureActionAccess('core.shell'),
        accessEvidencePolicy: {
          captureMode: 'metadata_only',
          policyKey: 'cache.read.v1',
        },
        actionKey: 'shell.cache.refresh',
        auditProfile: 'minimal',
        domainErrorSchema: Schema.Never,
        domainEvents: {},
        entrypoint: defineSystemModuleEntrypoint({
          access: 'write',
          authorization: {
            kind: 'action_execution',
            provisioning: 'tenant_membership_default',
          },
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

    const payload = yield* decodeActionPayload(
      registration.descriptor.payloadSchema,
      Option.getOrUndefined(Option.none()),
    );
    const invalid = yield* Effect.flip(decodeActionPayload(registration.descriptor.payloadSchema, {}));

    expect(payload).toBeUndefined();
    expect(Predicate.isTagged(invalid, 'ActionPayloadValidationError')).toBe(true);
  }),
);

it('keeps the private handler outside the public Action registration', () => {
  const registration = defineAction(
    {
      ...counterActionDescriptor(),
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
    const error = yield* Effect.flip(decodeActionResult(Schema.Struct({ id: Schema.String }), { id: 1 }));

    expect(Predicate.isTagged(error, 'ActionResultValidationError')).toBe(true);
    expect(error.code).toBe('action_result_invalid');
  }),
);

it.effect('validates decoded DateTime and Option results through their encoded representation', () =>
  Effect.gen(function* validatesDecodedDateTimeAndOptionResultsThroughTheir() {
    const resultSchema = Schema.Struct({
      archivedAt: Schema.OptionFromNullOr(Schema.DateTimeUtcFromString),
      createdAt: Schema.DateTimeUtcFromString,
    });
    const decoded = yield* Schema.decodeEffect(resultSchema)({
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
      accessDeclaration: fixtureActionAccess('inventory.stock'),
      accessEvidencePolicy: {
        captureMode: 'metadata_only',
        policyKey: 'stock.read.v1',
      },
      actionKey: 'inventory.stock.reserve',
      auditProfile: 'standard',
      domainErrorSchema: Schema.Never,
      domainEvents: {},
      entrypoint: defineTenantModuleEntrypoint({
        access: 'write',
        authorization: {
          kind: 'action_execution',
          provisioning: 'tenant_membership_default',
        },
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
    accessDeclaration: fixtureActionAccess('inventory.stock'),
    accessEvidencePolicy: {
      captureMode: 'metadata_only',
      policyKey: 'stock.read.v1',
    },
    actionKey: 'inventory.stock.reserve',
    auditProfile: 'standard',
    domainErrorSchema: Schema.Never,
    domainEvents: {},
    entrypoint: defineTenantModuleEntrypoint({
      access: 'write',
      authorization: {
        kind: 'action_execution',
        provisioning: 'tenant_membership_default',
      },
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
  const incompatiblePayloadPolicy = defineGlobalPolicy<{
    readonly sku: string;
  }>({
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
    validateActionDescriptorInput({
      ...descriptor,
      policies: [{ ...foreignPolicy }],
    }),
  ).toThrow();
  expect(() => validateActionDescriptorInput(descriptor)).toThrow();
});

it('rejects Action entrypoint owner, scope, role/access, and forged immutability mismatches', () => {
  const registration = defineAction(
    {
      accessDeclaration: fixtureActionAccess('inventory.stock'),
      accessEvidencePolicy: {
        captureMode: 'metadata_only',
        policyKey: 'stock.read.v1',
      },
      actionKey: 'inventory.stock.reserve',
      auditProfile: 'standard',
      domainErrorSchema: Schema.Never,
      domainEvents: {},
      entrypoint: defineTenantModuleEntrypoint({
        access: 'write',
        authorization: {
          kind: 'action_execution',
          provisioning: 'tenant_membership_default',
        },
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
        authorization: {
          kind: 'action_execution',
          provisioning: 'tenant_membership_default',
        },
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
        authorization: {
          kind: 'action_execution',
          provisioning: 'tenant_membership_default',
        },
        entrypointKey: 'inventory.stock.reserve',
        moduleKey: 'inventory.stock',
        role: 'action',
      }),
    }),
  ).toThrow();
  expect(() =>
    validateActionDescriptorInput({
      accessDeclaration: fixtureActionAccess('core.modules'),
      ...registration.descriptor,
      entrypoint: defineTenantModuleEntrypoint({
        access: 'write',
        authorization: {
          kind: 'action_execution',
          provisioning: 'tenant_membership_default',
        },
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

const declaredCounterNote = (): AccessDeclarationInput => ({
  key: 'core.shell.counter.add-note',
  kind: 'action',
  modes: ['run'],
  placement: { group: 'counter', level: 'basic' },
  risk: 'routine',
  selectors: [],
});

const declaredCounter = (accessDeclaration: AccessDeclarationInput) =>
  defineAction(
    {
      ...counterActionDescriptor(),
      accessDeclaration,
      resultSchema: Schema.Struct({ total: Schema.Finite }),
    },
    (payload) => Effect.succeed({ total: payload.amount }),
  );

it('decodes and freezes the optional access declaration on the Action descriptor', () => {
  const registration = declaredCounter(declaredCounterNote());
  const declaration = registration.descriptor.accessDeclaration;
  expect(declaration?.key).toBe('core.shell.counter.add-note');
  expect(Object.isFrozen(declaration)).toBe(true);
  expect(Object.isFrozen(declaration?.placement)).toBe(true);
  expect(Object.isFrozen(registration.descriptor)).toBe(true);
});

/** One `field_write` group of the counter Action; the negative controls override one rule each. */
const declaredCounterMargins = (overrides: Partial<AccessFieldGroupInput> = {}): AccessFieldGroupInput => ({
  fieldClass: 'margins',
  fields: ['margins.amount', 'margins.currencyCode'],
  key: 'core.shell.counter.write-margins',
  kind: 'field_write',
  modes: ['run'],
  placement: { group: 'counter', level: 'manage' },
  risk: 'sensitive',
  selectors: [],
  ...overrides,
});

/** A workload Action declares no human capability at all, so its fixture strips the declaration. */
const declaredCounterWorkload = (accessWorkload: AccessWorkloadInput) => {
  const { accessDeclaration: strippedDeclaration, ...workloadCounter } = counterActionDescriptor();
  expect(strippedDeclaration.key).toBe('core.shell.counter.change');
  return defineAction(
    {
      ...workloadCounter,
      accessWorkload,
      resultSchema: Schema.Struct({ total: Schema.Finite }),
    },
    (payload) => Effect.succeed({ total: payload.amount }),
  );
};

/** The counter payload with the optional margins the field group governs. */
const counterMarginsPayloadSchema = Schema.Struct({
  amount: Schema.Finite,
  margins: Schema.optionalKey(Schema.Struct({ amount: Schema.Finite, currencyCode: Schema.String })),
});

it('decodes, validates and freezes field groups carried beside the Action declaration', () => {
  const registration = defineAction(
    {
      ...counterActionDescriptor(),
      accessDeclaration: declaredCounterNote(),
      accessFieldGroups: [declaredCounterMargins()],
      payloadSchema: counterMarginsPayloadSchema,
      resultSchema: Schema.Struct({ total: Schema.Finite }),
    },
    (payload) => Effect.succeed({ total: payload.amount }),
  );
  const groups = registration.descriptor.accessFieldGroups;
  expect(groups?.map((group) => [group.key, group.kind, group.fields])).toEqual([
    ['core.shell.counter.write-margins', 'field_write', ['margins.amount', 'margins.currencyCode']],
  ]);
  expect(Object.isFrozen(groups)).toBe(true);
  expect(Object.isFrozen(groups?.[0]?.fields)).toBe(true);

  for (const invalid of [
    // A read group cannot be carried by an Action.
    declaredCounterMargins({ kind: 'field_read' }),
    // A sensitive class demands at least sensitive risk.
    declaredCounterMargins({ risk: 'routine' }),
    // The group needs its own key inside the Action module.
    declaredCounterMargins({ key: 'core.shell.counter.add-note' }),
    declaredCounterMargins({ key: 'other.module.counter.write-margins' }),
    // Field grants are never record-scoped.
    declaredCounterMargins({ selectors: ['all'] }),
  ]) {
    expect(() =>
      defineAction(
        {
          ...counterActionDescriptor(),
          accessDeclaration: declaredCounterNote(),
          accessFieldGroups: [invalid],
          resultSchema: Schema.Struct({ total: Schema.Finite }),
        },
        (payload) => Effect.succeed({ total: payload.amount }),
      ),
    ).toThrow(AccessDeclarationError);
  }
  // Field access needs the parent record access (O58).
  const { accessDeclaration: strippedDeclaration, ...undeclaredCounter } = counterActionDescriptor();
  expect(strippedDeclaration.key).toBe('core.shell.counter.change');
  expect(() =>
    defineAction(
      {
        ...undeclaredCounter,
        accessFieldGroups: [declaredCounterMargins()],
        resultSchema: Schema.Struct({ total: Schema.Finite }),
      },
      (payload) => Effect.succeed({ total: payload.amount }),
    ),
  ).toThrow(AccessDeclarationError);
});

/** The counter Action with one margins group governing `fields` over a nested and an array payload. */
const defineWithFields = (fields: readonly string[]) =>
  defineAction(
    {
      ...counterActionDescriptor(),
      accessDeclaration: declaredCounterNote(),
      accessFieldGroups: [declaredCounterMargins({ fields })],
      payloadSchema: Schema.Struct({
        amount: Schema.Finite,
        lines: Schema.Array(Schema.Struct({ margin: Schema.optionalKey(Schema.Finite), sku: Schema.String })),
        margins: Schema.optionalKey(counterMarginsPayloadSchema.fields.margins),
      }),
      resultSchema: Schema.Struct({ total: Schema.Finite }),
    },
    (payload) => Effect.succeed({ total: payload.amount }),
  );

it('refuses a field group whose governed payload path the payload schema does not carry (O58, O74)', () => {
  // A path the payload never carries would leave the field it means ungoverned.
  expect(() => defineWithFields(['margins.percent'])).toThrow(
    'Action shell.counter.change: field group core.shell.counter.write-margins governs margins.percent, but the payload schema has no such property',
  );
  // Nested and array paths name the property inside the struct and inside every element.
  expect(() => defineWithFields(['margins.amount', 'lines.margin'])).not.toThrow();
  // A required payload field stays governable: the group refuses every payload that writes it.
  expect(() => defineWithFields(['amount', 'lines.sku'])).not.toThrow();
});

it('refuses a protected Action that declares neither a declaration nor a workload (O62)', () => {
  const { accessDeclaration: strippedDeclaration, ...bare } = counterActionDescriptor();
  expect(strippedDeclaration.key).toBe('core.shell.counter.change');
  const define = () =>
    defineAction({ ...bare, resultSchema: Schema.Struct({ total: Schema.Finite }) }, (payload) =>
      Effect.succeed({ total: payload.amount }),
    );
  expect(define).toThrow(AccessDeclarationError);
  expect(accessCarrierErrorReason(define)).toBe(
    'shell.counter.change is action_execution: a protected entrypoint must declare accessDeclaration, accessWorkload or accessActor (O62)',
  );
});

it('carries a workload marker instead of a declaration on a machine-only Action (O59)', () => {
  const registration = declaredCounterWorkload({
    reason: 'identity namespace provisioning only',
    workloads: ['core.machine-provisioner'],
  });
  expect(registration.descriptor.accessWorkload?.reason).toBe('identity namespace provisioning only');
  expect(Object.isFrozen(registration.descriptor.accessWorkload)).toBe(true);
  expect(registration.descriptor.accessDeclaration).toBeUndefined();
  expect(() => declaredCounterWorkload({ reason: '   ', workloads: ['core.machine-provisioner'] })).toThrow(
    AccessDeclarationError,
  );
  // O67-Q4: one Action may carry both paths, because they admit disjoint principals.
  const dual = defineAction(
    {
      ...counterActionDescriptor(),
      accessDeclaration: declaredCounterNote(),
      accessWorkload: {
        reason: 'the machine path provisions, the human path edits',
        workloads: ['core.machine-provisioner'],
      },
      resultSchema: Schema.Struct({ total: Schema.Finite }),
    },
    (payload) => Effect.succeed({ total: payload.amount }),
  );
  expect(dual.descriptor.accessDeclaration?.key).toBe('core.shell.counter.add-note');
  expect(dual.descriptor.accessWorkload?.reason).toBe('the machine path provisions, the human path edits');
  // A workload never carries a human field grant, not even beside a declaration.
  expect(() =>
    defineAction(
      {
        ...counterActionDescriptor(),
        accessDeclaration: declaredCounterNote(),
        accessFieldGroups: [declaredCounterMargins()],
        accessWorkload: { reason: 'machine provisioning only', workloads: ['core.machine-provisioner'] },
        resultSchema: Schema.Struct({ total: Schema.Finite }),
      },
      (payload) => Effect.succeed({ total: payload.amount }),
    ),
  ).toThrow(AccessDeclarationError);
});

const counterAccessTarget = () => ({
  moduleKey: 'core.shell.counter',
  recordKey: '6f1d5b6e-0d5b-4c1e-9f6b-2a3f0b9a4c11',
});
const counterAccessAmount = () => ({ currency: 'CZK', minor: 1200 });

it('binds accessTarget and accessAmount to the record-scoped declaration they serve (O9, O18, Q2)', () => {
  const target = counterAccessTarget;
  const amount = counterAccessAmount;
  const recordScoped = { ...declaredCounterNote(), selectors: ['assigned' as const] };
  const derivedNote = { ...declaredCounterNote(), amountInput: 'derived.totalGross' };

  const withTarget = defineAction(
    {
      ...counterActionDescriptor(),
      accessDeclaration: recordScoped,
      accessTarget: target,
      resultSchema: Schema.Struct({ total: Schema.Finite }),
    },
    (payload) => Effect.succeed({ total: payload.amount }),
  );
  expect(withTarget.descriptor.accessTarget).toBe(target);
  expect(getActionAccessTargetResolver(withTarget)).toBe(target);
  expect(getActionAccessAmountResolver(withTarget)).toBeUndefined();

  const withAmount = defineAction(
    {
      ...counterActionDescriptor(),
      accessAmount: amount,
      accessDeclaration: derivedNote,
      resultSchema: Schema.Struct({ total: Schema.Finite }),
    },
    (payload) => Effect.succeed({ total: payload.amount }),
  );
  expect(withAmount.descriptor.accessAmount).toBe(amount);
  expect(getActionAccessAmountResolver(withAmount)).toBe(amount);
  expect(getActionAccessTargetResolver(withAmount)).toBeUndefined();

  const validate = (overrides: Partial<ActionDescriptorValidationInput<never>>) => () =>
    validateActionDescriptorInput({ ...counterActionDescriptor(), ...overrides });
  const negativeControls: readonly [() => void, RegExp][] = [
    // A scope-wide capability acts on no single record (Q2).
    [validate({ accessDeclaration: declaredCounterNote(), accessTarget: target }), /record-scoped declaration/u],
    // A derived total needs the declaration that names it (O18).
    [validate({ accessAmount: amount }), /requires the declaration to declare its amountInput/u],
    // A client-supplied amount is never a ceiling input (O18).
    [
      validate({
        accessAmount: amount,
        accessDeclaration: { ...declaredCounterNote(), amountInput: 'monetaryAmount.amount' },
      }),
      /server-derived total/u,
    ],
    // Both resolvers are functions, never values (O5).
    [validate({ accessDeclaration: recordScoped, accessTarget: 'core.shell.counter' }), /resolver function/u],
    [validate({ accessAmount: 'derived.totalGross', accessDeclaration: derivedNote }), /resolver function/u],
  ];
  for (const [control, reason] of negativeControls) {
    expect(control).toThrow(reason);
  }
});

it('rejects an Action access declaration that breaks a classification rule', () => {
  const invalidDeclarations: readonly AccessDeclarationInput[] = [
    {
      key: 'core.shell.counter.delete',
      kind: 'action',
      modes: ['run'],
      placement: { group: 'counter', level: 'basic' },
      risk: 'routine',
      selectors: [],
    },
    {
      key: 'core.shell.counter.update',
      kind: 'action',
      modes: ['run'],
      placement: { group: 'counter', level: 'basic' },
      risk: 'sensitive',
      selectors: [],
    },
    {
      key: 'other.module.counter.add-note',
      kind: 'action',
      modes: ['run'],
      placement: { group: 'counter', level: 'basic' },
      risk: 'routine',
      selectors: [],
    },
  ];
  for (const accessDeclaration of invalidDeclarations) {
    expect(() => declaredCounter(accessDeclaration)).toThrow(AccessDeclarationError);
  }
});
