import type { CurrentPaymentTermsRequest } from '@app/payment-term-catalog-contracts/current-payment-terms';
import type { executeCurrentPaymentTerms } from '@app/payment-term-catalog-contracts/current-payment-terms/client';
import { Effect, Layer, Redacted, Schema } from 'effect';
import { HttpClientError, HttpClientRequest } from 'effect/unstable/http';
import { expect, it } from 'effect-rstest';

import { getActionServiceFactory } from '../../../../packages/core-runtime/src/actions/definition.ts';
import { getReadServiceFactory } from '../../../../packages/core-runtime/src/reads/definition.ts';

import type { PaymentTermDefinitionRequest } from '../../src/persistence/payment-term-persistence.ts';
import {
  PaymentTermCatalogGatewayCredentialService,
  paymentTermCatalogPort,
  paymentTermCatalogPortFromEnvironment,
} from '../../src/integrations/payment-term-catalog.ts';
import { PaymentTermsDependencyUnavailable } from '../../shared/domain/payment-term-errors.ts';
import { changeCustomerPaymentTermsAction } from '../../src/actions/change-customer-payment-terms.action.ts';
import { changeRetailPaymentTermPreferenceAction } from '../../src/actions/change-retail-payment-term-preference.action.ts';
import {
  guestPaymentTermsResolutionRead,
  makeGuestPaymentTermsResolutionServices,
} from '../../src/api/guest-payment-terms-resolution.read.ts';
import { paymentTermsResolutionRead } from '../../src/api/payment-terms-resolution.read.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const firstPaymentTermRef = {
  moduleId: 'payment.term-catalog',
  resourceId: '20000000-0000-4000-8000-000000000001',
  resourceType: 'payment.term-catalog.payment-term',
  tenantId,
} as const;
const secondPaymentTermRef = {
  ...firstPaymentTermRef,
  resourceId: '20000000-0000-4000-8000-000000000002',
} as const;
const provenance = {
  actionInvocationId: '30000000-0000-4000-8000-000000000001',
  actorPrincipalId: '40000000-0000-4000-8000-000000000001',
  at: '2026-09-01T00:00:00.000Z',
  reason: 'Approved catalog definition',
} as const;
const definition = {
  code: 'NET_30',
  compatibilityId: 'net_days.invoice_issued_at.calendar_days_utc.v1',
  compatibleWith: ['customer-payment-terms.v1'],
  created: provenance,
  definitionRevisionId: '50000000-0000-4000-8000-000000000001',
  description: 'Payment is due thirty calendar days after invoice issue.',
  lifecycle: {
    effectiveFrom: '2026-01-01T00:00:00.000Z',
    effectiveTo: null,
    state: 'ACTIVE',
  },
  metadataRevision: 1,
  name: 'Net 30',
  paymentTermRef: firstPaymentTermRef,
  retired: null,
  semanticFingerprint: 'a'.repeat(64),
  semanticRevisionId: '60000000-0000-4000-8000-000000000001',
  semantics: {
    calculationRuleVersion: 1,
    calendarRule: 'CALENDAR_DAYS_UTC',
    days: 30,
    dueDateAnchor: 'INVOICE_ISSUED_AT',
    kind: 'NET_DAYS',
  },
  updated: provenance,
} as const;

it('attaches production Payment Terms factories to persistence and the public catalog client', () => {
  const changeFactory = getActionServiceFactory(changeCustomerPaymentTermsAction).toString();
  const retailFactory = getActionServiceFactory(changeRetailPaymentTermPreferenceAction).toString();
  const resolutionFactory = getReadServiceFactory(paymentTermsResolutionRead).toString();

  expect(changeFactory).toContain('paymentTermsPersistenceForTransaction');
  expect(changeFactory).toContain('paymentTermCatalogPort');
  expect(retailFactory).toContain('paymentTermsPersistenceForTransaction');
  expect(retailFactory).toContain('paymentTermCatalogPort');
  expect(resolutionFactory).toContain('paymentTermsPersistenceForTransaction');
  expect(resolutionFactory).toContain('paymentTermCatalogPort');
  expect(getReadServiceFactory(guestPaymentTermsResolutionRead)).toBe(makeGuestPaymentTermsResolutionServices);
});

it.effect('groups catalog requests by effective instant and keeps only USABLE definitions', () =>
  Effect.gen(function* paymentTermCatalogSuccess() {
    const calls: { correlation: string; payload: CurrentPaymentTermsRequest }[] = [];
    const execute = (
      payload: CurrentPaymentTermsRequest,
      correlation: string,
    ): ReturnType<typeof executeCurrentPaymentTerms> => {
      calls.push({ correlation, payload });
      const usable = payload.references.some(
        ({ paymentTermRef }) => paymentTermRef.resourceId === firstPaymentTermRef.resourceId,
      );
      return Effect.succeed({
        current: usable ? [definition] : [],
        effectiveAt: payload.at,
        observedAt: payload.at,
        referenceOutcomes: usable
          ? [
              {
                definition,
                kind: 'USABLE',
                requestedPaymentTermRef: firstPaymentTermRef,
              },
            ]
          : [{ kind: 'MISSING', requestedPaymentTermRef: secondPaymentTermRef }],
        truncated: false,
      });
    };
    const requests: readonly PaymentTermDefinitionRequest[] = [
      {
        at: '2026-09-09T10:00:00.000Z',
        expectedSemanticRevisionId: definition.semanticRevisionId,
        paymentTermRef: firstPaymentTermRef,
      },
      {
        at: '2026-09-10T10:00:00.000Z',
        paymentTermRef: secondPaymentTermRef,
      },
    ];
    const definitions = yield* paymentTermCatalogPort('payment-correlation', execute).resolveDefinitions(requests);

    expect(definitions).toEqual([definition]);
    expect(calls).toHaveLength(2);
    expect(calls.map(({ correlation }) => correlation)).toEqual(['payment-correlation', 'payment-correlation']);
    expect(calls[0]?.payload.references[0]).toMatchObject({
      expectedConsumerCompatibility: 'customer-payment-terms.v1',
      expectedSemanticRevisionId: definition.semanticRevisionId,
      paymentTermRef: firstPaymentTermRef,
    });
  }),
);

