import { AccessDecisionGate } from '@app/core-runtime/access/enforcement';
import { makeTestBoundAccessGate } from '@app/core-runtime/testing/access-gate';
import { merchandiseRegistration } from '../../vertical.registration.ts';
import { ReadPermissionDenied, TrustedPrincipalContextSchema } from '@app/core-runtime';
import { makeReadTestHarness } from '@app/core-runtime/testing/reads';
import { NodeCrypto } from '@effect/platform-node';
import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { AKROS_PLAYGROUND_LEGAL_ENTITY_ID } from '../../shared/actions/command-guard.ts';
import { recordsRead } from '../../src/api/records.read.ts';

it.layer(NodeCrypto.layer)('New AKROS storefront governed read boundary', (suite) => {
  suite.effect('rejects staff and order reads before accessing owner data', () =>
    Effect.gen(function* newTenantReadGuard() {
      const principal = Schema.decodeSync(TrustedPrincipalContextSchema)({
        authBindingId: '11111111-1111-4111-8111-111111111111',
        authContextRef: 'better-auth-api-key:playground-test',
        authMethod: 'api_key',
        legalEntityId: AKROS_PLAYGROUND_LEGAL_ENTITY_ID,
        principalId: '22222222-2222-4222-8222-222222222222',
        tenantId: 'bceaa540-13eb-5508-9ac0-9ed7e40a2ee9',
      });
      const gate = makeTestBoundAccessGate({ defaultAnswer: { outcome: 'ALLOWED' } });
      const harness = yield* makeReadTestHarness({
        access: 'allowed',
        accessDecision: gate.bound,
        executeOwnerQuery: () => Effect.die('A storefront denial must not access owner data'),
        operationTime: new Date('2026-11-02T10:00:00.000Z'),
        ownerAuthorizationDecision: 'allowed',
        ownerRegistration: merchandiseRegistration,
        permissionDecision: 'allowed',
        scope: { ...principal, correlationId: 'playground-read-guard' },
      });
      for (const view of [{ storefront: false }, { orderClientRequestId: 'another-order', storefront: true }]) {
        const failure = yield* harness.runtime
          .runRead({
            input: { view },
            principal,
            registration: recordsRead,
            transport: { correlationId: 'playground-read-guard' },
          })
          .pipe(
            Effect.provide(harness.layer),
            Effect.provideService(AccessDecisionGate, gate.accessDecision),
            Effect.flip,
          );
        expect(Schema.is(ReadPermissionDenied)(failure)).toBe(true);
      }
      expect(harness.snapshot().ownerQueries).toEqual([]);
    }),
  );
});
