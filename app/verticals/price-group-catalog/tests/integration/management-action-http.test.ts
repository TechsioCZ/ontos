import {
  ActionAlreadyCommitted,
  ActionCommitIndeterminate,
  ActionPermissionCheckError,
  ActionPermissionDenied,
  ActionRequestHashConflict,
} from '@app/core-runtime';
import {
  PriceGroupIdempotencyReuseConflict,
  PriceGroupSemanticIdentityConflict,
} from '../../shared/domain/price-group-errors.ts';
import { Effect, Result } from 'effect';
import { describe, expect, it } from 'effect-rstest';
import { FetchHttpClient } from 'effect/unstable/http';

import { mapCreatePriceGroupActionProblem } from '../../api/create-price-group-action-problems.ts';
import { mapCreatePriceGroupDefinitionRevisionActionProblem } from '../../api/create-price-group-definition-revision-action-problems.ts';
import { mapRetirePriceGroupActionProblem } from '../../api/retire-price-group-action-problems.ts';
import { recoverPriceGroupActionCommittedRetry } from '../../api/action-http-runner.ts';
import type { CreatePriceGroupDefinitionRevisionPayload } from '../../shared/actions/create-price-group-definition-revision.ts';
import type { CreatePriceGroupPayload } from '../../shared/actions/create-price-group.ts';
import type { RetirePriceGroupPayload } from '../../shared/actions/retire-price-group.ts';
import { executeCreatePriceGroupWithAuthorization } from '../../src/api/create-price-group-action-client.ts';
import { executeCreatePriceGroupDefinitionRevisionWithAuthorization } from '../../src/api/create-price-group-definition-revision-action-client.ts';
import { executeRetirePriceGroupWithAuthorization } from '../../src/api/retire-price-group-action-client.ts';

const payload = {
  businessCode: 'DEALER',
  classificationPurpose: 'Classifies approved resellers for the dealer pricing path.',
  compatibilityContracts: [{ contractId: 'commerce.customer-price-group-assignment', version: 1 }],
  description: 'Dealer classification for approved resellers.',
  displayName: 'Dealer',
  effectiveFrom: '2026-10-01T00:00:00.000Z',
  effectiveTo: null,
  expectedCatalogRevision: 0,
  reason: 'Create the approved dealer classification.',
} satisfies CreatePriceGroupPayload;
const meaningFingerprint = 'a'.repeat(64);
const expectedCurrent = {
  catalogRevision: 1,
  definitionRevisionId: '44444444-4444-4444-8444-444444444444',
  definitionRevisionNumber: 1,
  meaningFingerprint,
  priceGroupRef: {
    moduleId: 'pricing.price-group-catalog' as const,
    resourceId: '33333333-3333-4333-8333-333333333333',
    resourceType: 'pricing.price-group-catalog.price-group' as const,
    tenantId: '11111111-1111-4111-8111-111111111111',
  },
};
const initialDefinition = {
  acceptedCatalogRevision: 1,
  classificationPurpose: payload.classificationPurpose,
  compatibilityContracts: payload.compatibilityContracts,
  created: {
    actionInvocationId: '55555555-5555-4555-8555-555555555555',
    actorPrincipalId: '22222222-2222-4222-8222-222222222222',
    reason: payload.reason,
    trustedAt: '2026-09-23T12:00:00.000Z',
  },
  definitionRevisionId: expectedCurrent.definitionRevisionId,
  description: payload.description,
  displayName: payload.displayName,
  effectivePeriod: { effectiveFrom: payload.effectiveFrom, effectiveTo: payload.effectiveTo },
  meaningFingerprint,
  previousDefinitionRevisionId: null,
  priceGroupRef: expectedCurrent.priceGroupRef,
  revisionNumber: 1,
  semanticContinuity: null,
};
const createResult = {
  acceptance: {
    acceptedCatalogRevision: 1,
    definitionEffectivePeriod: initialDefinition.effectivePeriod,
    definitionRevisionId: initialDefinition.definitionRevisionId,
    definitionRevisionNumber: 1,
    meaningFingerprint,
    priceGroupRef: initialDefinition.priceGroupRef,
    provenance: initialDefinition.created,
  },
  identity: {
    businessCode: payload.businessCode,
    created: initialDefinition.created,
    createdAtCatalogRevision: 1,
    lifecycle: {
      activeFrom: payload.effectiveFrom,
      retiredAt: null,
      state: 'ACTIVE' as const,
    },
    meaningFingerprint,
    priceGroupRef: initialDefinition.priceGroupRef,
  },
  initialDefinition,
};
const committedRetryReceipt = {
  invocationId: '55555555-5555-4555-8555-555555555555',
  replay: 'already_committed' as const,
};
const revisionPayload = {
  classificationPurpose: payload.classificationPurpose,
  compatibilityContracts: payload.compatibilityContracts,
  description: 'Clarified dealer classification for approved resellers.',
  displayName: payload.displayName,
  effectiveFrom: '2026-11-01T00:00:00.000Z',
  effectiveTo: null,
  expectedCurrent,
  reason: 'Clarify the classification without changing its meaning.',
  semanticDecision: {
    comparedDefinitionRevisionId: expectedCurrent.definitionRevisionId,
    decision: 'SAME_MEANING' as const,
  },
} satisfies CreatePriceGroupDefinitionRevisionPayload;
const retirementPayload = {
  effectiveAt: '2026-12-01T00:00:00.000Z',
  expectedCurrent,
  reason: 'Retire the dealer classification from future use.',
} satisfies RetirePriceGroupPayload;
const revisionResult = {
  ...initialDefinition,
  acceptedCatalogRevision: 2,
  created: {
    actionInvocationId: '77777777-7777-4777-8777-777777777777',
    actorPrincipalId: initialDefinition.created.actorPrincipalId,
    reason: revisionPayload.reason,
    trustedAt: '2026-09-23T12:00:00.000Z',
  },
  definitionRevisionId: '88888888-8888-4888-8888-888888888888',
  description: revisionPayload.description,
  effectivePeriod: { effectiveFrom: revisionPayload.effectiveFrom, effectiveTo: null },
  previousDefinitionRevisionId: initialDefinition.definitionRevisionId,
  revisionNumber: 2,
  semanticContinuity: {
    comparedDefinitionRevisionId: initialDefinition.definitionRevisionId,
    decision: 'SAME_MEANING' as const,
    provenance: {
      actionInvocationId: '77777777-7777-4777-8777-777777777777',
      actorPrincipalId: initialDefinition.created.actorPrincipalId,
      reason: revisionPayload.reason,
      trustedAt: '2026-09-23T12:00:00.000Z',
    },
  },
};
const retirementResult = {
  acceptedCatalogRevision: 2,
  currentDefinitionRevisionId: initialDefinition.definitionRevisionId,
  currentDefinitionRevisionNumber: 1,
  priceGroupRef: expectedCurrent.priceGroupRef,
  retirementEffectiveAt: retirementPayload.effectiveAt,
  retirementProvenance: {
    actionInvocationId: '99999999-9999-4999-8999-999999999999',
    actorPrincipalId: initialDefinition.created.actorPrincipalId,
    reason: retirementPayload.reason,
    trustedAt: '2026-11-30T00:00:00.000Z',
  },
  trustedOperationAt: '2026-11-30T00:00:00.000Z',
  verifiedAt: '2026-11-30T00:00:00.000Z',
};

