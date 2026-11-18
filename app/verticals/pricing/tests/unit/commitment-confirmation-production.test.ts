import { NodeCrypto } from '@effect/platform-node';
import {
  OperationContextUnavailable,
  TrustedPrincipalContextSchema,
  defineOntosModuleManifest,
  defineVerticalRuntimeRegistration,
  defineRead,
  defineTenantModuleEntrypoint,
} from '@app/core-runtime';
import type { OperationalScope } from '@app/core-runtime';
import { makeReadTestHarness } from '@app/core-runtime/testing/reads';
import { makeModuleContractFixture } from '@app/core-runtime/testing/module-contract';
import { trustVerifiedGatewayPrincipalContext } from '@app/core-runtime/auth/system-principal-context-provenance';
import { ConfigProvider, DateTime, Effect, Layer, Match, Redacted, Schema } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { expect, it } from 'effect-rstest';

import { PricingOwnerProofUnavailable } from '../../src/integrations/commitment-confirmation-owner-proof.ts';
import { commitmentConfirmationProductionForScope } from '../../src/integrations/commitment-confirmation-production.ts';
import { PricingFinalizationAuthorityUnavailable } from '../../src/integrations/order-finalization-owner-gateways.ts';
import {
  makeIssue788Binding,
  makeIssue788CommercialTotal,
  makeIssue788Quotation,
} from './support/issue-788-confirmation.fixture.ts';
import { makeOwnerTransport, ownerBearer, ownerTransportConfiguration } from './support/owner-transport.fixture.ts';

// The actual owner proof reads its signing material from configuration; the actual owner gateways
// refuse any caller that is not the verified Order module before they reach a transport.
const ownerProofConfiguration = ConfigProvider.fromUnknown({
  ONTOS_PRICING_CONFIRMATION_KEY_LINEAGE_REF: 'pricing-production-unit-lineage',
  ONTOS_PRICING_CONFIRMATION_KEY_REF: 'pricing-production-unit-key',
  ONTOS_PRICING_CONFIRMATION_KEY_VERSION: '1',
  ONTOS_PRICING_CONFIRMATION_SIGNING_SECRET: 'pricing-production-unit-signing-secret-0123456789',
});
const absentOwnerProofConfiguration = ConfigProvider.fromUnknown({});

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
const revision = 'e'.repeat(64);
const legalEntityId = '44444444-4444-4444-8444-444444444444';
const sourceAssertion = 'verified-order-source-assertion';
// The Order module acting for its buyer, as Core verified it from a redeemed Shell assertion.
const orderScope: OperationalScope = trustVerifiedGatewayPrincipalContext(
  {
    ...Schema.decodeSync(TrustedPrincipalContextSchema)({
      authBindingId: '11111111-1111-4111-8111-111111111111',
      authContextRef: 'unit:pricing-production-factory',
      authMethod: 'session',
      legalEntityId,
      principalId: '22222222-2222-4222-8222-222222222222',
      tenantId: '33333333-3333-4333-8333-333333333333',
    }),
    correlationId: 'pricing-production-factory-order',
  },
  revision,
  { assertion: Redacted.make(sourceAssertion), audience: 'commerce-pricing' },
  {
    appId: 'commerce-order',
    buildMarker: 'pricing-production-factory-order',
    principalId: '22222222-2222-4222-8222-222222222222',
  },
);
// Order answers the binding read with a governed refusal, so issuance stops after the owner call.
const preparedBindingPath = '/reads/prepared-order-pricing-binding';
const orderTransport = makeOwnerTransport(revision, [
  {
    path: preparedBindingPath,
    respond: () =>
      Response.json(
        {
          _tag: 'PreparedOrderPricingBindingNotFoundProblem',
          detail: 'No prepared Order retains this binding',
          status: 404,
          title: 'Not found',
          type: 'about:blank',
        },
        { headers: { 'content-type': 'application/problem+json' }, status: 404 },
      ),
  },
]);
const operationTime = DateTime.toDate(DateTime.makeUnsafe('2026-10-24T12:00:00.000Z'));

const FactoryExpectationSchema = Schema.Literals(['absent-revision', 'absent-proof', 'gateway-refusal']);
type FactoryExpectation = typeof FactoryExpectationSchema.Type;

