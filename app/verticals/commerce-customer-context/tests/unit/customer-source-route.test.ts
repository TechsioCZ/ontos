import { expect, it } from 'effect-rstest';
import { Effect, Exit, Schema } from 'effect';
import { createActionCollector } from '../../../../packages/core-runtime/src/actions/collector.ts';
import {
  ConfigureCustomerSourceRoutePayloadSchema,
  ConfigureCustomerSourceRouteResultSchema,
} from '../../shared/domain/customer-source-route.ts';
import type {
  ConfigureCustomerSourceRoutePayload,
  ConfigureCustomerSourceRouteResult,
} from '../../shared/domain/customer-source-route.ts';
import {
  configureCustomerSourceRouteAction,
  handleConfigureCustomerSourceRoute,
} from '../../src/actions/configure-customer-source-route.action.ts';

// INTERNAL_CONTRACT only: these values are not a claim about any external system's identifiers.
const writer = '44444444-4444-4444-8444-444444444444';
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
const decodePayload = Schema.decodeUnknownExit(ConfigureCustomerSourceRoutePayloadSchema, {
  onExcessProperty: 'error',
});
const payloadOf = (input: typeof ConfigureCustomerSourceRoutePayloadSchema.Encoded) =>
  Schema.decodeSync(ConfigureCustomerSourceRoutePayloadSchema)(input);

it('admits exactly one route per registry entry with every fact its owner routine compares', () => {
  expect(Exit.isSuccess(decodePayload({ expected: null, reason: 'Bind the ERP route', route: membership }))).toBe(true);
  for (const route of [
    {
      _tag: 'PROFILE',
      active: true,
      issuer: 'internal-ebs',
      mappingRevision: '1',
      namespace: 'customers',
      principalId: writer,
      recordType: 'customer',
      route: { id: 'internal-profile-route', revision: '1' },
      sourceReaderPrincipalIds: [],
    },
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
    expect(Exit.isSuccess(decodePayload({ expected: null, reason: 'Bind the ERP route', route }))).toBe(true);
    const { principalId: _omitted, ...withoutPrincipal } = route;
    expect(Exit.isFailure(decodePayload({ expected: null, reason: 'Bind', route: withoutPrincipal }))).toBe(true);
  }
});

it('rejects an implicit completeness claim, duplicate readers and a blank reason', () => {
  for (const invalid of [
    { expected: null, reason: 'Bind', route: { ...membership, allowComplete: true } },
    {
      expected: null,
      reason: 'Bind',
      route: {
        _tag: 'PROFILE',
        active: true,
        issuer: 'internal-ebs',
        mappingRevision: '1',
        namespace: 'customers',
        principalId: writer,
        recordType: 'customer',
        route: { id: 'internal-profile-route', revision: '1' },
        sourceReaderPrincipalIds: [writer, writer],
      },
    },
    { expected: null, reason: '   ', route: membership },
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
  expect(Exit.isSuccess(decodePayload({ expected: membership, reason: 'Qualify', route: complete }))).toBe(true);
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

const run = (payload: ConfigureCustomerSourceRoutePayload, outcome: ConfigureCustomerSourceRouteResult) =>
  Effect.gen(function* runConfiguration() {
    const collector = createActionCollector(
      configureCustomerSourceRouteAction.descriptor.domainEvents,
      'commerce.customer-context',
      configureCustomerSourceRouteAction.descriptor.accessEvidencePolicy,
      configureCustomerSourceRouteAction.descriptor.auditEvidenceSchema,
    );
    const received: ConfigureCustomerSourceRoutePayload[] = [];
    const result = yield* handleConfigureCustomerSourceRoute(payload, {
      actionInvocationId: '33333333-3333-4333-8333-333333333333',
      ...collector,
      compositionRevision: 'a'.repeat(64),
      scope,
      services: {
        configure: (input) => {
          received.push(input);
          return Effect.succeed(outcome);
        },
      },
    });
    return { evidence: collector.snapshot(), received, result };
  });

it.effect('records the outcome, the reason and whether a current route was read, and emits nothing else', () =>
  Effect.gen(function* configurationEvidence() {
    const route = Schema.decodeUnknownSync(ConfigureCustomerSourceRouteResultSchema)({
      _tag: 'CONFIGURED',
      route: membership,
    });
    const created = payloadOf({ expected: null, reason: 'Bind the ERP route', route: membership });
    const first = yield* run(created, route);
    expect(first.received).toEqual([created]);
    expect(first.result).toEqual(route);
    expect(first.evidence.auditEvidence).toEqual({
      outcome: 'CONFIGURED',
      reason: 'Bind the ERP route',
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

    const deactivated = payloadOf({
      expected: membership,
      reason: 'Pause imports',
      route: { ...membership, active: false },
    });
    const changed = yield* run(
      deactivated,
      Schema.decodeUnknownSync(ConfigureCustomerSourceRouteResultSchema)({
        _tag: 'CONFIGURED',
        route: { ...membership, active: false },
      }),
    );
    expect(changed.evidence.dataAccessEvents[0]).toMatchObject({ resultCount: 1 });

    const mismatch = yield* run(
      created,
      Schema.decodeUnknownSync(ConfigureCustomerSourceRouteResultSchema)({
        _tag: 'REJECTED',
        actual: { ...membership, active: false },
        reason: 'EXPECTATION_MISMATCH',
      }),
    );
    expect(mismatch.evidence.auditEvidence).toMatchObject({ outcome: 'EXPECTATION_MISMATCH' });
    expect(mismatch.evidence.dataAccessEvents[0]).toMatchObject({ resultCount: 1 });

    const absent = yield* run(
      deactivated,
      Schema.decodeUnknownSync(ConfigureCustomerSourceRouteResultSchema)({
        _tag: 'REJECTED',
        actual: null,
        reason: 'EXPECTATION_MISMATCH',
      }),
    );
    expect(absent.evidence.dataAccessEvents[0]).toMatchObject({ resultCount: 0 });

    const unchanged = yield* run(
      created,
      Schema.decodeUnknownSync(ConfigureCustomerSourceRouteResultSchema)({ _tag: 'UNCHANGED', route: membership }),
    );
    expect(unchanged.evidence.auditEvidence).toMatchObject({ outcome: 'UNCHANGED' });
    expect(unchanged.evidence.dataAccessEvents[0]).toMatchObject({ resultCount: 1 });
  }),
);
