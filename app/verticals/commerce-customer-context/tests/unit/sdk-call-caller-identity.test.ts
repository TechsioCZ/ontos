import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import type { CallRouteRequest } from '@app/core-runtime/execution/module-call-route';
import { RequestExecutionSchema } from '@app/core-runtime/sdk';
import type { AnyDeclaredCall, RequestExecution } from '@app/core-runtime/sdk';
import { GatewayDelegationSourceError } from '@app/shared-contracts/gateway-context-server';
import type { GatewayDelegationRequest } from '@app/shared-contracts/gateway-context-server';
import { makeModuleCallRoute } from '@app/shared-contracts/server/sdk-module-call-route';
import { Effect, Schema } from 'effect';
import { HttpClient } from 'effect/http';
import { describe, expect, it } from 'effect-rstest';

import { guestPaymentTermsResolutionCalls } from '../../src/api/guest-payment-terms-resolution.read.ts';
import { marketBootstrapResolutionCalls } from '../../src/api/market-bootstrap-resolution.read.ts';
import { paymentTermsResolutionCalls } from '../../src/api/payment-terms-resolution.read.ts';
import { commerceCustomerContextManifest } from '../../vertical.manifest.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const legalEntityId = '22222222-2222-4222-8222-222222222222';
const sessionPrincipal = Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
  authBindingId: '99999999-9999-4999-8999-999999999999',
  authContextRef: 'session:customer-context-calls',
  authMethod: 'session',
  legalEntityId,
  principalId: '33333333-3333-4333-8333-333333333333',
  tenantId,
});
const systemPrincipal = Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
  authContextRef: 'job:customer-context-calls:run:1',
  authMethod: 'system',
  principalId: '33333333-3333-4333-8333-333333333333',
  tenantId,
});

/**
 * The calls these reads made by hand before, with the gateway audience the hand code named. For every
 * caller kind the hand code delegated the requester's own scope as an `Assertion` under its selected
 * Legal Entity (`legalEntityScope: 'subject'`), correlated by the request.
 */
const convertedCalls: readonly (readonly [string, AnyDeclaredCall, string])[] = [
  ['payment-terms-resolution', paymentTermsResolutionCalls.currentPaymentTerms, 'payment-term-catalog'],
  ['guest-payment-terms-resolution', guestPaymentTermsResolutionCalls.currentPaymentTerms, 'payment-term-catalog'],
  ['market-bootstrap-resolution eligible', marketBootstrapResolutionCalls.eligibleTuples, 'commerce-market-catalog'],
  ['market-bootstrap-resolution resolve', marketBootstrapResolutionCalls.resolveMarket, 'commerce-market-catalog'],
];

const callerKinds: readonly (readonly [RequestExecution['via'], typeof sessionPrincipal])[] = [
  ['person', sessionPrincipal],
  ['workload', sessionPrincipal],
  ['recovery', sessionPrincipal],
  ['system', systemPrincipal],
];

/**
 * Each requirement permits only that `person` caller and declares no registered caller, so Core relays
 * every request kind as the person; the module route then asks the gateway for exactly the delegation
 * the hand code asked for.
 */
describe('caller identity of the calls the Payment Terms and Market bootstrap reads make', () => {
  for (const [name, declared, audience] of convertedCalls) {
    it(`${name}: permits only the relayed requester under its selected Legal Entity`, () => {
      const requirement = commerceCustomerContextManifest.requirements?.operations.find(
        ({ key }) => key === declared.requirementKey,
      );
      expect(requirement?.callers).toEqual([{ kind: 'person', legalEntityScope: 'subject' }]);
      expect(requirement?.provider).toEqual(declared.operation.provider);
    });

    for (const [via, principal] of callerKinds) {
      it.effect(`${name}: delegates a ${via} request exactly as the hand-built client did`, () =>
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
          const executionScope = { ...principal, correlationId: `customer-context-${via}` };
          const request: CallRouteRequest = {
            caller: { kind: 'person', legalEntityScope: 'subject' },
            encodedInput: {},
            execution: {
              callerSource: { _tag: 'RequestPrincipal', principal },
              facts: {
                compositionRevision: 'composition-revision-1',
                identity: RequestExecutionSchema.make({ via }),
                operationKey: 'commerce.customer-context.api.converted-read',
                owningModuleKey: 'commerce.customer-context',
              },
              scope: executionScope,
            },
            operation: declared.operation,
            requirement: {
              callers: [{ kind: 'person', legalEntityScope: 'subject' }],
              compositionRevision: 'composition-revision-1',
              provider: declared.operation.provider,
              providerAppId: audience,
              requirementKey: declared.requirementKey,
            },
          };
          yield* route.send(request);
          expect(delegations).toEqual([
            {
              audience,
              legalEntityScope: 'subject',
              requestCorrelation: executionScope.correlationId,
              subject: { _tag: 'Assertion', scope: principal },
            },
          ]);
        }),
      );
    }
  }
});
