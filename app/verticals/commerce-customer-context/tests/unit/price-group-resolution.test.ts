/* eslint-disable effect-native/no-manual-tag-comparison -- Resolution tests assert all four exact public discriminants and evidence payloads; expires: 2027-03-01. */
import { expect, it } from 'effect-rstest';
import { DateTime, Effect, Exit, Option, Schema } from 'effect';
import type { CallOutcome } from '@app/core-runtime/sdk';
import { PriceGroupCompatibilityDecisionSchema } from '@app/price-group-catalog-contracts';
import type { PriceGroupCompatibilityDecision } from '@app/price-group-catalog-contracts';
import type { ValidatePriceGroupCompatibilityRequest } from '@app/price-group-catalog-contracts/validate-price-group-compatibility';
import { AssignCustomerPriceGroupPayloadSchema } from '../../src/actions/assign-customer-price-group.action.ts';
import {
  customerPriceGroupAssignmentReadRead,
  readCustomerPriceGroupAssignments,
} from '../../src/api/customer-price-group-assignment-read.read.ts';
import {
  customerPriceGroupResolutionRead,
  resolveCustomerPriceGroup,
} from '../../src/api/customer-price-group-resolution.read.ts';
import type {
  CustomerPriceGroupResolutionServices,
  CustomerPriceGroupResolutionSteps,
} from '../../src/api/customer-price-group-resolution.read.ts';
import { priceGroupCatalogPortFromCall } from '../../src/integrations/price-group-catalog.ts';
import type { CustomerPriceGroupResolutionRequest } from '../../shared/apis/customer-price-group-resolution.ts';
import {
  CustomerPriceGroupResolutionRequestSchema,
  CustomerPriceGroupResolutionResponseSchema,
  customerPriceGroupResolutionPredicateRef,
} from '../../shared/apis/customer-price-group-resolution.ts';
import type {
  CustomerPriceGroupAssignment,
  PriceGroupCatalogOutcome,
  PriceGroupRef,
} from '../../shared/domain/price-group-contracts.ts';
import { CustomerPriceGroupCatalogUnavailable } from '../../shared/domain/price-group-errors.ts';
import type {
  CustomerPriceGroupAssignmentStorePort,
  PriceGroupCatalogPort,
} from '../../shared/domain/price-group-ports.ts';
import { CUSTOMER_PRICE_GROUP_COMPATIBILITY_CONTRACT } from '../../shared/domain/price-group-ports.ts';
import { resolveCustomerPriceGroupAt } from '../../shared/domain/price-group-resolution.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const requestedEffectiveAt = '2026-02-15T00:00:00.000Z';
const observedAt = '2026-03-01T00:00:00.000Z';
const profile = {
  kind: 'RETAIL',
  moduleId: 'commerce.customer-context',
  resourceId: 'retail-profile-1',
  resourceType: 'commerce.customer-context.retail-customer-profile',
  tenantId,
} as const;
const priceGroupRef: PriceGroupRef = {
  moduleId: 'pricing.price-group-catalog',
  resourceId: '33333333-3333-4333-8333-333333333333',
  resourceType: 'pricing.price-group-catalog.price-group',
  tenantId,
};
const counterpartyRef = {
  moduleId: 'party.registry',
  resourceId: 'counterparty-1',
  resourceType: 'party.registry.counterparty',
  tenantId,
} as const;
const counterpartyProfile = {
  kind: 'COUNTERPARTY',
  moduleId: 'commerce.customer-context',
  resourceId: 'counterparty-profile-1',
  resourceType: 'commerce.customer-context.counterparty-purchasing-profile',
  tenantId,
} as const;
const compatibility = {
  catalogRevision: 7,
  definitionEffectivePeriod: {
    effectiveFrom: '2026-01-01T00:00:00.000Z',
    effectiveTo: null,
  },
  definitionRevisionId: '44444444-4444-4444-8444-444444444444',
  definitionRevisionNumber: 4,
  meaningFingerprint: 'a'.repeat(64),
  priceGroupRef,
  requiredContract: {
    contractId: CUSTOMER_PRICE_GROUP_COMPATIBILITY_CONTRACT,
    version: 1,
  },
  trustedOperationAt: '2026-03-01T00:00:00.000Z',
  verifiedAt: '2026-03-01T00:00:01.000Z',
} as const;

