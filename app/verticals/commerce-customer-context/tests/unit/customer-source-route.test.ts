import { expect, it } from 'effect-rstest';
import { Effect, Exit, Option, Schema } from 'effect';
import { createActionCollector } from '../../../../packages/core-runtime/src/actions/collector.ts';
import {
  ConfigureCustomerSourceRoutePayloadSchema,
  ConfigureCustomerSourceRouteResultSchema,
} from '../../shared/domain/customer-source-route.ts';
import type { ConfigureCustomerSourceRoutePayload } from '../../shared/domain/customer-source-route.ts';
import {
  configureCustomerSourceRouteAction,
  handleConfigureCustomerSourceRoute,
} from '../../src/actions/configure-customer-source-route.action.ts';
import type {
  CustomerSourceRouteConfiguration,
  CustomerSourceRouteDecision,
} from '../../src/persistence/customer-source-route-persistence.ts';

// INTERNAL_CONTRACT only: these values are not a claim about any external system's identifiers.
const writer = '44444444-4444-4444-8444-444444444444';
const reader = 'aaaaaaaa-6666-4666-8666-66666666666a';
const invocation = '33333333-3333-4333-8333-333333333333';
const scope = {
  authMethod: 'session' as const,
  correlationId: 'correlation',
  legalEntityId: '88888888-8888-4888-8888-888888888888',
  principalId: '55555555-5555-4555-8555-555555555555',
  tenantId: '11111111-1111-4111-8111-111111111111',
};
const membership = {
  _tag: 'MEMBERSHIP',
  active: true,
  allowComplete: false,
  completenessContract: null,
  issuer: 'internal-ebs',
  principalId: writer,
  route: { id: 'internal-membership-route', revision: '1' },
  sourceNamespace: 'customer-group-memberships',
} as const;
const profile = {
  _tag: 'PROFILE',
  active: true,
  issuer: 'internal-ebs',
  mappingRevision: '1',
  namespace: 'customers',
  principalId: writer,
  recordType: 'customer',
  route: { id: 'internal-profile-route', revision: '1' },
  sourceReaderPrincipalIds: [reader],
} as const;
const decodePayload = Schema.decodeUnknownExit(ConfigureCustomerSourceRoutePayloadSchema, {
  onExcessProperty: 'error',
});
const payloadOf = (input: typeof ConfigureCustomerSourceRoutePayloadSchema.Encoded) =>
  Schema.decodeSync(ConfigureCustomerSourceRoutePayloadSchema)(input);
const resultOf = Schema.decodeUnknownSync(ConfigureCustomerSourceRouteResultSchema);

it('admits exactly one route per registry entry with every fact its owner routine compares', () => {
  expect(
    Exit.isSuccess(decodePayload({ expectedGeneration: null, reason: 'Bind the ERP route', route: membership })),
  ).toBe(true);
  for (const route of [
    profile,
    {
      _tag: 'GROUP_DEFINITION',
      active: true,
      issuer: 'internal-ebs',
      mappingRevision: '1',
      namespace: 'customer-groups',
      principalId: writer,
      route: { id: 'internal-group-route', revision: '1' },
    },
    {
      _tag: 'SAVED_ADDRESS',
      active: true,
      issuer: 'internal-ebs',
      mappingRevision: '1',
      namespace: 'customer-addresses',
      principalId: writer,
      recordType: 'address',
      route: { id: 'internal-address-route', revision: '1' },
    },
  ]) {
    expect(Exit.isSuccess(decodePayload({ expectedGeneration: 3, reason: 'Bind the ERP route', route }))).toBe(true);
    const { principalId: _omitted, ...withoutPrincipal } = route;
    expect(Exit.isFailure(decodePayload({ expectedGeneration: null, reason: 'Bind', route: withoutPrincipal }))).toBe(
      true,
    );
  }
});

it('rejects an implicit completeness claim, a duplicate reader in any case, a blank reason and a non-generation', () => {
  for (const invalid of [
    { expectedGeneration: null, reason: 'Bind', route: { ...membership, allowComplete: true } },
    { expectedGeneration: null, reason: 'Bind', route: { ...profile, sourceReaderPrincipalIds: [reader, reader] } },
    {
      expectedGeneration: null,
      reason: 'Bind',
      route: { ...profile, sourceReaderPrincipalIds: [reader, reader.toUpperCase()] },
    },
    { expectedGeneration: null, reason: '   ', route: membership },
    { expectedGeneration: 0, reason: 'Bind', route: membership },
    { expectedGeneration: 1.5, reason: 'Bind', route: membership },
    { expected: null, reason: 'Bind', route: membership },
  ]) {
    expect(Exit.isFailure(decodePayload(invalid))).toBe(true);
  }
  const complete = {
    ...membership,
    allowComplete: true,
    completenessContract: {
      coverage: 'ALL_GROUP_MEMBERSHIPS_FOR_EXACT_PROFILE',
      ref: 'internal-contract',
      revision: '1',
    },
  };
  expect(Exit.isSuccess(decodePayload({ expectedGeneration: 1, reason: 'Qualify', route: complete }))).toBe(true);
});

