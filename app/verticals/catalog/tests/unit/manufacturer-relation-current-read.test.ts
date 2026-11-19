import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import type { OperationalScope } from '@app/core-runtime';
import type { CallRouteRequest } from '@app/core-runtime/execution/module-call-route';
import {
  CallForbiddenSchema,
  CallNotFoundSchema,
  CallRejectedSchema,
  CallUnavailableSchema,
  RequestExecutionSchema,
  callOkSchema,
} from '@app/core-runtime/sdk';
import type { CallOutcome, RequestExecution } from '@app/core-runtime/sdk';
import { LegalEntityDetailResponseSchema } from '@app/core-runtime/sdk/core';
import { makeExecutionStandIn } from '@app/core-runtime/testing/sdk';
import { PartyDetailResponseSchema, partyDetailOperation } from '@app/party-registry/api/party-detail';
import type { PartyDetailResponse } from '@app/party-registry/api/party-detail';
import { GatewayDelegationSourceError } from '@app/shared-contracts/gateway-context-server';
import type { GatewayDelegationRequest } from '@app/shared-contracts/gateway-context-server';
import { makeModuleCallRoute } from '@app/shared-contracts/server/sdk-module-call-route';
import { DateTime, Effect, Predicate, Schema } from 'effect';
import { HttpClient } from 'effect/http';
import { describe, expect, it } from 'effect-rstest';

import {
  manufacturerRelationCurrentCalls,
  runManufacturerRelationCurrent,
} from '../../src/api/manufacturer-relation-current.read.ts';
import type { ManufacturerRelationCurrentRunContext } from '../../src/api/manufacturer-relation-current.read.ts';
import type { ManufacturerRelationCurrentRequest } from '../../shared/apis/manufacturer-relation-current.ts';
import { manufacturerRelationRevisions, manufacturerRelations, products } from '../../src/database/schema.ts';
import { manufacturerCurrentReadsForScope } from '../../src/persistence/manufacturer-current-reads.ts';
import { catalogRuntimeManifest } from '../../vertical.runtime-declaration.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const productId = '33333333-3333-4333-8333-333333333333';
const relationId = '55555555-5555-4555-8555-555555555555';
const legalEntityId = '66666666-6666-4666-8666-666666666666';
const partyId = '77777777-7777-4777-8777-777777777777';
const canonicalPartyId = '88888888-8888-4888-8888-888888888888';
const at = '2026-09-17T00:00:00.000Z';
const productRef = {
  moduleId: 'commerce.catalog',
  resourceId: productId,
  resourceType: 'commerce.catalog.product',
  tenantId,
} as const;
const legalEntityRef = {
  moduleId: 'core.identity',
  resourceId: legalEntityId,
  resourceType: 'core.identity.legal-entity',
  tenantId,
} as const;
const partyRef = (resourceId: string) =>
  ({ moduleId: 'party.registry', resourceId, resourceType: 'party.registry.party', tenantId }) as const;
const sessionPrincipal = Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
  authBindingId: '99999999-9999-4999-8999-999999999999',
  authContextRef: 'session:manufacturer-current',
  authMethod: 'session',
  legalEntityId,
  principalId: '22222222-2222-4222-8222-222222222222',
  tenantId,
});
const systemPrincipal = Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
  authContextRef: 'job:manufacturer-current:run:1',
  authMethod: 'system',
  principalId: '22222222-2222-4222-8222-222222222222',
  tenantId,
});
const scope: OperationalScope = { ...sessionPrincipal, correlationId: 'manufacturer-current-read' };

const head = {
  currentRevision: 1,
  disposition: 'CONFIRMED',
  effectiveFrom: null,
  effectiveTo: null,
  evidenceRefs: ['record:maker'],
  productId,
  reason: 'Verified manufacturer',
  relationId,
  targetId: legalEntityId,
  targetKind: 'LEGAL_ENTITY',
  tenantId,
  variantId: null,
};
const revisionRow = (revision: number, overrides: Partial<typeof head> = {}) => ({
  ...head,
  ...overrides,
  actingPrincipalId: scope.principalId,
  actionInvocationId: '44444444-4444-4444-8444-444444444444',
  currentRevision: revision,
  recordedAt: new Date(at),
  revision,
});
const partyHead = { ...head, targetId: partyId, targetKind: 'PARTY' };

type Table = typeof products | typeof manufacturerRelations | typeof manufacturerRelationRevisions;
type Rows = Map<Table, object[]>;
const mock = (rows: Rows) => ({
  select: () => ({
    from: (table: Table) => {
      const result = () => Effect.succeed(rows.get(table) ?? []);
      return { where: () => ({ limit: result, pipe: result }) };
    },
  }),
});
const rowsFor = (relationHead: typeof head) =>
  new Map<Table, object[]>([
    [products, [{ productId, tenantId }]],
    [manufacturerRelations, [relationHead]],
    [manufacturerRelationRevisions, [revisionRow(1, relationHead)]],
  ]);