const assignment = (
  resourceId: string,
  effectiveFrom = '2026-01-01T00:00:00.000Z',
  effectiveTo: string | null = null,
): CustomerPriceGroupAssignment => ({
  assignmentRef: {
    moduleId: 'commerce.customer-context',
    resourceId,
    resourceType: 'commerce.customer-context.customer-price-group-assignment',
    tenantId,
  },
  compatibility,
  effectiveFrom,
  effectiveTo,
  priceGroupRef,
  profile,
  reason: 'Contracted customer pricing',
  recordedAt: '2026-01-01T00:00:00.000Z',
  revision: 1,
  state: 'ACTIVE',
});

const catalog = (outcome: PriceGroupCatalogOutcome): PriceGroupCatalogPort => ({
  resolveCurrent: () => Effect.succeed(outcome),
});
interface RunTrace {
  readonly calls: ValidatePriceGroupCompatibilityRequest[];
  /** Each step of a run as the read sees it: a transaction begins or ends, or a call is made. */
  readonly events: string[];
  /** How many transactions were open when each call was made. */
  readonly openAtCall: number[];
}
type CatalogAnswer = (
  payload: ValidatePriceGroupCompatibilityRequest,
) => Effect.Effect<CallOutcome<PriceGroupCompatibilityDecision>>;

const noCall: CatalogAnswer = () => Effect.die('the Catalog must not be called');

/**
 * Runs the read's resolution against stand-ins of Core's two capabilities that keep Core's bookkeeping:
 * every transaction gets `services(sequence)`, and every call, through the read's real Catalog adapter
 * over `call`, records how many transactions were open.
 */
const runResolution = (
  request: CustomerPriceGroupResolutionRequest,
  services: (sequence: number) => CustomerPriceGroupResolutionServices,
  answer: CatalogAnswer = noCall,
) => {
  const trace: RunTrace = { calls: [], events: [], openAtCall: [] };
  let open = 0;
  let sequence = 0;
  const transaction: CustomerPriceGroupResolutionSteps['transaction'] = (body) =>
    Effect.suspend(() => {
      open += 1;
      sequence += 1;
      trace.events.push('begin');
      return body(services(sequence), { operationAt: DateTime.makeUnsafe(observedAt), sequence });
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          open -= 1;
          trace.events.push('end');
        }),
      ),
    );
  const catalogOverCall = priceGroupCatalogPortFromCall((payload) =>
    Effect.suspend(() => {
      trace.events.push('call');
      trace.openAtCall.push(open);
      trace.calls.push(payload);
      return answer(payload);
    }),
  );
  return Effect.exit(resolveCustomerPriceGroup(request, tenantId, { catalog: catalogOverCall, transaction })).pipe(
    Effect.map((exit) => ({ exit, trace })),
  );
};
const sameServices =
  (services: CustomerPriceGroupResolutionServices) =>
  (_sequence: number): CustomerPriceGroupResolutionServices =>
    services;
const currentProfile = {
  inspect: () => Effect.succeed({ _tag: 'CURRENT', counterpartyRef: null, revision: 1, state: 'ACTIVE' } as const),
};
const usableDecision = (trustedOperationAt: string) =>
  Schema.decodeUnknownSync(PriceGroupCompatibilityDecisionSchema)({
    evidence: { ...compatibility, trustedOperationAt },
    kind: 'USABLE',
  });

const unavailableStore = () => Effect.die('store must not run after profile not-found');
const unreachableStore: CustomerPriceGroupAssignmentStorePort = {
  assign: unavailableStore,
  list: unavailableStore,
  migrate: unavailableStore,
  remove: unavailableStore,
  resolve: unavailableStore,
};

it.effect('resolves NONE only when there is no current temporal assignment', () =>
  Effect.gen(function* noCurrentAssignment() {
    const result = yield* resolveCustomerPriceGroupAt(
      profile,
      [assignment('past', '2026-01-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z')],
      '2026-03-01T00:00:00.000Z',
      catalog({ _tag: 'MISSING' }),
    );
    expect(result).toEqual({ _tag: 'NONE' });
  }),
);

it.effect('returns ASSIGNED with fresh compatibility evidence from the Pricing catalog', () =>
  Effect.gen(function* assignedResolution() {
    let catalogEffectiveAt = '';
    const result = yield* resolveCustomerPriceGroupAt(profile, [assignment('current')], '2026-03-01T00:00:00.000Z', {
      resolveCurrent: (_ref, _contract, effectiveAt) => {
        catalogEffectiveAt = effectiveAt;
        return Effect.succeed({ _tag: 'USABLE', compatibility, priceGroupRef });
      },
    });
    expect(catalogEffectiveAt).toBe('2026-03-01T00:00:00.000Z');
    expect(result._tag).toBe('ASSIGNED');
    if (result._tag === 'ASSIGNED') {
      expect(result.compatibility.catalogRevision).toBe(7);
      expect(result.priceGroupRef).toEqual(priceGroupRef);
    }
  }),
);

