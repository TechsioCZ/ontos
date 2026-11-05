import type { CurrentPaymentTermsRequest } from '@app/payment-term-catalog-contracts/current-payment-terms';
import type { executeCurrentPaymentTerms } from '@app/payment-term-catalog-contracts/current-payment-terms/client';
import { layer as nodeCryptoLayer } from '@effect/platform-node/NodeCrypto';
import { Effect, Redacted, Schema } from 'effect';
import { HttpClientError, HttpClientRequest } from 'effect/http';
import { expect, it } from 'effect-rstest';

import { getActionServiceFactory } from '@app/core-runtime/testing/actions';
import { getReadServiceFactory } from '@app/core-runtime/testing/reads';

import type { PaymentTermDefinitionRequest } from '../../src/persistence/payment-term-persistence.ts';
import {
  paymentTermCatalogPort,
  paymentTermCatalogPortFromEnvironment,
} from '../../src/integrations/payment-term-catalog.ts';
import { PaymentTermsDependencyUnavailable } from '../../shared/domain/payment-term-errors.ts';
import { issuedDelegatedContext, originatorSubject } from '../support/delegated-gateway-acquisition.fixture.ts';
import { changeCustomerPaymentTermsAction } from '../../src/actions/change-customer-payment-terms.action.ts';
import { changeRetailPaymentTermPreferenceAction } from '../../src/actions/change-retail-payment-term-preference.action.ts';
import {
  guestPaymentTermsResolutionRead,
  makeGuestPaymentTermsResolutionServices,
} from '../../src/api/guest-payment-terms-resolution.read.ts';
import { paymentTermsResolutionRead } from '../../src/api/payment-terms-resolution.read.ts';

const paymentTermSubject = originatorSubject('a'.repeat(64), '10000000-0000-4000-8000-000000000001');
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
    calculationRuleVersion: 2,
    calendarRule: 'CALENDAR_DAYS',
    days: 30,
    dueDateAnchor: 'INVOICE_ISSUE_DATE',
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

it.effect('preserves exact owner identity and retired lifecycle for customer resolution', () =>
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
            requestedPaymentTermRef: firstPaymentTermRef,
          },
        ],
        truncated: false,
      });
    const definitions = yield* paymentTermCatalogPort('payment-correlation', execute).resolveDefinitions([
      {
        at: '2026-10-02T00:00:00.000Z',
        paymentTermRef: firstPaymentTermRef,
      },
    ]);

    expect(definitions).toEqual([{ ...retired, paymentTermRef: firstPaymentTermRef }]);
  }),
);

it.effect('preserves a broken catalog reference as explicit rejection instead of absence', () =>
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
    const failure = yield* Effect.flip(
      paymentTermCatalogPort('payment-correlation', execute).resolveDefinitions([
        {
          at: '2026-09-09T10:00:00.000Z',
          paymentTermRef: firstPaymentTermRef,
        },
      ]),
    );

    expect(failure.catalogRejection).toEqual({ kind: 'BROKEN', paymentTermRef: firstPaymentTermRef });
  }),
);

it.effect('admits every production catalog call through the delegated Shell context for the captured subject', () =>
  Effect.gen(function* delegatedAdmission() {
    let authorization = '';
    let destination = '';
    let selectedRevision = '';
    const admissions: unknown[] = [];
    const port = yield* paymentTermCatalogPortFromEnvironment(
      {
        legalEntityId: '20000000-0000-4000-8000-000000000001',
        requestCorrelation: 'payment-correlation',
        subject: paymentTermSubject,
      },
      (_payload, credential, _correlation, options) => {
        authorization = Redacted.value(credential);
        destination = String(options.baseUrl);
        selectedRevision = options.compositionRevision;
        return Effect.succeed({
          current: [],
          effectiveAt: '2026-09-09T10:00:00.000Z',
          observedAt: '2026-09-09T10:00:00.000Z',
          referenceOutcomes: [{ kind: 'MISSING', requestedPaymentTermRef: firstPaymentTermRef }],
          truncated: false,
        });
      },
      (request) => {
        admissions.push(request);
        return Effect.succeed(issuedDelegatedContext({ compositionRevision: 'a'.repeat(64), token: 'server-issued' }));
      },
    ).pipe(Effect.provide(nodeCryptoLayer));
    yield* port.resolveDefinitions([
      {
        at: '2026-09-09T10:00:00.000Z',
        paymentTermRef: firstPaymentTermRef,
      },
    ]);

    expect(authorization).toBe('Bearer server-issued');
    expect(destination).toBe('https://shell.example.test/owner-api');
    expect(selectedRevision).toBe('a'.repeat(64));
    expect(admissions).toEqual([
      {
        audience: 'payment-term-catalog',
        legalEntityScope: 'subject',
        requestCorrelation: 'payment-correlation',
        subject: paymentTermSubject,
      },
    ]);
  }),
);