type LegalEntityDetail = typeof LegalEntityDetailResponseSchema.Type;
const legalEntityAnswer = (status: LegalEntityDetail['status']): CallOutcome<LegalEntityDetail> =>
  callOkSchema(LegalEntityDetailResponseSchema).make({ value: { legalEntityRef, status } });
const partyAnswer = (): CallOutcome<PartyDetailResponse> =>
  callOkSchema(PartyDetailResponseSchema).make({
    value: Schema.decodeSync(PartyDetailResponseSchema)({
      currentFactAssertions: [],
      party: {
        archivedAt: null,
        businessName: 'Maker',
        createdAt: '2026-09-01T00:00:00.000Z',
        displayName: 'Maker',
        firstName: null,
        lastName: null,
        partyRef: partyRef(canonicalPartyId),
        partyType: 'ORGANIZATION',
        revision: 4,
        updatedAt: '2026-09-02T00:00:00.000Z',
      },
      resolution: {
        aliasChain: [partyRef(partyId)],
        canonicalPartyRef: partyRef(canonicalPartyId),
        kind: 'ALIAS',
        requestedPartyRef: partyRef(partyId),
      },
    }),
  });

interface Fixture {
  readonly legalEntity?: CallOutcome<LegalEntityDetail>;
  readonly party?: CallOutcome<PartyDetailResponse>;
  /** The Catalog rows each transaction sees, by its sequence (1, 2, ...); the last one repeats. */
  readonly rows: readonly Rows[];
}

/** Drives the read's `run` with Core's stand-ins, which die on a call while a transaction is open. */
const harness = (fixture: Fixture) => {
  const standIn = makeExecutionStandIn(manufacturerRelationCurrentCalls, {
    answers: {
      legalEntityDetail: () => Effect.succeed(fixture.legalEntity ?? legalEntityAnswer('active')),
      partyDetail: () => Effect.succeed(fixture.party ?? partyAnswer()),
    },
    operationAt: DateTime.makeUnsafe(at),
    services: (sequence) =>
      // @ts-expect-error Mock implements only exercised query chains.
      manufacturerCurrentReadsForScope(mock(fixture.rows[sequence - 1] ?? fixture.rows.at(-1)), scope),
  });
  const context: ManufacturerRelationCurrentRunContext = {
    access: {},
    call: standIn.call,
    execution: {
      compositionRevision: 'composition-revision-1',
      identity: RequestExecutionSchema.make({ via: 'person' }),
      operationKey: 'commerce.catalog.api.manufacturer-relation-current',
      owningModuleKey: 'commerce.catalog',
    },
    readKey: 'commerce.catalog.api.manufacturer-relation-current',
    scope,
    transaction: standIn.transaction,
  };
  return {
    run: (subject: ManufacturerRelationCurrentRequest['subject'] = productRef) =>
      runManufacturerRelationCurrent({ subject }, context),
    steps: () =>
      standIn.steps.map((step) => (step.kind === 'call' ? { input: step.input, name: step.name } : step.kind)),
  };
};

