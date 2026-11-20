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
import { customerSourceRouteRead } from '../../src/api/customer-source-route.read.ts';
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
const group = {
  _tag: 'GROUP_DEFINITION',
  active: true,
  issuer: 'internal-ebs',
  mappingRevision: '1',
  namespace: 'customer-groups',
  principalId: writer,
  route: { id: 'internal-group-route', revision: '1' },
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
    Exit.isSuccess(
      decodePayload({ _tag: 'CONFIGURE', expectedGeneration: null, reason: 'Bind the ERP route', route: membership }),
    ),
  ).toBe(true);
  for (const route of [
    profile,
    group,
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
    expect(
      Exit.isSuccess(decodePayload({ _tag: 'CONFIGURE', expectedGeneration: 3, reason: 'Bind the ERP route', route })),
    ).toBe(true);
    const { principalId: _omitted, ...withoutPrincipal } = route;
    expect(
      Exit.isFailure(
        decodePayload({ _tag: 'CONFIGURE', expectedGeneration: null, reason: 'Bind', route: withoutPrincipal }),
      ),
    ).toBe(true);
  }
  // A route with readers states them, an empty set included; the owner never assumes one.
  for (const route of [profile, group]) {
    const { sourceReaderPrincipalIds: _omitted, ...withoutReaders } = route;
    expect(
      Exit.isFailure(
        decodePayload({ _tag: 'CONFIGURE', expectedGeneration: null, reason: 'Bind', route: withoutReaders }),
      ),
    ).toBe(true);
    expect(
      Exit.isSuccess(
        decodePayload({
          _tag: 'CONFIGURE',
          expectedGeneration: null,
          reason: 'Bind',
          route: { ...route, sourceReaderPrincipalIds: [] },
        }),
      ),
    ).toBe(true);
  }
});

it('rejects an implicit completeness claim, a duplicate reader in any case, over 32 readers, a blank reason and a non-generation', () => {
  for (const invalid of [
    { _tag: 'CONFIGURE', expectedGeneration: null, reason: 'Bind', route: { ...membership, allowComplete: true } },
    ...[profile, group].flatMap((route) => [
      {
        _tag: 'CONFIGURE',
        expectedGeneration: null,
        reason: 'Bind',
        route: { ...route, sourceReaderPrincipalIds: [reader, reader] },
      },
      {
        _tag: 'CONFIGURE',
        expectedGeneration: null,
        reason: 'Bind',
        route: { ...route, sourceReaderPrincipalIds: [reader, reader.toUpperCase()] },
      },
      {
        _tag: 'CONFIGURE',
        expectedGeneration: null,
        reason: 'Bind',
        route: {
          ...route,
          sourceReaderPrincipalIds: Array.from(
            { length: 33 },
            (_, index) => `aaaaaaaa-6666-4666-8666-${index.toString(16).padStart(12, '0')}`,
          ),
        },
      },
    ]),
    { _tag: 'CONFIGURE', expectedGeneration: null, reason: '   ', route: membership },
    { _tag: 'CONFIGURE', expectedGeneration: 0, reason: 'Bind', route: membership },
    { _tag: 'CONFIGURE', expectedGeneration: 1.5, reason: 'Bind', route: membership },
    { _tag: 'CONFIGURE', expected: null, reason: 'Bind', route: membership },
    { expectedGeneration: null, reason: 'Bind', route: membership },
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
  expect(
    Exit.isSuccess(decodePayload({ _tag: 'CONFIGURE', expectedGeneration: 1, reason: 'Qualify', route: complete })),
  ).toBe(true);
});

it('pauses by route kind, route id and the generation read, and states no other route fact', () => {
  const pause = { _tag: 'PAUSE', expectedGeneration: 4, reason: 'Pause imports', routeId: 'legacy-group-route' };
  for (const routeKind of ['PROFILE', 'GROUP_DEFINITION', 'MEMBERSHIP', 'SAVED_ADDRESS']) {
    expect(Exit.isSuccess(decodePayload({ ...pause, routeKind }))).toBe(true);
  }
  for (const invalid of [
    { ...pause, routeKind: 'PRICE_GROUP' },
    { ...pause, expectedGeneration: null, routeKind: 'MEMBERSHIP' },
    { ...pause, routeId: '', routeKind: 'MEMBERSHIP' },
    { ...pause, reason: ' ', routeKind: 'MEMBERSHIP' },
    { ...pause, principalId: writer, routeKind: 'MEMBERSHIP' },
  ]) {
    expect(Exit.isFailure(decodePayload(invalid))).toBe(true);
  }
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

it('shows a stored route only to the administrators who may configure it, never to a workload or agent', () => {
  const { descriptor } = customerSourceRouteRead;
  expect(descriptor.accessDeclaration).toEqual({
    key: 'commerce.customer-context.customer-source-route.read',
    kind: 'admin',
    modes: ['run'],
    placement: {
      group: configureCustomerSourceRouteAction.descriptor.accessDeclaration?.placement.group,
      level: 'basic',
    },
    risk: 'sensitive',
    selectors: [],
  });
  expect(descriptor).not.toHaveProperty('accessWorkload');
  expect(descriptor.legalEntityScope).toBe('required');
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
    const created = payloadOf({
      _tag: 'CONFIGURE',
      expectedGeneration: null,
      reason: 'Bind the ERP route',
      route: membership,
    });
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
      _tag: 'PAUSE',
      expectedGeneration: 1,
      reason: 'Pause imports',
      routeId: 'internal-membership-route',
      routeKind: 'MEMBERSHIP',
    });
    const changed = yield* run(paused, {
      currentGeneration: Option.some(2),
      previousGeneration: Option.some(1),
      result: resultOf({ _tag: 'PAUSED', generation: 2 }),
    });
    expect(changed.received).toEqual([
      { actingPrincipalId: scope.principalId, actionInvocationId: invocation, payload: paused },
    ]);
    expect(changed.evidence.auditEvidence).toEqual({
      currentGeneration: 2,
      outcome: 'PAUSED',
      previousGeneration: 1,
      reason: 'Pause imports',
      routeId: 'internal-membership-route',
      routeKind: 'MEMBERSHIP',
    });
    expect(changed.evidence.dataAccessEvents[0]).toMatchObject({
      resultCount: 1,
      targetResourceId: 'internal-membership-route',
    });
    // A route already paused at the generation read stays as it is.
    const alreadyPaused = yield* run(paused, {
      currentGeneration: Option.some(1),
      previousGeneration: Option.some(1),
      result: resultOf({ _tag: 'PAUSED', generation: 1 }),
    });
    expect(alreadyPaused.evidence.auditEvidence).toMatchObject({ currentGeneration: 1, outcome: 'UNCHANGED' });

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