it.effect('threads one trusted Read instant and exact Counterparty association through inspection', () =>
  Effect.gen(function* timedCounterpartyInspection() {
    const inspected: unknown[][] = [];
    const profileValidation = {
      inspect: (...input: unknown[]) => {
        inspected.push(input);
        return Effect.succeed({ _tag: 'NOT_FOUND' } as const);
      },
    };
    const now = Effect.succeed('2026-03-01T00:00:00.000Z');
    const request = {
      authorizationSubject: { counterpartyRef, kind: 'COUNTERPARTY' as const },
      profile: counterpartyProfile,
    };
    yield* Effect.exit(
      readCustomerPriceGroupAssignments(request, tenantId, {
        now,
        profileValidation,
        store: unreachableStore,
      }),
    );
    const { trace } = yield* runResolution(
      { ...request, effectiveAt: requestedEffectiveAt },
      sameServices({ now, profileValidation, store: unreachableStore }),
    );
    expect(trace.calls).toEqual([]);
    expect(inspected).toEqual([
      [counterpartyProfile, '2026-03-01T00:00:00.000Z', counterpartyRef],
      [counterpartyProfile, requestedEffectiveAt, counterpartyRef],
    ]);
  }),
);

it.effect('resolves from the dedicated current-at lookup instead of capped history', () =>
  Effect.gen(function* dedicatedCurrentLookup() {
    const resolvedAt: string[] = [];
    const { exit } = yield* runResolution(
      {
        authorizationSubject: { kind: 'RETAIL' },
        effectiveAt: requestedEffectiveAt,
        profile,
      },
      sameServices({
        now: Effect.succeed(observedAt),
        profileValidation: currentProfile,
        store: {
          ...unreachableStore,
          resolve: (_profile, effectiveAt) => {
            resolvedAt.push(effectiveAt);
            return Effect.succeed({ _tag: 'found', assignments: [] });
          },
        },
      }),
    );
    // The snapshot and its recheck both read the set at the one requested instant.
    expect(resolvedAt).toEqual([requestedEffectiveAt, requestedEffectiveAt]);
    expect(Exit.isSuccess(exit)).toBe(true);
    if (!Exit.isSuccess(exit)) {
      return;
    }
    const { evidence, result } = exit.value;
    expect(evidence).toEqual({ resultCount: 0 });
    expect(result.effectiveAt).toBe(requestedEffectiveAt);
    expect(result.observedAt).toBe(observedAt);
    expect(result.resolution).toEqual({ _tag: 'NONE' });
    expect(result.completenessEvidence).toEqual({
      observedAt,
      ownerRevision: result.generation,
      scope: {
        kind: 'EXACT_PREDICATE',
        predicateRef: customerPriceGroupResolutionPredicateRef(profile, requestedEffectiveAt),
      },
    });
    expect(result.currentnessEvidence).toMatchObject({
      evaluatedAt: result.effectiveAt,
      generation: result.generation,
      observedAt: result.observedAt,
      ownerRevision: result.generation,
      revalidatedAt: result.observedAt,
      verificationMode: 'OWNER_CURRENT_SET_REVALIDATED',
    });
    expect(result.verificationReceipt).toMatchObject({
      generation: result.generation,
      issuedAt: result.observedAt,
      ownerModuleId: 'commerce.customer-context',
      ownerRevision: result.generation,
    });
    expect(result.verificationReceipt.verificationRef).toContain(
      'commerce.customer-context.customer-price-group.verification:v1:sha256:',
    );
    expect(Schema.is(CustomerPriceGroupResolutionResponseSchema)(result)).toBe(true);
  }),
);