describe('Manufacturer Current relation read', () => {
  it.effect('reads the relation, calls the owner with no transaction open, then rechecks the same revision', () =>
    Effect.gen(function* callOutsideTransaction() {
      const fixture = harness({ rows: [rowsFor(head)] });
      const answer = yield* fixture.run();
      expect(answer.result).toMatchObject({
        claim: { relationId, revision: 1, subject: productRef, target: { kind: 'LEGAL_ENTITY', legalEntityRef } },
        owner: { canonicalTarget: { kind: 'LEGAL_ENTITY', legalEntityRef }, kind: 'LEGAL_ENTITY', state: 'CURRENT' },
      });
      expect(answer.evidence).toEqual({ resultCount: 1 });
      expect(fixture.steps()).toEqual([
        'begin',
        'end',
        { input: { legalEntityRef }, name: 'legalEntityDetail' },
        'begin',
        'end',
      ]);
    }),
  );

  it.effect('resolves a Party target through Party Registry with its owner revision and alias', () =>
    Effect.gen(function* partyTarget() {
      const fixture = harness({ rows: [rowsFor(partyHead)] });
      const answer = yield* fixture.run();
      expect(answer.result.owner).toEqual({
        canonicalTarget: { kind: 'PARTY', partyRef: partyRef(canonicalPartyId) },
        kind: 'PARTY',
        ownerRevision: 4,
        state: 'ALIAS',
      });
      expect(answer.result.claim.target).toEqual({ kind: 'PARTY', partyRef: partyRef(partyId) });
      expect(fixture.steps()).toEqual([
        'begin',
        'end',
        { input: { partyRef: partyRef(partyId) }, name: 'partyDetail' },
        'begin',
        'end',
      ]);
    }),
  );

  it.effect('keeps the managed Legal Entity lifecycle the owner answers', () =>
    Effect.gen(function* lifecycle() {
      for (const [status, state] of [
        ['active', 'CURRENT'],
        ['suspended', 'SUSPENDED'],
        ['archived', 'ARCHIVED'],
      ] as const) {
        const answer = yield* harness({ legalEntity: legalEntityAnswer(status), rows: [rowsFor(head)] }).run();
        expect(answer.result.owner).toMatchObject({ kind: 'LEGAL_ENTITY', state });
      }
    }),
  );

  it.effect('keeps owner absence, denial, and unavailability distinct', () =>
    Effect.gen(function* failures() {
      for (const [outcome, expected] of [
        [CallNotFoundSchema.make({ reason: 'absent' }), 'ReadHandlerNotFound'],
        [CallForbiddenSchema.make({ reason: 'denied' }), 'ReadPermissionDenied'],
        [CallRejectedSchema.make({ code: 'conflict', reason: 'rejected' }), 'ReadHandlerUnavailable'],
        [CallUnavailableSchema.make({ reason: 'down', retryable: true }), 'ReadHandlerUnavailable'],
      ] as const) {
        for (const fixture of [
          harness({ legalEntity: outcome, rows: [rowsFor(head)] }),
          harness({ party: outcome, rows: [rowsFor(partyHead)] }),
        ]) {
          const failure = yield* Effect.flip(fixture.run());
          expect(Predicate.isTagged(failure, expected)).toBe(true);
          // The refusal is rechecked against the same relation revision before it is answered.
          expect(fixture.steps().filter((step) => step === 'begin')).toHaveLength(2);
        }
      }
    }),
  );

  it.effect('is unavailable, not the owner refusal, when the relation revision changed meanwhile', () =>
    Effect.gen(function* refusalSuperseded() {
      const later = rowsFor({ ...head, currentRevision: 2 });
      later.set(manufacturerRelationRevisions, [revisionRow(1), revisionRow(2)]);
      for (const outcome of [
        CallNotFoundSchema.make({ reason: 'absent' }),
        CallForbiddenSchema.make({ reason: 'denied' }),
      ]) {
        const fixture = harness({ legalEntity: outcome, rows: [rowsFor(head), later] });
        const failure = yield* Effect.flip(fixture.run());
        expect(Predicate.isTagged(failure, 'ReadHandlerUnavailable')).toBe(true);
        expect(fixture.steps()).toHaveLength(5);
      }
    }),
  );

  it.effect('rejects a contradictory owner answer as unavailable', () =>
    Effect.gen(function* contradictory() {
      const other = callOkSchema(LegalEntityDetailResponseSchema).make({
        value: { legalEntityRef: { ...legalEntityRef, resourceId: relationId }, status: 'active' },
      });
      const failure = yield* Effect.flip(harness({ legalEntity: other, rows: [rowsFor(head)] }).run());
      expect(Predicate.isTagged(failure, 'ReadHandlerUnavailable')).toBe(true);
    }),
  );

  it.effect('is unavailable when the relation revision changed while the owner answered', () =>
    Effect.gen(function* superseded() {
      const later = rowsFor({ ...head, currentRevision: 2 });
      later.set(manufacturerRelationRevisions, [revisionRow(1), revisionRow(2)]);
      const fixture = harness({ rows: [rowsFor(head), later] });
      const failure = yield* Effect.flip(fixture.run());
      expect(Predicate.isTagged(failure, 'ReadHandlerUnavailable')).toBe(true);
      expect(fixture.steps()).toHaveLength(5);
    }),
  );

  it.effect('is unavailable when the relation ended while the owner answered', () =>
    Effect.gen(function* ended() {
      const removed = rowsFor(head);
      removed.set(manufacturerRelations, []);
      const failure = yield* Effect.flip(harness({ rows: [rowsFor(head), removed] }).run());
      expect(Predicate.isTagged(failure, 'ReadHandlerUnavailable')).toBe(true);
    }),
  );

  it.effect('makes no call for an absent relation, a conflict, or a foreign subject', () =>
    Effect.gen(function* noCall() {
      const absent = rowsFor(head);
      absent.set(manufacturerRelations, []);
      const absentRun = harness({ rows: [absent] });
      expect(Predicate.isTagged(yield* Effect.flip(absentRun.run()), 'ReadHandlerNotFound')).toBe(true);
      expect(absentRun.steps()).toEqual(['begin', 'end']);

      const conflicting = rowsFor(head);
      conflicting.set(manufacturerRelationRevisions, [revisionRow(1, { ...head, targetId: 'wrong' })]);
      const conflictRun = harness({ rows: [conflicting] });
      expect(Predicate.isTagged(yield* Effect.flip(conflictRun.run()), 'ReadHandlerUnavailable')).toBe(true);
      expect(conflictRun.steps()).toEqual(['begin', 'end']);

      const foreign = harness({ rows: [rowsFor(head)] });
      const foreignFailure = yield* Effect.flip(
        foreign.run({ ...productRef, tenantId: '99999999-9999-4999-8999-999999999999' }),
      );
      expect(Predicate.isTagged(foreignFailure, 'ReadHandlerNotFound')).toBe(true);
      expect(foreign.steps()).toEqual([]);
    }),
  );
});