const expectRefusal = (
  expectation: FactoryExpectation,
  failure: OperationContextUnavailable,
  installedScope: OperationalScope,
) => {
  expect(Schema.is(OperationContextUnavailable)(failure)).toBe(true);
  if (expectation === 'absent-revision') {
    // No signing material is configured, so reaching the proof would have failed with its reason.
    expect(failure.reason).toBe('Pricing Commitment composition revision is unavailable');
    return;
  }
  expect(failure.reason).toBe('Production Pricing Commitment authority is unavailable');
  if (expectation === 'absent-proof') {
    // The proof precedes the gateways: without signing material no owner gateway is reached.
    expect(failure).toHaveProperty('cause', expect.any(PricingOwnerProofUnavailable));
  } else {
    // A plain session scope carries no verified Order actor, so the actual owner gateways refuse it
    // before acquiring any owner credential.
    expect(failure).toHaveProperty('cause', expect.any(PricingFinalizationAuthorityUnavailable));
    expect(failure).toHaveProperty('cause.cause', 'The caller is not the Order module acting for its buyer');
  }
  expect(installedScope.tenantId).toBe(scope.tenantId);
  expect(installedScope.principalId).toBe(scope.principalId);
};

type FactoryProbe = (
  services: Effect.Success<ReturnType<typeof commitmentConfirmationProductionForScope>>,
  installedScope: OperationalScope,
) => Effect.Effect<void>;

const refusal =
  (expectation: FactoryExpectation, compositionRevision?: string) =>
  (transaction: Parameters<typeof commitmentConfirmationProductionForScope>[0], installedScope: OperationalScope) =>
    commitmentConfirmationProductionForScope(transaction, installedScope, compositionRevision).pipe(
      Effect.flip,
      Effect.orDie,
      Effect.map((failure) => expectRefusal(expectation, failure, installedScope)),
    );

const production =
  (compositionRevision: string, probe: FactoryProbe) =>
  (transaction: Parameters<typeof commitmentConfirmationProductionForScope>[0], installedScope: OperationalScope) =>
    commitmentConfirmationProductionForScope(transaction, installedScope, compositionRevision).pipe(
      Effect.orDie,
      Effect.flatMap((services) => probe(services, installedScope)),
    );

const checkFactory = (
  install: (
    transaction: Parameters<typeof commitmentConfirmationProductionForScope>[0],
    installedScope: OperationalScope,
  ) => Effect.Effect<void, never, Effect.Services<ReturnType<typeof commitmentConfirmationProductionForScope>>>,
  principal: OperationalScope = scope,
  /** The active composition a verified gateway principal was admitted under. */
  admittedRevision?: string,
) =>
  Effect.gen(function* checkProductionFactory() {
    let factoryCalls = 0;
    const registration = defineRead(
      {
        accessKind: 'detail',
        entrypoint: defineTenantModuleEntrypoint({
          access: 'read',
          authorization: { kind: 'authenticated_principal' },
          entrypointKey: 'test.pricing-production-factory.probe',
          moduleKey: 'test.pricing-production-factory',
          role: 'api',
        }),
        evidencePolicy: {
          captureMode: 'metadata_only',
          policyKey: 'test.pricing-production-factory.probe.evidence',
        },
        inputSchema: Schema.Struct({}),
        legalEntityScope: principal.legalEntityId === undefined ? 'forbidden' : 'required',
        owningModuleKey: 'test.pricing-production-factory',
        permissionTarget: 'tenant',
        policies: [],
        readKey: 'test.pricing-production-factory.probe',
        resultSchema: Schema.Boolean,
        schemaVersion: '1',
      },
      () => Effect.succeed({ evidence: { resultCount: 1 }, result: true }),
      (transaction, installedScope) =>
        install(transaction, installedScope).pipe(
          Effect.map(() => {
            factoryCalls += 1;
            return {};
          }),
        ),
      () => ({ kind: 'tenant', permission: 'read_party_identity' }),
    );
    // This factory-only probe is its own test owner, not a production Pricing entrypoint.
    const ownerBase = makeModuleContractFixture({
      appId: 'pricing-production-factory-test',
      moduleId: 'test.pricing-production-factory',
    }).manifest;
    const ownerRegistration = defineVerticalRuntimeRegistration({
      actions: [],
      manifest: defineOntosModuleManifest({
        ...ownerBase,
        publicSurface: { ...ownerBase.publicSurface, actions: [], api: {}, components: {} },
      }),
      outboxWorkers: [],
      reads: [registration],
    });
    const harnessOptions = {
      access: 'allowed',
      executeOwnerQuery: () => Effect.die('Pricing persistence must not run'),
      operationTime,
      ownerAuthorizationDecision: 'allowed',
      ownerRegistration,
      scope: principal,
    } as const;
    const harness = yield* makeReadTestHarness(
      admittedRevision === undefined ? harnessOptions : { ...harnessOptions, compositionRevision: admittedRevision },
    );
    expect(
      yield* harness.runtime.runRead({
        input: {},
        principal,
        registration,
        transport: { correlationId: principal.correlationId },
      }),
    ).toBe(true);
    expect(factoryCalls).toBe(1);
    expect(harness.snapshot().ownerQueries).toEqual([]);
  });

