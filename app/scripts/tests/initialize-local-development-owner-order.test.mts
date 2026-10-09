import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  LOCAL_DEVELOPMENT_CONTEXT,
  LOCAL_DEVELOPMENT_OWNER_INITIALIZATION_ORDER,
  LocalDevelopmentInitializationError,
  initializeLocalDevelopmentOwners,
} from '../initialize-local-development.mts';
import type {
  LocalDevelopmentOwnerInitializationRequest,
  LocalDevelopmentOwnerReconcilers,
} from '../initialize-local-development.mts';

const ownerReconcilers = (
  reconcile: (request: LocalDevelopmentOwnerInitializationRequest) => void,
): LocalDevelopmentOwnerReconcilers =>
  Object.fromEntries(
    LOCAL_DEVELOPMENT_OWNER_INITIALIZATION_ORDER.map((owner) => [
      owner,
      (request: LocalDevelopmentOwnerInitializationRequest) => Effect.sync(() => reconcile(request)),
    ]),
  );

it.effect('reconciles local owner facts in dependency order with stable idempotency keys', () =>
  Effect.gen(function* initializeOwnersTwice() {
    const facts = new Set<string>();
    const requests: LocalDevelopmentOwnerInitializationRequest[] = [];
    const reconcilers = ownerReconcilers((request) => {
      const ownerIndex = LOCAL_DEVELOPMENT_OWNER_INITIALIZATION_ORDER.indexOf(request.owner);
      const prerequisite = LOCAL_DEVELOPMENT_OWNER_INITIALIZATION_ORDER[ownerIndex - 1];
      if (prerequisite !== undefined) {
        expect(facts.has(prerequisite)).toBe(true);
      }
      facts.add(request.owner);
      requests.push(request);
    });

    yield* initializeLocalDevelopmentOwners(reconcilers);
    yield* initializeLocalDevelopmentOwners(reconcilers);

    const expectedOrder = [...LOCAL_DEVELOPMENT_OWNER_INITIALIZATION_ORDER];
    expect(requests.map(({ owner }) => owner)).toEqual([...expectedOrder, ...expectedOrder]);
    expect([...facts]).toEqual(expectedOrder);
    expect(requests.slice(0, expectedOrder.length).map(({ idempotencyKey }) => idempotencyKey)).toEqual(
      requests.slice(expectedOrder.length).map(({ idempotencyKey }) => idempotencyKey),
    );
    expect(requests.every(({ legalEntityId }) => legalEntityId === LOCAL_DEVELOPMENT_CONTEXT.legalEntityId)).toBe(true);
    expect(requests.every(({ tenantId }) => tenantId === LOCAL_DEVELOPMENT_CONTEXT.tenantId)).toBe(true);
  }),
);

it.effect('fails typed and stops before dependents when an owner reconciler is missing', () =>
  Effect.gen(function* rejectMissingOwnerDependency() {
    const invoked: string[] = [];
    const error = yield* initializeLocalDevelopmentOwners({
      'storefront-registry': ({ owner }) =>
        Effect.sync(() => {
          invoked.push(owner);
        }),
    }).pipe(Effect.flip);

    expect(Schema.is(LocalDevelopmentInitializationError)(error)).toBe(true);
    expect(error.code).toBe('local_owner_dependency_missing');
    expect(error.reason).toMatch(/commerce-market-catalog/u);
    expect(invoked).toEqual(['storefront-registry']);
  }),
);