/**
 * The identity the Party call carries. The hand-built resolver this read used before sent, for every
 * caller kind, the requester's own scope as an `Assertion` to `party-registry` under its selected Legal
 * Entity (`legalEntityScope: 'subject'`), correlated by the request. The requirement now permits only
 * that `person` caller and declares no registered caller, so Core relays every request kind as the
 * person; the module route then asks the gateway for exactly the delegation the hand code asked for.
 */
describe('Manufacturer Current relation caller identity', () => {
  it('permits only the relayed requester under its selected Legal Entity', () => {
    const requirement = catalogRuntimeManifest.requirements?.operations.find(
      ({ key }) => key === manufacturerRelationCurrentCalls.partyDetail.requirementKey,
    );
    expect(requirement?.callers).toEqual([{ kind: 'person', legalEntityScope: 'subject' }]);
    const coreRequirement = catalogRuntimeManifest.requirements?.operations.find(
      ({ key }) => key === manufacturerRelationCurrentCalls.legalEntityDetail.requirementKey,
    );
    expect(coreRequirement?.callers).toBeUndefined();
    expect(coreRequirement?.provider).toEqual(manufacturerRelationCurrentCalls.legalEntityDetail.operation.provider);
  });

  const callerKinds: readonly (readonly [RequestExecution['via'], typeof sessionPrincipal])[] = [
    ['person', sessionPrincipal],
    ['workload', sessionPrincipal],
    ['recovery', sessionPrincipal],
    ['system', systemPrincipal],
  ];
  for (const [via, principal] of callerKinds) {
    it.effect(`delegates a ${via} request exactly as the hand-built resolver did`, () =>
      Effect.gen(function* delegation() {
        const delegations: GatewayDelegationRequest[] = [];
        const route = yield* makeModuleCallRoute({
          acquire: (request) => {
            delegations.push(request);
            return Effect.fail(new GatewayDelegationSourceError({ reason: 'test stops before HTTP' }));
          },
        }).pipe(
          Effect.provideService(
            HttpClient.HttpClient,
            HttpClient.make(() => Effect.die('no HTTP')),
          ),
        );
        const executionScope = { ...principal, correlationId: `manufacturer-current-${via}` };
        const request: CallRouteRequest = {
          caller: { kind: 'person', legalEntityScope: 'subject' },
          encodedInput: { partyRef: partyRef(partyId) },
          execution: {
            callerSource: { _tag: 'RequestPrincipal', principal },
            facts: {
              compositionRevision: 'composition-revision-1',
              identity: RequestExecutionSchema.make({ via }),
              operationKey: 'commerce.catalog.api.manufacturer-relation-current',
              owningModuleKey: 'commerce.catalog',
            },
            scope: executionScope,
          },
          operation: partyDetailOperation,
          requirement: {
            callers: [{ kind: 'person', legalEntityScope: 'subject' }],
            compositionRevision: 'composition-revision-1',
            consumerAppId: 'catalog',
            provider: partyDetailOperation.provider,
            providerAppId: 'party-registry',
            requirementKey: manufacturerRelationCurrentCalls.partyDetail.requirementKey,
          },
        };
        yield* route.send(request);
        expect(delegations).toEqual([
          {
            audience: 'party-registry',
            // Demo: the delegation names the calling app, whose own module credential authenticates it.
            callingAppId: 'catalog',
            legalEntityScope: 'subject',
            requestCorrelation: executionScope.correlationId,
            subject: { _tag: 'Assertion', scope: principal },
          },
        ]);
      }),
    );
  }
});
