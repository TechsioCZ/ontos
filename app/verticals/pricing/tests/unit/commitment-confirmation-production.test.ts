import { NodeCrypto } from '@effect/platform-node';
import {
  OperationContextUnavailable,
  TrustedPrincipalContextSchema,
  defineRead,
  defineTenantModuleEntrypoint,
} from '@app/core-runtime';
import type { OperationalScope } from '@app/core-runtime';
import { makeReadTestHarness } from '@app/core-runtime/testing/reads';
import { DateTime, Effect, Schema } from 'effect';
import { expect, it, rs } from 'effect-rstest';

import { commitmentConfirmationProductionForScope } from '../../src/integrations/commitment-confirmation-production.ts';

const dependencies = rs.hoisted(() => ({
  gateway: rs.fn<(scope: OperationalScope, revision: string) => void>(),
  proof: rs.fn<() => void>(),
}));
const gatewayFailure = new OperationContextUnavailable({
  code: 'operation_context_unavailable',
  reason: 'Controlled owner gateway refusal',
});

// Only owner-local dependencies are replaced; Core installs the genuine scoped transaction.
rs.mock('../../src/integrations/commitment-confirmation-owner-proof.ts', () => ({
  pricingCommitmentOwnerProof: Effect.sync(() => {
    dependencies.proof();
    return {};
  }),
}));
rs.mock('../../src/integrations/order-finalization-owner-gateways.ts', () => ({
  ...rs.requireActual('../../src/integrations/order-finalization-owner-gateways.ts'),
  pricingFinalizationOwnerGateways: (scope: OperationalScope, revision: string) =>
    Effect.sync(() => dependencies.gateway(scope, revision)).pipe(Effect.andThen(Effect.fail(gatewayFailure))),
}));

const scope: OperationalScope = {
  ...Schema.decodeSync(TrustedPrincipalContextSchema)({
    authBindingId: '11111111-1111-4111-8111-111111111111',
    authContextRef: 'unit:pricing-production-factory',
    authMethod: 'session',
    principalId: '22222222-2222-4222-8222-222222222222',
    tenantId: '33333333-3333-4333-8333-333333333333',
  }),
  correlationId: 'pricing-production-factory',
};
const revision = 'pricing-production-unit-revision';
const operationTime = DateTime.toDate(DateTime.makeUnsafe('2026-10-24T12:00:00.000Z'));

const checkFactory = (compositionRevision?: string) =>
  Effect.gen(function* checkProductionFactory() {
    dependencies.gateway.mockClear();
    dependencies.proof.mockClear();
    let factoryCalls = 0;
    const registration = defineRead(
      {
        accessKind: 'detail',
        entrypoint: defineTenantModuleEntrypoint({
          access: 'read',
          authorization: { kind: 'authenticated_principal' },
          entrypointKey: 'commerce.pricing.production-factory-unit',
          moduleKey: 'commerce.pricing',
          role: 'api',
        }),
        evidencePolicy: {
          captureMode: 'metadata_only',
          policyKey: 'commerce.pricing.production-factory-unit.evidence',
        },
        inputSchema: Schema.Struct({}),
        legalEntityScope: 'forbidden',
        owningModuleKey: 'commerce.pricing',
        permissionTarget: 'tenant',
        policies: [],
        readKey: 'commerce.pricing.production-factory-unit',
        resultSchema: Schema.Boolean,
        schemaVersion: '1',
      },
      () => Effect.succeed({ evidence: { resultCount: 1 }, result: true }),
      (transaction, installedScope) =>
        commitmentConfirmationProductionForScope(transaction, installedScope, compositionRevision).pipe(
          Effect.flip,
          Effect.orDie,
          Effect.map((failure) => {
            factoryCalls += 1;
            expect(Schema.is(OperationContextUnavailable)(failure)).toBe(true);
            if (compositionRevision === undefined) {
              expect(failure.reason).toBe('Pricing Commitment composition revision is unavailable');
              expect(dependencies.proof).not.toHaveBeenCalled();
              expect(dependencies.gateway).not.toHaveBeenCalled();
            } else {
              expect(failure.reason).toBe('Production Pricing Commitment authority is unavailable');
              expect(failure).toHaveProperty('cause', gatewayFailure);
              expect(dependencies.proof).toHaveBeenCalledTimes(1);
              expect(dependencies.gateway).toHaveBeenCalledExactlyOnceWith(installedScope, compositionRevision);
              expect(installedScope.tenantId).toBe(scope.tenantId);
              expect(installedScope.principalId).toBe(scope.principalId);
            }
            return {};
          }),
        ),
      () => ({ kind: 'tenant', permission: 'read_party_identity' }),
    );
    const harness = yield* makeReadTestHarness({
      executeOwnerQuery: () => Effect.die('Pricing persistence must not run'),
      operationTime,
      ownerAuthorizationDecision: 'allowed',
      permissionDecision: 'allowed',
      scope,
    });
    expect(
      yield* harness.runtime.runRead({
        input: {},
        principal: scope,
        registration,
        transport: { correlationId: scope.correlationId },
      }),
    ).toBe(true);
    expect(factoryCalls).toBe(1);
    expect(harness.snapshot().ownerQueries).toEqual([]);
  });

it.layer(NodeCrypto.layer)('Pricing production factory composition context', (suite) => {
  suite.effect('refuses absent revision before proof, gateways, or persistence', () => checkFactory());
  suite.effect('preserves present revision and installed scope at the owner gateway boundary', () =>
    checkFactory(revision),
  );
});