for (const kind of ['INCOMPATIBLE', 'UNSUPPORTED_SEMANTICS', 'IDENTITY_MISMATCH'] as const) {
  it.effect(`rejects ${kind} through the production adapter without identity remapping or fallback`, () =>
    Effect.gen(function* rejectedCatalogReference() {
      const projected =
        kind === 'UNSUPPORTED_SEMANTICS'
          ? {
              ...definition,
              semantics: {
                calculationRuleVersion: 1,
                calendarRule: 'CALENDAR_DAYS_UTC',
                days: 30,
                dueDateAnchor: 'INVOICE_ISSUED_AT',
                kind: 'NET_DAYS',
              } as const,
            }
          : definition;
      const requestedPaymentTermRef = kind === 'IDENTITY_MISMATCH' ? secondPaymentTermRef : firstPaymentTermRef;
      const execute = (): ReturnType<typeof executeCurrentPaymentTerms> =>
        Effect.succeed({
          current: [],
          effectiveAt: provenance.at,
          observedAt: provenance.at,
          referenceOutcomes:
            kind === 'INCOMPATIBLE'
              ? [
                  {
                    actualCompatibilityId: definition.compatibilityId,
                    actualSemanticRevisionId: definition.semanticRevisionId,
                    definition: projected,
                    expectedSemanticRevisionId: '70000000-0000-4000-8000-000000000001',
                    kind,
                    requestedPaymentTermRef,
                  },
                ]
              : [{ definition: projected, kind: 'USABLE', requestedPaymentTermRef }],
          truncated: false,
        });
      const failure = yield* Effect.flip(
        paymentTermCatalogPort('payment-correlation', execute).resolveDefinitions([
          { at: provenance.at, paymentTermRef: requestedPaymentTermRef },
        ]),
      );
      expect(failure.catalogRejection).toEqual({
        kind: kind === 'IDENTITY_MISMATCH' ? 'BROKEN' : kind,
        paymentTermRef: requestedPaymentTermRef,
      });
      expect(projected.paymentTermRef).toEqual(firstPaymentTermRef);
      expect(projected.semantics.calculationRuleVersion).toBe(kind === 'UNSUPPORTED_SEMANTICS' ? 1 : 2);
    }),
  );
}

it.effect('consumes a proven equivalent Current alias as its exact retained owner definition', () =>
  Effect.gen(function* exactEquivalentAlias() {
    const aliasDefinition = {
      ...definition,
      definitionRevisionId: '70000000-0000-4000-8000-000000000002',
      paymentTermRef: secondPaymentTermRef,
      semanticRevisionId: '70000000-0000-4000-8000-000000000003',
    };
    const execute = (): ReturnType<typeof executeCurrentPaymentTerms> =>
      Effect.succeed({
        current: [],
        effectiveAt: provenance.at,
        observedAt: provenance.at,
        referenceOutcomes: [
          { definition: aliasDefinition, kind: 'USABLE', requestedPaymentTermRef: secondPaymentTermRef },
        ],
        truncated: false,
      });
    const definitions = yield* paymentTermCatalogPort('alias-current', execute).resolveDefinitions([
      { at: provenance.at, paymentTermRef: secondPaymentTermRef },
    ]);
    expect(definitions).toEqual([aliasDefinition]);
    expect(definitions[0]?.semanticRevisionId).toBe(aliasDefinition.semanticRevisionId);
    expect(definitions[0]?.definitionRevisionId).toBe(aliasDefinition.definitionRevisionId);
    expect(definition.paymentTermRef).toEqual(firstPaymentTermRef);
  }),
);