it.effect('rejects owner evidence that echoes another Profile predicate or generation', () =>
  Effect.gen(function* ownerEvidenceBinding() {
    const request = {
      authorizationSubject: { kind: 'RETAIL' },
      effectiveAt: requestedEffectiveAt,
      profile,
    } as const;
    const empty = yield* runResolution(
      request,
      sameServices({
        now: Effect.succeed('2026-03-01T00:00:00.000Z'),
        profileValidation: currentProfile,
        store: { ...unreachableStore, resolve: () => Effect.succeed({ _tag: 'found', assignments: [] }) },
      }),
    );
    const assigned = yield* runResolution(
      request,
      sameServices({
        now: Effect.succeed('2026-03-01T00:00:00.000Z'),
        profileValidation: currentProfile,
        store: {
          ...unreachableStore,
          resolve: () => Effect.succeed({ _tag: 'found', assignments: [assignment('authoritative-current')] }),
        },
      }),
      () => Effect.succeed({ _tag: 'Ok', value: usableDecision(requestedEffectiveAt) }),
    );
    expect(Exit.isSuccess(empty.exit) && Exit.isSuccess(assigned.exit)).toBe(true);
    if (!Exit.isSuccess(empty.exit) || !Exit.isSuccess(assigned.exit)) {
      return;
    }
    const { result } = empty.exit.value;
    const assignedResult = assigned.exit.value.result;
    expect(assignedResult.resolution._tag).toBe('ASSIGNED');
    expect(assignedResult.generation).not.toBe(result.generation);
    expect(assignedResult.verificationReceipt.verificationRef).not.toBe(result.verificationReceipt.verificationRef);
    expect(
      Schema.is(CustomerPriceGroupResolutionResponseSchema)({
        ...result,
        completenessEvidence: {
          ...result.completenessEvidence,
          scope: { kind: 'EXACT_PREDICATE', predicateRef: 'caller-echoed-profile' },
        },
      }),
    ).toBe(false);
    expect(
      Schema.is(CustomerPriceGroupResolutionResponseSchema)({
        ...result,
        verificationReceipt: { ...result.verificationReceipt, generation: 'caller-generation' },
      }),
    ).toBe(false);
  }),
);