it.effect('maps catalog transport failures to the typed customer dependency failure', () =>
  Effect.gen(function* paymentTermCatalogUnavailable() {
    const request = HttpClientRequest.get('https://payment-term-catalog.invalid');
    const execute = (): ReturnType<typeof executeCurrentPaymentTerms> =>
      Effect.fail(
        new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({
            cause: new Error('private network diagnostic'),
            description: 'transport unavailable',
            request,
          }),
        }),
      );
    const failure = yield* Effect.flip(
      paymentTermCatalogPort('payment-correlation', execute).resolveDefinitions([
        {
          at: '2026-09-09T10:00:00.000Z',
          paymentTermRef: firstPaymentTermRef,
        },
      ]),
    );

    expect(Schema.is(PaymentTermsDependencyUnavailable)(failure)).toBe(true);
    expect(failure).toMatchObject({
      code: 'payment_terms_dependency_unavailable',
      dependency: 'PAYMENT_TERM_CATALOG',
      reason: 'The Current Payment Term catalog could not be resolved',
    });
    expect(failure.reason).not.toContain('private network diagnostic');
  }),
);

it.effect('preserves requested identity and retired lifecycle for customer resolution', () =>
  Effect.gen(function* preservesRequestedIdentity() {
    const retired = {
      ...definition,
      lifecycle: {
        ...definition.lifecycle,
        effectiveTo: '2026-10-01T00:00:00.000Z',
        state: 'RETIRED' as const,
      },
      retired: { ...provenance, at: '2026-09-09T12:00:00.000Z' },
    };
    const execute = (): ReturnType<typeof executeCurrentPaymentTerms> =>
      Effect.succeed({
        current: [],
        effectiveAt: '2026-10-02T00:00:00.000Z',
        observedAt: '2026-10-02T00:00:00.000Z',
        referenceOutcomes: [
          {
            definition: retired,
            kind: 'RETIRED' as const,
            requestedPaymentTermRef: secondPaymentTermRef,
          },
        ],
        truncated: false,
      });
    const definitions = yield* paymentTermCatalogPort('payment-correlation', execute).resolveDefinitions([
      {
        at: '2026-10-02T00:00:00.000Z',
        paymentTermRef: secondPaymentTermRef,
      },
    ]);

    expect(definitions).toEqual([{ ...retired, paymentTermRef: secondPaymentTermRef }]);
  }),
);

it.effect('preserves a broken catalog alias as an absent deterministic definition', () =>
  Effect.gen(function* brokenAlias() {
    const execute = (): ReturnType<typeof executeCurrentPaymentTerms> =>
      Effect.succeed({
        current: [],
        effectiveAt: '2026-09-09T10:00:00.000Z',
        observedAt: '2026-09-09T10:00:00.000Z',
        referenceOutcomes: [
          {
            kind: 'BROKEN' as const,
            reason: 'Payment Term alias graph contains a cycle',
            requestedPaymentTermRef: firstPaymentTermRef,
          },
        ],
        truncated: false,
      });
    const definitions = yield* paymentTermCatalogPort('payment-correlation', execute).resolveDefinitions([
      {
        at: '2026-09-09T10:00:00.000Z',
        paymentTermRef: firstPaymentTermRef,
      },
    ]);

    expect(definitions).toEqual([]);
  }),
);

it.effect('requires a server-owned gateway credential before a production catalog call', () =>
  Effect.gen(function* serverCredential() {
    let authorization = '';
    const issuanceRequests: {
      readonly audience: 'payment-term-catalog';
      readonly legalEntityId: string;
      readonly requestCorrelation: string;
    }[] = [];
    const port = yield* paymentTermCatalogPortFromEnvironment(
      {
        legalEntityId: '20000000-0000-4000-8000-000000000001',
        requestCorrelation: 'payment-correlation',
      },
      (_payload, credential) => {
        authorization = Redacted.value(credential);
        return Effect.succeed({
          current: [],
          effectiveAt: '2026-09-09T10:00:00.000Z',
          observedAt: '2026-09-09T10:00:00.000Z',
          referenceOutcomes: [{ kind: 'MISSING', requestedPaymentTermRef: firstPaymentTermRef }],
          truncated: false,
        });
      },
    ).pipe(
      Effect.provide(
        Layer.succeed(PaymentTermCatalogGatewayCredentialService, {
          issue: (input) =>
            Effect.sync(() => {
              issuanceRequests.push(input);
              return Redacted.make('Bearer server-issued');
            }),
        }),
      ),
    );
    yield* port.resolveDefinitions([
      {
        at: '2026-09-09T10:00:00.000Z',
        paymentTermRef: firstPaymentTermRef,
      },
    ]);

    expect(authorization).toBe('Bearer server-issued');
    expect(issuanceRequests).toEqual([
      {
        audience: 'payment-term-catalog',
        legalEntityId: '20000000-0000-4000-8000-000000000001',
        requestCorrelation: 'payment-correlation',
      },
    ]);
  }),
);