it('is a human-only critical administration Action that no workload or agent can run', () => {
  const { descriptor } = configureCustomerSourceRouteAction;
  expect(descriptor.accessDeclaration).toMatchObject({
    kind: 'admin',
    modes: ['run'],
    risk: 'critical',
  });
  expect(descriptor).not.toHaveProperty('accessWorkload');
  expect(descriptor.idempotency).toBe('required');
  expect(descriptor.legalEntityScope).toBe('required');
  expect(descriptor.domainEvents).toEqual({});
});

const run = (payload: ConfigureCustomerSourceRoutePayload, decision: CustomerSourceRouteDecision) =>
  Effect.gen(function* runConfiguration() {
    const collector = createActionCollector(
      configureCustomerSourceRouteAction.descriptor.domainEvents,
      'commerce.customer-context',
      configureCustomerSourceRouteAction.descriptor.accessEvidencePolicy,
      configureCustomerSourceRouteAction.descriptor.auditEvidenceSchema,
    );
    const received: CustomerSourceRouteConfiguration[] = [];
    const result = yield* handleConfigureCustomerSourceRoute(payload, {
      actionInvocationId: invocation,
      ...collector,
      compositionRevision: 'a'.repeat(64),
      scope,
      services: {
        configure: (configuration) => {
          received.push(configuration);
          return Effect.succeed(decision);
        },
      },
    });
    return { evidence: collector.snapshot(), received, result };
  });

it.effect('records the route, its generations, the outcome and the reason, and emits nothing else', () =>
  Effect.gen(function* configurationEvidence() {
    const configured = resultOf({ _tag: 'CONFIGURED', generation: 1, route: membership });
    const created = payloadOf({ expectedGeneration: null, reason: 'Bind the ERP route', route: membership });
    const first = yield* run(created, {
      currentGeneration: Option.some(1),
      previousGeneration: Option.none(),
      result: configured,
    });
    expect(first.received).toEqual([
      { actingPrincipalId: scope.principalId, actionInvocationId: invocation, payload: created },
    ]);
    expect(first.result).toEqual(configured);
    expect(first.evidence.auditEvidence).toEqual({
      currentGeneration: 1,
      outcome: 'CONFIGURED',
      reason: 'Bind the ERP route',
      routeId: 'internal-membership-route',
      routeKind: 'MEMBERSHIP',
    });
    expect(first.evidence.dataAccessEvents).toHaveLength(1);
    expect(first.evidence.dataAccessEvents[0]).toMatchObject({
      resultCount: 0,
      targetResourceId: 'internal-membership-route',
      targetResourceType: 'commerce.customer-context.customer-source-route',
    });
    expect(first.evidence.domainEvents).toEqual([]);
    expect(first.evidence.outboxMessages).toEqual([]);

    const paused = payloadOf({
      expectedGeneration: 1,
      reason: 'Pause imports',
      route: { ...membership, active: false },
    });
    const changed = yield* run(paused, {
      currentGeneration: Option.some(2),
      previousGeneration: Option.some(1),
      result: resultOf({ _tag: 'CONFIGURED', generation: 2, route: { ...membership, active: false } }),
    });
    expect(changed.evidence.auditEvidence).toMatchObject({ currentGeneration: 2, previousGeneration: 1 });
    expect(changed.evidence.dataAccessEvents[0]).toMatchObject({ resultCount: 1 });

    for (const reason of ['EXPECTATION_MISMATCH', 'PRINCIPAL_INELIGIBLE', 'SOURCE_IDENTITY_IMMUTABLE'] as const) {
      const rejected = yield* run(created, {
        currentGeneration: Option.some(2),
        previousGeneration: Option.some(2),
        result: resultOf({ _tag: 'REJECTED', currentGeneration: 2, reason }),
      });
      expect(rejected.evidence.auditEvidence).toMatchObject({
        currentGeneration: 2,
        outcome: reason,
        previousGeneration: 2,
      });
      expect(rejected.evidence.dataAccessEvents[0]).toMatchObject({ resultCount: 1 });
    }

    const absent = yield* run(paused, {
      currentGeneration: Option.none(),
      previousGeneration: Option.none(),
      result: resultOf({ _tag: 'REJECTED', currentGeneration: null, reason: 'EXPECTATION_MISMATCH' }),
    });
    expect(absent.evidence.auditEvidence).toEqual({
      outcome: 'EXPECTATION_MISMATCH',
      reason: 'Pause imports',
      routeId: 'internal-membership-route',
      routeKind: 'MEMBERSHIP',
    });
    expect(absent.evidence.dataAccessEvents[0]).toMatchObject({ resultCount: 0 });

    const unchanged = yield* run(created, {
      currentGeneration: Option.some(1),
      previousGeneration: Option.some(1),
      result: resultOf({ _tag: 'UNCHANGED', generation: 1, route: membership }),
    });
    expect(unchanged.evidence.auditEvidence).toMatchObject({ outcome: 'UNCHANGED' });
    expect(unchanged.evidence.dataAccessEvents[0]).toMatchObject({ resultCount: 1 });
  }),
);