const clientOptions = (idempotencyKey: string, traceId?: string) =>
  traceId === undefined
    ? { baseUrl: 'https://pricing.example/price-group-catalog-api', idempotencyKey }
    : { baseUrl: 'https://pricing.example/price-group-catalog-api', idempotencyKey, traceId };

describe('Price Group management Action HTTP boundary', () => {
  it('recovers Core already-committed evidence into the declared successful receipt', () => {
    expect(
      recoverPriceGroupActionCommittedRetry(
        new ActionAlreadyCommitted({
          code: 'action_already_committed',
          invocationId: committedRetryReceipt.invocationId,
          reason: 'The exact request already committed.',
        }),
      ),
    ).toEqual(committedRetryReceipt);
  });

  it.effect('decodes initial business success through all three public clients', () =>
    Effect.gen(function* decodeBusinessSuccess() {
      const createFetch: typeof globalThis.fetch = () => Promise.resolve(Response.json(createResult, { status: 200 }));
      const revisionFetch: typeof globalThis.fetch = () =>
        Promise.resolve(Response.json(revisionResult, { status: 200 }));
      const retirementFetch: typeof globalThis.fetch = () =>
        Promise.resolve(Response.json(retirementResult, { status: 200 }));
      const create = yield* executeCreatePriceGroupWithAuthorization(
        payload,
        'Bearer owner-assertion',
        'catalog-correlation',
        clientOptions('create-dealer'),
      ).pipe(Effect.provideService(FetchHttpClient.Fetch, createFetch));
      const revision = yield* executeCreatePriceGroupDefinitionRevisionWithAuthorization(
        revisionPayload,
        'Bearer owner-assertion',
        'catalog-correlation',
        clientOptions('revise-dealer'),
      ).pipe(Effect.provideService(FetchHttpClient.Fetch, revisionFetch));
      const retirement = yield* executeRetirePriceGroupWithAuthorization(
        retirementPayload,
        'Bearer owner-assertion',
        'catalog-correlation',
        clientOptions('retire-dealer'),
      ).pipe(Effect.provideService(FetchHttpClient.Fetch, retirementFetch));

      expect(create).toEqual(createResult);
      expect(revision).toEqual(revisionResult);
      expect(retirement).toEqual(retirementResult);
    }),
  );

  it.effect('decodes committed retry receipts as successful responses for all three management Actions', () =>
    Effect.gen(function* decodeCommittedRetryReceipts() {
      const fakeFetch: typeof globalThis.fetch = () =>
        Promise.resolve(Response.json(committedRetryReceipt, { status: 200 }));

      const create = yield* executeCreatePriceGroupWithAuthorization(
        payload,
        'Bearer owner-assertion',
        'catalog-correlation',
        clientOptions('create-dealer'),
      ).pipe(Effect.provideService(FetchHttpClient.Fetch, fakeFetch));
      const revision = yield* executeCreatePriceGroupDefinitionRevisionWithAuthorization(
        revisionPayload,
        'Bearer owner-assertion',
        'catalog-correlation',
        clientOptions('revise-dealer'),
      ).pipe(Effect.provideService(FetchHttpClient.Fetch, fakeFetch));
      const retirement = yield* executeRetirePriceGroupWithAuthorization(
        retirementPayload,
        'Bearer owner-assertion',
        'catalog-correlation',
        clientOptions('retire-dealer'),
      ).pipe(Effect.provideService(FetchHttpClient.Fetch, fakeFetch));

      expect([create, revision, retirement]).toEqual([
        committedRetryReceipt,
        committedRetryReceipt,
        committedRetryReceipt,
      ]);
    }),
  );

  it.effect('sends idempotency and defined trace metadata while omitting an absent trace header', () =>
    Effect.gen(function* preserveClientHeaders() {
      const requests: Request[] = [];
      const fakeFetch: typeof globalThis.fetch = (input, init) => {
        requests.push(new Request(input, init));
        return Promise.resolve(new Response(null, { status: 503 }));
      };
      yield* executeCreatePriceGroupWithAuthorization(
        payload,
        'Bearer owner-assertion',
        'catalog-correlation',
        clientOptions('create-dealer', 'create-trace'),
      ).pipe(Effect.result, Effect.provideService(FetchHttpClient.Fetch, fakeFetch));
      yield* executeCreatePriceGroupWithAuthorization(
        payload,
        'Bearer owner-assertion',
        'catalog-correlation',
        clientOptions('create-dealer'),
      ).pipe(Effect.result, Effect.provideService(FetchHttpClient.Fetch, fakeFetch));
      yield* executeCreatePriceGroupDefinitionRevisionWithAuthorization(
        revisionPayload,
        'Bearer owner-assertion',
        'catalog-correlation',
        clientOptions('revise-dealer', 'revision-trace'),
      ).pipe(Effect.result, Effect.provideService(FetchHttpClient.Fetch, fakeFetch));
      yield* executeCreatePriceGroupDefinitionRevisionWithAuthorization(
        revisionPayload,
        'Bearer owner-assertion',
        'catalog-correlation',
        clientOptions('revise-dealer'),
      ).pipe(Effect.result, Effect.provideService(FetchHttpClient.Fetch, fakeFetch));
      yield* executeRetirePriceGroupWithAuthorization(
        retirementPayload,
        'Bearer owner-assertion',
        'catalog-correlation',
        clientOptions('retire-dealer', 'retirement-trace'),
      ).pipe(Effect.result, Effect.provideService(FetchHttpClient.Fetch, fakeFetch));
      yield* executeRetirePriceGroupWithAuthorization(
        retirementPayload,
        'Bearer owner-assertion',
        'catalog-correlation',
        clientOptions('retire-dealer'),
      ).pipe(Effect.result, Effect.provideService(FetchHttpClient.Fetch, fakeFetch));

      expect(requests.map((request) => request.url)).toEqual([
        'https://pricing.example/price-group-catalog-api/price-group-catalog/actions/create-price-group',
        'https://pricing.example/price-group-catalog-api/price-group-catalog/actions/create-price-group',
        'https://pricing.example/price-group-catalog-api/price-group-catalog/actions/create-price-group-definition-revision',
        'https://pricing.example/price-group-catalog-api/price-group-catalog/actions/create-price-group-definition-revision',
        'https://pricing.example/price-group-catalog-api/price-group-catalog/actions/retire-price-group',
        'https://pricing.example/price-group-catalog-api/price-group-catalog/actions/retire-price-group',
      ]);
      expect(requests.map((request) => request.headers.get('idempotency-key'))).toEqual([
        'create-dealer',
        'create-dealer',
        'revise-dealer',
        'revise-dealer',
        'retire-dealer',
        'retire-dealer',
      ]);
      expect(requests.map((request) => request.headers.get('x-correlation-id'))).toEqual([
        'catalog-correlation',
        'catalog-correlation',
        'catalog-correlation',
        'catalog-correlation',
        'catalog-correlation',
        'catalog-correlation',
      ]);
      expect(requests.map((request) => request.headers.get('x-trace-id'))).toEqual([
        'create-trace',
        null,
        'revision-trace',
        null,
        'retirement-trace',
        null,
      ]);
    }),
  );

  it.effect('rejects invalid temporal and compatibility payloads before issuing an HTTP request', () =>
    Effect.gen(function* rejectBeforeTransport() {
      let fetches = 0;
      const fakeFetch: typeof globalThis.fetch = () => {
        fetches += 1;
        return Promise.resolve(new Response(null, { status: 500 }));
      };
      const invoke = (candidate: CreatePriceGroupPayload) =>
        executeCreatePriceGroupWithAuthorization(candidate, 'Bearer owner-assertion', 'catalog-correlation', {
          baseUrl: 'https://pricing.example/price-group-catalog-api',
          idempotencyKey: 'invalid-create',
        }).pipe(Effect.result, Effect.provideService(FetchHttpClient.Fetch, fakeFetch));

      const invalidPeriod = yield* invoke({ ...payload, effectiveTo: payload.effectiveFrom });
      const duplicateCompatibility = yield* invoke({
        ...payload,
        compatibilityContracts: [...payload.compatibilityContracts, ...payload.compatibilityContracts],
      });

      expect(Result.isFailure(invalidPeriod)).toBe(true);
      expect(Result.isFailure(duplicateCompatibility)).toBe(true);
      expect(fetches).toBe(0);
    }),
  );

  it('maps definite denial, indeterminate authorization, hash conflicts, and uncertain commits to typed statuses', () => {
    expect(
      mapCreatePriceGroupActionProblem(
        new ActionPermissionDenied({
          code: 'action_permission_denied',
          reason: 'Denied by the exact Price Group grant.',
        }),
      ),
    ).toMatchObject({ code: 'action_permission_denied', status: 403 });
    expect(
      mapCreatePriceGroupActionProblem(
        new ActionPermissionCheckError({
          code: 'action_permission_check_failed',
          reason: 'Authorization could not decide safely.',
        }),
      ),
    ).toMatchObject({ code: 'action_permission_check_failed', retryable: true, status: 503 });
    for (const mapProblem of [
      mapCreatePriceGroupActionProblem,
      mapCreatePriceGroupDefinitionRevisionActionProblem,
      mapRetirePriceGroupActionProblem,
    ]) {
      expect(
        mapProblem(
          new ActionRequestHashConflict({
            code: 'action_request_hash_conflict',
            reason: 'The idempotency key has different semantics.',
          }),
        ),
      ).toMatchObject({ code: 'action_request_hash_conflict', status: 409 });
      expect(
        mapProblem(
          new ActionCommitIndeterminate({
            code: 'action_commit_indeterminate',
            invocationId: '33333333-3333-4333-8333-333333333333',
            reason: 'The commit acknowledgement was lost.',
          }),
        ),
      ).toMatchObject({
        invocationId: '33333333-3333-4333-8333-333333333333',
        resolution: 'RESOLVE_COMMIT',
        retryCommand: false,
        status: 503,
      });
      expect(
        mapProblem(
          new PriceGroupIdempotencyReuseConflict({
            actionInvocationId: '33333333-3333-4333-8333-333333333333',
            code: 'price_group_idempotency_reuse_conflict',
            reason: 'The owner invocation identity was reused for different Price Group intent.',
          }),
        ),
      ).toMatchObject({ code: 'price_group_idempotency_reuse_conflict', status: 409 });
      expect(
        mapProblem(
          new PriceGroupSemanticIdentityConflict({
            code: 'price_group_semantic_identity_conflict',
            existingMeaningFingerprint: 'a'.repeat(64),
            existingPriceGroupRef: expectedCurrent.priceGroupRef,
            reason: 'The semantic identity belongs to another Price Group.',
            requestedMeaningFingerprint: 'a'.repeat(64),
          }),
        ),
      ).toMatchObject({ code: 'price_group_semantic_identity_conflict', status: 409 });
    }
  });
});