const withOwnerProofConfiguration = (configuration: ConfigProvider.ConfigProvider) =>
  Layer.mergeAll(NodeCrypto.layer, ConfigProvider.layer(configuration));

it.layer(withOwnerProofConfiguration(absentOwnerProofConfiguration))(
  'Pricing production factory without owner signing material',
  (suite) => {
    suite.effect('refuses absent revision before proof, gateways, or persistence', () =>
      checkFactory(refusal('absent-revision')),
    );
    suite.effect('refuses at the owner proof before any owner gateway', () =>
      checkFactory(refusal('absent-proof', revision)),
    );
  },
);

it.layer(
  Layer.mergeAll(
    NodeCrypto.layer,
    ConfigProvider.layer(ConfigProvider.orElse(ownerProofConfiguration, ownerTransportConfiguration)),
    Layer.succeed(FetchHttpClient.Fetch, (input, init) => Promise.resolve(orderTransport.answer(input, init))),
  ),
)('Pricing production factory composition context', (suite) => {
  suite.effect('refuses an installed scope without the verified Order actor at the actual owner gateways', () =>
    checkFactory(refusal('gateway-refusal', revision)),
  );
  suite.effect('forwards the installed verified scope and present revision to the actual owner gateway', () =>
    checkFactory(
      production(revision, (services, installedScope) =>
        Effect.gen(function* issueThroughOwnerGateway() {
          const commercialTotal = yield* makeIssue788CommercialTotal().pipe(Effect.orDie);
          const binding = makeIssue788Binding(commercialTotal);
          const quotation = makeIssue788Quotation(commercialTotal);
          const outcome = yield* services.issueQuotation({
            binding,
            materialEvidence: quotation.materialEvidence,
            quotation,
            requestedBinding: binding.purchase,
          });
          const unverifiableReason = Match.value(outcome).pipe(
            Match.tag('SOURCE_UNVERIFIABLE', ({ reason }) => reason),
            Match.orElse(({ _tag }) => _tag),
          );
          expect(unverifiableReason).toBe('PERMANENT_ORDER_BINDING_UNVERIFIABLE');
          // The Shell delegation acts for the installed verified subject under the factory's revision.
          const delegations = orderTransport.requestsTo('/auth/delegated/gateway-context');
          expect(delegations.map((sent) => sent.headers.get('x-correlation-id'))).toEqual([
            installedScope.correlationId,
          ]);
          expect(orderTransport.delegations).toMatchObject([
            {
              audience: 'commerce-order',
              compositionRevision: revision,
              legalEntityScope: 'subject',
              subject: { _tag: 'Assertion', sourceAssertion },
            },
          ]);
          // The issued credential was accepted for the present revision and used for the Order read.
          const [ownerRead] = orderTransport.requestsTo(preparedBindingPath);
          expect(ownerRead?.headers.get('authorization')).toBe(ownerBearer);
          expect(ownerRead?.headers.get('x-ontos-composition-revision')).toBe(revision);
          expect(installedScope.legalEntityId).toBe(legalEntityId);
        }),
      ),
      orderScope,
      revision,
    ),
  );
});