it.effect('calls the Catalog only between the snapshot and the recheck transactions, never inside one', () =>
  Effect.gen(function* callOutsideTransaction() {
    const { exit, trace } = yield* runResolution(
      { authorizationSubject: { kind: 'RETAIL' }, effectiveAt: requestedEffectiveAt, profile },
      sameServices({
        now: Effect.succeed(observedAt),
        profileValidation: currentProfile,
        store: {
          ...unreachableStore,
          resolve: () => Effect.succeed({ _tag: 'found', assignments: [assignment('current')] }),
        },
      }),
      () => Effect.succeed({ _tag: 'Ok', value: usableDecision(requestedEffectiveAt) }),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(trace.events).toEqual(['begin', 'end', 'call', 'begin', 'end']);
    expect(trace.openAtCall).toEqual([0]);
    expect(trace.calls).toEqual([
      {
        priceGroupRef,
        requiredContract: { contractId: CUSTOMER_PRICE_GROUP_COMPATIBILITY_CONTRACT, version: 1 },
        trustedOperationAt: requestedEffectiveAt,
      },
    ]);
  }),
);

it.effect('answers unavailable, never NONE or a stale answer, when the Catalog or the owner set fails it', () =>
  Effect.gen(function* failedResolution() {
    const request = { authorizationSubject: { kind: 'RETAIL' }, effectiveAt: requestedEffectiveAt, profile } as const;
    const services = sameServices({
      now: Effect.succeed(observedAt),
      profileValidation: currentProfile,
      store: {
        ...unreachableStore,
        resolve: () => Effect.succeed({ _tag: 'found', assignments: [assignment('current')] }),
      },
    });
    for (const outcome of [
      { _tag: 'Unavailable', reason: 'Catalog down', retryable: true },
      { _tag: 'Forbidden', reason: 'Catalog refused the caller' },
      { _tag: 'NotFound', reason: 'Catalog operation missing' },
      { _tag: 'Rejected', code: 'invalid', reason: 'Catalog rejected the request' },
    ] as const) {
      const { exit, trace } = yield* runResolution(request, services, () => Effect.succeed(outcome));
      expect(trace.events).toEqual(['begin', 'end', 'call']);
      expect(Option.getOrUndefined(Exit.findErrorOption(exit))).toMatchObject({ code: 'read_handler_unavailable' });
    }

    // The assignment set changed while the Catalog answered: the recheck refuses to release the answer.
    const changed = yield* runResolution(
      request,
      (sequence) => ({
        now: Effect.succeed(observedAt),
        profileValidation: currentProfile,
        store: {
          ...unreachableStore,
          resolve: () =>
            Effect.succeed({
              _tag: 'found',
              assignments: [assignment(sequence === 1 ? 'current' : 'replacement')],
            }),
        },
      }),
      () => Effect.succeed({ _tag: 'Ok', value: usableDecision(requestedEffectiveAt) }),
    );
    expect(changed.trace.events).toEqual(['begin', 'end', 'call', 'begin', 'end']);
    expect(Option.getOrUndefined(Exit.findErrorOption(changed.exit))).toMatchObject({
      code: 'read_handler_unavailable',
    });
  }),
);

it.effect('reports every precise catalog rejection as BROKEN instead of falling back', () =>
  Effect.gen(function* brokenResolution() {
    const missing = yield* resolveCustomerPriceGroupAt(
      profile,
      [assignment('missing')],
      '2026-03-01T00:00:00.000Z',
      catalog({ _tag: 'MISSING' }),
    );
    expect(missing).toMatchObject({ _tag: 'BROKEN', catalogRevision: null, reason: 'MISSING' });

    const retired = yield* resolveCustomerPriceGroupAt(
      profile,
      [assignment('retired')],
      '2026-03-01T00:00:00.000Z',
      catalog({ _tag: 'RETIRED', catalogRevision: 8 }),
    );
    expect(retired).toMatchObject({ _tag: 'BROKEN', catalogRevision: 8, reason: 'RETIRED' });

    const incompatible = yield* resolveCustomerPriceGroupAt(
      profile,
      [assignment('incompatible')],
      '2026-03-01T00:00:00.000Z',
      catalog({ _tag: 'INCOMPATIBLE', catalogRevision: 9, contractId: 'pricing.other-contract.v1' }),
    );
    expect(incompatible).toMatchObject({ _tag: 'BROKEN', catalogRevision: 9, reason: 'INCOMPATIBLE' });
  }),
);

it.effect('reports overlapping current assignments as INCONSISTENT without catalog access', () =>
  Effect.gen(function* inconsistentResolution() {
    let catalogCalls = 0;
    const result = yield* resolveCustomerPriceGroupAt(
      profile,
      [assignment('one'), assignment('two')],
      '2026-03-01T00:00:00.000Z',
      {
        resolveCurrent: () => {
          catalogCalls += 1;
          return Effect.succeed({ _tag: 'MISSING' });
        },
      },
    );
    expect(result).toEqual({ _tag: 'INCONSISTENT', currentAssignmentCount: 2 });
    expect(catalogCalls).toBe(0);
  }),
);

it.effect('propagates catalog unavailability and never collapses it into NONE', () =>
  Effect.gen(function* unavailableResolution() {
    const exit = yield* Effect.exit(
      resolveCustomerPriceGroupAt(profile, [assignment('current')], '2026-03-01T00:00:00.000Z', {
        resolveCurrent: () =>
          Effect.fail(
            new CustomerPriceGroupCatalogUnavailable({
              code: 'customer_price_group_catalog_unavailable',
              reason: 'Pricing unavailable',
            }),
          ),
      }),
    );
    expect(exit._tag).toBe('Failure');
  }),
);

it.effect('rejects invalid periods and declares tagged business-plus-resource Read authority', () =>
  Effect.gen(function* contracts() {
    const invalid = yield* Effect.exit(
      Schema.decodeUnknownEffect(AssignCustomerPriceGroupPayloadSchema)({
        effectiveFrom: '2026-03-01T00:00:00.000Z',
        effectiveTo: '2026-03-01T00:00:00.000Z',
        expectedProfileRevision: 1,
        priceGroupRef,
        profile,
        reason: 'Invalid interval',
      }),
    );
    expect(invalid._tag).toBe('Failure');
    // One scope-wide declaration per read: the v2 gate decides the capability and the owner facts
    // name the counterparty or Retail profile whose own grant the overlay checks (O67-Q1, O70).
    expect(customerPriceGroupAssignmentReadRead.descriptor.accessDeclaration?.key).toBe(
      'commerce.customer-context.customer-price-group-assignment.read',
    );
    expect(customerPriceGroupResolutionRead.descriptor.accessDeclaration?.key).toBe(
      'commerce.customer-context.customer-price-group.resolve',
    );
    expect(customerPriceGroupAssignmentReadRead.descriptor.accessOwnerFacts).toBeDefined();
    expect(customerPriceGroupResolutionRead.descriptor.accessOwnerFacts).toBeDefined();
    expect(
      Schema.is(CustomerPriceGroupResolutionRequestSchema)({
        authorizationSubject: { kind: 'COUNTERPARTY' },
        effectiveAt: requestedEffectiveAt,
        profile,
      }),
    ).toBe(false);
  }),
);
