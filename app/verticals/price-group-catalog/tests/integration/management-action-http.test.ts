import {
  ActionCommitIndeterminate,
  ActionPermissionCheckError,
  ActionPermissionDenied,
  ActionRequestHashConflict,
} from '@app/core-runtime';
import { Effect, Result } from 'effect';
import { describe, expect, it } from 'effect-rstest';
import { FetchHttpClient } from 'effect/unstable/http';

import { mapCreatePriceGroupActionProblem } from '../../api/create-price-group-action-problems.ts';
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
  meaningFingerprint: 'a'.repeat(64),
  reason: 'Create the approved dealer classification.',
} satisfies CreatePriceGroupPayload;
const expectedCurrent = {
  catalogRevision: 1,
  definitionRevisionId: '44444444-4444-4444-8444-444444444444',
  definitionRevisionNumber: 1,
  meaningFingerprint: payload.meaningFingerprint,
  priceGroupRef: {
    moduleId: 'pricing.price-group-catalog' as const,
    resourceId: '33333333-3333-4333-8333-333333333333',
    resourceType: 'pricing.price-group-catalog.price-group' as const,
    tenantId: '11111111-1111-4111-8111-111111111111',
  },
};
const createResult = {
  definition: {
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
    meaningFingerprint: payload.meaningFingerprint,
    previousDefinitionRevisionId: null,
    priceGroupRef: expectedCurrent.priceGroupRef,
    revisionNumber: 1,
  },
  outcome: 'RECONCILIATION_REQUIRED' as const,
  reconciliation: {
    mutationId: '66666666-6666-4666-8666-666666666666',
    operation: 'touch_containment' as const,
    staged: true as const,
  },
};
const revisionPayload = {
  classificationPurpose: payload.classificationPurpose,
  compatibilityContracts: payload.compatibilityContracts,
  description: 'Clarified dealer classification for approved resellers.',
  displayName: payload.displayName,
  effectiveFrom: '2026-11-01T00:00:00.000Z',
  effectiveTo: null,
  expectedCurrent,
  meaningFingerprint: payload.meaningFingerprint,
  reason: 'Clarify the classification without changing its meaning.',
  sameMeaningAttested: true,
} satisfies CreatePriceGroupDefinitionRevisionPayload;
const retirementPayload = {
  effectiveAt: '2026-12-01T00:00:00.000Z',
  expectedCurrent,
  reason: 'Retire the dealer classification from future use.',
} satisfies RetirePriceGroupPayload;

const clientOptions = (idempotencyKey: string, traceId?: string) =>
  traceId === undefined
    ? { baseUrl: 'https://pricing.example/price-group-catalog-api', idempotencyKey }
    : { baseUrl: 'https://pricing.example/price-group-catalog-api', idempotencyKey, traceId };

describe('Price Group management Action HTTP boundary', () => {
  it.effect('decodes the nonterminal Create acceptance through the public client', () =>
    Effect.gen(function* decodeCreateAcceptance() {
      const fakeFetch: typeof globalThis.fetch = () => Promise.resolve(Response.json(createResult, { status: 200 }));
      const result = yield* executeCreatePriceGroupWithAuthorization(
        payload,
        'Bearer owner-assertion',
        'catalog-correlation',
        clientOptions('create-dealer'),
      ).pipe(Effect.provideService(FetchHttpClient.Fetch, fakeFetch));

      expect(result).toEqual(createResult);
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
    expect(
      mapCreatePriceGroupActionProblem(
        new ActionRequestHashConflict({
          code: 'action_request_hash_conflict',
          reason: 'The idempotency key has different semantics.',
        }),
      ),
    ).toMatchObject({ code: 'action_request_hash_conflict', status: 409 });
    expect(
      mapCreatePriceGroupActionProblem(
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
  });
});
