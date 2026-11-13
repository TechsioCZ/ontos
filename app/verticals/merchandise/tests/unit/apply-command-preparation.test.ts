import { cleanupDemoAction } from '../../src/actions/cleanup-demo.action.ts';
import { ActiveApplicationCompositionService } from '@app/core-runtime/modules/active-application-composition';
import { makeActionTestHarness } from '@app/core-runtime/testing/actions';
import { GatewayPrincipalVerifierConfiguration } from '@app/gateway-principal-verifier/server';
import { Effect, Layer, Predicate, Schema } from 'effect';
import { HttpClient, HttpServerRequest } from 'effect/http';
import { expect, it } from 'effect-rstest';
import { ManageCatalogPayloadSchema } from '../../shared/actions/apply-command.ts';
import { manageCatalogAction } from '../../src/actions/manage-catalog.action.ts';
import { merchandiseRegistration } from '../../vertical.registration.ts';

const principal = {
  authBindingId: '40000000-0000-4000-8000-000000000001',
  authContextRef: 'better-auth-session:merchandise-reference-preflight',
  authMethod: 'session',
  legalEntityId: '30000000-0000-4000-8000-000000000001',
  principalId: '20000000-0000-4000-8000-000000000001',
  tenantId: '10000000-0000-4000-8000-000000000001',
} as const;
const payload = Schema.decodeUnknownSync(ManageCatalogPayloadSchema)({
  command: {
    _tag: 'LinkOrderCustomer',
    counterpartyRef: {
      moduleId: 'party.registry',
      resourceId: 'counterparty',
      resourceType: 'party.registry.counterparty',
      tenantId: principal.tenantId,
    },
    expectedPartyId: 'storefront-guest',
    id: 'order',
    partyRef: {
      moduleId: 'party.registry',
      resourceId: 'party',
      resourceType: 'party.registry.party',
      tenantId: principal.tenantId,
    },
  },
  expectedRevision: 1,
});
const referenceBoundary = Layer.mergeAll(
  Layer.mock(ActiveApplicationCompositionService, {}),
  Layer.mock(GatewayPrincipalVerifierConfiguration, {}),
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make(() => Effect.die('Missing reference credentials must not contact Party')),
  ),
  Layer.succeed(
    HttpServerRequest.HttpServerRequest,
    HttpServerRequest.fromWeb(new Request('https://owner.test/merchandise/actions/manage-catalog')),
  ),
);
for (const access of ['denied', 'unavailable', 'allowed'] as const) {
  it.effect(
    `the actual LinkOrderCustomer ${access} preflight never acquires an owner write transaction without its reference credential`,
    () =>
      Effect.scoped(
        Effect.gen(function* referencePreflight() {
          // No bound service replacement: this runs the registration's real prepareServices hook.
          const harness = yield* makeActionTestHarness({ access, ownerRegistration: merchandiseRegistration });
          const failure = yield* harness.runtime
            .runAction({
              payload,
              principal,
              registration: manageCatalogAction,
              transport: { correlationId: 'reference-preflight', idempotencyKey: `reference-preflight-${access}` },
            })
            .pipe(Effect.flip);
          const expected = {
            allowed: 'MerchandiseReferenceUnavailable',
            denied: 'ActionPermissionDenied',
            unavailable: 'ActionPermissionCheckError',
          } as const;
          expect(Predicate.isTagged(failure, expected[access])).toBe(true);
          expect(harness.snapshot().transactionCount).toBe(0);
          expect(harness.snapshot().committed).toEqual([]);
        }),
      ).pipe(Effect.provide(referenceBoundary)),
  );
}

it.effect('canonical cleanup authority never moves ResetDemoData outside its original fixture company', () =>
  Effect.scoped(
    Effect.gen(function* resetCompanyInvariant() {
      const harness = yield* makeActionTestHarness({ access: 'allowed', ownerRegistration: merchandiseRegistration });
      const failure = yield* harness.runtime
        .runAction({
          payload: {
            command: { _tag: 'ResetDemoData', confirmation: 'OBNOVIT', reason: 'Reset invariant proof' },
            expectedRevision: 1,
          },
          principal,
          registration: cleanupDemoAction,
          transport: { correlationId: 'reset-company', idempotencyKey: 'reset-company' },
        })
        .pipe(Effect.flip);
      expect(Predicate.isTagged(failure, 'MerchandisePermissionDenied')).toBe(true);
      expect(harness.snapshot().transactionCount).toBe(0);
      expect(harness.snapshot().committed).toEqual([]);
    }),
  ).pipe(Effect.provide(referenceBoundary)),
);
