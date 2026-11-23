import type { CurrentPricingDecisionResponseSchema } from '@app/pricing-contracts';
import type { CurrentPricingDecisionEvaluationFactoryService } from '../../src/services/current-pricing-decision-evaluation.service.ts';
import type { PricingOwnerMaterialEvidenceFenceGateway } from '../../src/integrations/material-evidence-owner-final-fence.ts';
import { executeQuantityPreparationWithAuthorization } from '@app/catalog/api/quantity-preparation-client';
import { currentPricingDecisionRead } from '../../src/api/current-pricing-decision.read.ts';
import { pricingRegistration } from '../../vertical.registration.ts';
import { CurrentPricingDecisionSubjectAuthority } from '../../src/services/current-pricing-decision-subject-authority.service.ts';
import {
  CurrentPricingDecisionEvaluationFactory,
  currentPricingDecisionEvaluationFactoryLive,
} from '../../src/services/current-pricing-decision-evaluation.service.ts';
import {
  PricingCatalogMaterialEvidenceFenceGateway,
  PricingCustomerContextMaterialEvidenceFenceGateway,
  PricingMarketMaterialEvidenceFenceGateway,
  PricingPromotionMaterialEvidenceFenceGateway,
  pricingOrdinaryCurrentPublicationLive,
} from '../../src/integrations/material-evidence-owner-final-fence.ts';
import { pricingCurrentDecisionOwnerFinalFenceGatewaysLive } from '../../src/integrations/current-pricing-decision-owner-final-fence.ts';
import { ModuleCallRouteLive } from '@app/shared-contracts/server/sdk-module-call-route';
import {
  PricingCurrentMarketEvidenceRequestSchema,
  PricingCurrentMarketEvidenceResponseSchema,
} from '@app/commerce-market-catalog/api/pricing-current-market-evidence';
import type { PricingCurrentMarketEvidenceRequest } from '@app/commerce-market-catalog/api/pricing-current-market-evidence';
import {
  PricingPurchaseContextVerificationEvidenceSchema,
  PricingPurchaseContextVerificationRequestSchema,
  PricingPurchaseContextVerificationResponseSchema,
} from '@app/commerce-customer-context/api/pricing-purchase-context-verification';
import { CurrentPricingDecisionRequestSchema } from '@app/pricing-contracts/current-pricing-decision';
import {
  CustomerPriceGroupResolutionRequestSchema,
  CustomerPriceGroupResolutionResponseSchema,
  customerPriceGroupResolutionPredicateRef,
} from '@app/commerce-customer-context/api/customer-price-group-resolution';
import type { CustomerPriceGroupResolutionRequest } from '@app/commerce-customer-context/api/customer-price-group-resolution';
import { PriceGroupCompatibilityDecisionSchema } from '@app/price-group-catalog-contracts/price-group';
import { ValidatePriceGroupCompatibilityRequestSchema } from '@app/price-group-catalog-contracts/validate-price-group-compatibility';
import type { ValidatePriceGroupCompatibilityRequest } from '@app/price-group-catalog-contracts/validate-price-group-compatibility';
import { pricingExternalOwnerEvidenceValidationService } from '../../src/services/external-owner-evidence-validation.service.ts';
import { trustVerifiedGatewayPrincipalContext } from '@app/core-runtime/auth/system-principal-context-provenance';
import { makeTestAccessGateLayers } from '@app/core-runtime/testing/access-gate';
import {
  ContextAccessLive,
  CorePersistenceLive,
  DatabaseConfig,
  ReadRuntime,
  makeReadRuntimeLive,
  OntosModuleDeploymentContractSchema,
  TenantModuleStateServiceLive,
  TrustedPrincipalContextSchema,
  makeContextPermissionRelationshipMutationLive,
  parseDatabaseConfig,
} from '@app/core-runtime';
import type { OperationalScope, ScopedTransactionExecutor } from '@app/core-runtime';
import {
  ModuleEntrypointGatewayLive,
  ModuleStateGateLive,
  OperationalScopeResolverLive,
} from '@app/core-runtime/actions/runtime-wiring';
import {
  ActiveApplicationCompositionService,
  ActiveApplicationCompositionSnapshotSchema,
  makeActiveApplicationCompositionLayer,
  makeActiveApplicationCompositionService,
} from '@app/core-runtime/modules/active-application-composition';
import { makeLiveOperationFixture } from '@app/core-runtime/testing/actions';
import { makeIsolatedNativeDatabaseFixture } from '@app/core-runtime/testing/isolated-native-database';
import {
  STAFF_AUTHENTICATION_NAMESPACE_ID,
  staffAuthenticationNamespaceRegistryLayer,
} from '@app/core-runtime/auth/staff-authentication-namespace';
import { CatalogQuantityHandoffReadySchema } from '@app/catalog-selection-contracts/catalog-quantity-handoff';
import { CatalogSelectionSchema } from '@app/catalog-selection-contracts/catalog-selection';
import { ProductUnitRefSchema } from '@app/catalog-selection-contracts/resources/product-unit';
import {
  EXTERNAL_GATEWAY_ASSERTION_VERSION,
  GATEWAY_ASSERTION_TTL_SECONDS,
  GatewayDelegatedContextRequestSchema,
  SupportedGatewayContextClaimsSchema,
  decodeSupportedGatewayContextClaims,
  shellGatewayContextContract,
} from '@app/shared-contracts';
import { PriceIdentityKeySchema } from '@app/pricing-contracts/domain/price-definition';
import { PricingDiscountIdentityKeySchema } from '@app/pricing-contracts/domain/discount';
import type { PriceRefSchema } from '@app/pricing-contracts/resources/price';
import { PriceSourceAssertionInputSchema } from '@app/pricing-contracts/domain/price-source-provenance';
import { SetSupportedCurrenciesV2PayloadSchema } from '@app/pricing-contracts/domain/currency-support';
import { QuantityTierIdentityKeySchema } from '@app/pricing-contracts/domain/quantity-tier';
import { NodeChildProcessSpawner, NodeCrypto, NodeHttpServer, NodeServices } from '@effect/platform-node';
import {
  Clock,
  ConfigProvider,
  Context,
  Config,
  Crypto,
  DateTime,
  Deferred,
  Effect,
  FileSystem,
  Layer,
  Match,
  Option,
  Queue,
  Redacted,
  Schema,
  Stream,
} from 'effect';
import type { Cause, Scope } from 'effect';
import { ChildProcess } from 'effect/process';
import type { ChildProcessSpawner } from 'effect/process';
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from 'effect/http';
import { assert, expect } from 'effect-rstest';
import { commercialFeePersistenceForScope } from '../../src/services/commercial-fee-persistence.service.ts';
import { contractualDiscountPersistenceForScope } from '../../src/services/contractual-discount-persistence.service.ts';
import { pricePersistenceForScope } from '../../src/services/price-persistence.service.ts';
import type { DefinePricePersistenceCommand } from '../../src/services/price-persistence.service.ts';
import { quantityTierPersistenceForScope } from '../../src/services/quantity-tier-persistence.service.ts';
import { currencySupportPersistenceForScope } from '../../src/persistence/currency-support-persistence.ts';
import { preparePriceSourceEvidence } from '../../src/services/price-source-provenance.service.ts';

// The fixture Shell admits only a relayed requester assertion, never an Originator subject.
const isAssertionSubject = (subject: (typeof GatewayDelegatedContextRequestSchema.Type)['subject']): boolean =>
  Match.value(subject).pipe(
    Match.tag('Assertion', () => true),
    Match.tag('Originator', () => false),
    Match.tag('OrganizationGovernanceRead', () => false),
    Match.tag('PrivacyDispatch', () => false),
    Match.tag('RegisteredAssertion', () => false),
    Match.tag('RegisteredAdmission', () => false),
    Match.tag('RegisteredRecovery', () => false),
    Match.tag('RegisteredWorkload', () => false),
    Match.exhaustive,
  );

// Closed private process DTOs are decoded locally; no foreign private source import.
const PRICING_MODULE = 'commerce.pricing' as const;
const CATALOG_MODULE = 'commerce.catalog' as const;
const HARNESS_MARKET = { channelId: 'B2C', marketId: 'component-test' } as const;
const CUSTOMER_CONTEXT_AUDIENCE = 'commerce-customer-context' as const;
const CUSTOMER_CONTEXT_MODULE = 'commerce.customer-context' as const;
const PRICE_GROUP_CATALOG_AUDIENCE = 'price-group-catalog' as const;
const PRICE_GROUP_CATALOG_MODULE = 'pricing.price-group-catalog' as const;
const protocolVersion = 'ontos.catalog.whole-candidate.fixture.v1' as const;

const version = protocolVersion;
const legalEntityIdSchema = Schema.String.check(Schema.isUUID()).pipe(Schema.brand('LegalEntityId'));
const WholeCandidateCatalogBootstrapSchema = Schema.Struct({
  actor: TrustedPrincipalContextSchema,
  composition: ActiveApplicationCompositionSnapshotSchema,
  databaseName: Schema.String.check(Schema.isPattern(/^ontos_test_[a-z0-9_]+$/u)),
  deniedPrincipalId: TrustedPrincipalContextSchema.fields.principalId,
  issuer: Schema.String,
  jwks: Schema.String,
  legalEntityId: legalEntityIdSchema,
  runtimeConnectionString: Schema.RedactedFromValue(Schema.String),
  scheduledConfiguration: Schema.optionalKey(Schema.Literal(true)),
  type: Schema.Literal('bootstrap'),
  version: Schema.Literal(protocolVersion),
}).annotate({ parseOptions: { onExcessProperty: 'error' } });
const WholeCandidateCatalogPrepareSchema = Schema.Struct({
  authorizations: Schema.Tuple([
    Schema.RedactedFromValue(Schema.String),
    Schema.RedactedFromValue(Schema.String),
    Schema.RedactedFromValue(Schema.String),
  ]),
  type: Schema.Literal('prepare'),
  version: Schema.Literal(protocolVersion),
}).annotate({ parseOptions: { onExcessProperty: 'error' } });
const WholeCandidateCatalogReviseSchema = Schema.Struct({
  expectedRevision: Schema.Int.check(Schema.isGreaterThan(0)),
  type: Schema.Literal('revise-first-unit'),
  version: Schema.Literal(protocolVersion),
}).annotate({ parseOptions: { onExcessProperty: 'error' } });
const StopSchema = Schema.Struct({ type: Schema.Literal('stop'), version: Schema.Literal(protocolVersion) }).annotate({
  parseOptions: { onExcessProperty: 'error' },
});
const WholeCandidateCatalogCommandSchema = Schema.Union([
  WholeCandidateCatalogBootstrapSchema,
  WholeCandidateCatalogPrepareSchema,
  WholeCandidateCatalogReviseSchema,
  StopSchema,
]);
const selectionsSchema = Schema.Tuple([CatalogSelectionSchema, CatalogSelectionSchema, CatalogSelectionSchema]);
const unitsSchema = Schema.Tuple([ProductUnitRefSchema, ProductUnitRefSchema, ProductUnitRefSchema]);
const publicFields = {
  actor: TrustedPrincipalContextSchema,
  buildMarker: Schema.String,
  compositionRevision: Schema.String,
  legalEntityId: legalEntityIdSchema,
  port: Schema.Int,
  selections: selectionsSchema,
  units: unitsSchema,
  version: Schema.Literal(protocolVersion),
};
const WholeCandidateCatalogProducedSchema = Schema.Struct({
  ...publicFields,
  type: Schema.Literal('produced'),
}).annotate({ parseOptions: { onExcessProperty: 'error' } });
const WholeCandidateCatalogReadySchema = Schema.Struct({
  ...publicFields,
  handoffs: Schema.Tuple([
    CatalogQuantityHandoffReadySchema,
    CatalogQuantityHandoffReadySchema,
    CatalogQuantityHandoffReadySchema,
  ]),
  type: Schema.Literal('ready'),
}).annotate({ parseOptions: { onExcessProperty: 'error' } });
const WholeCandidateCatalogFailureSchema = Schema.Struct({
  reasonCode: Schema.Literals(['RECEIVING_RELEASE_NOT_APPROVED', 'FIXTURE_UNAVAILABLE']),
  stage: Schema.String,
  type: Schema.Literal('failed'),
  version: Schema.Literal(protocolVersion),
}).annotate({ parseOptions: { onExcessProperty: 'error' } });
const ActionKeySchema = Schema.String.pipe(Schema.brand('ActionKey'));
const WholeCandidateCatalogDescriptionSchema = Schema.Struct({
  actionKeys: Schema.Array(ActionKeySchema),
  appId: Schema.Literal('catalog'),
  buildMarker: Schema.String,
  contractDocument: Schema.String,
  type: Schema.Literal('description'),
  version: Schema.Literal(protocolVersion),
}).annotate({ parseOptions: { onExcessProperty: 'error' } });
const WholeCandidateCatalogResponseSchema = Schema.Union([
  WholeCandidateCatalogFailureSchema,
  WholeCandidateCatalogProducedSchema,
  WholeCandidateCatalogReadySchema,
  Schema.Struct({
    ruleRevision: Schema.Int,
    type: Schema.Literal('revised'),
    version: Schema.Literal(protocolVersion),
  }),
]);

const catalogActionKeys = [
  'create-product',
  'create-attribute-definition',
  'create-product-type',
  'set-product-type',
  'create-variant',
  'govern-product-attribute-applicability',
  'set-variant-attribute-override',
  'govern-variant-axes',
  'govern-variant-allowed-values',
  'confirm-variant-combination',
  'set-product-localized-facts',
  'update-product',
  'create-product-unit',
  'set-product-unit-target-divisibility',
  'create-product-category',
  'add-product-category-assignment',
  'revise-product-unit',
  'publish-product-configuration',
].map((slug) => ActionKeySchema.make(`commerce.catalog.${slug}`));
const nextId = Crypto.Crypto.use((crypto) => crypto.randomUUIDv4());
const appRoot = new URL('../../../../', import.meta.url).pathname;
/** Services the harness needs from its caller: process spawning, crypto, HTTP and the staff authentication namespaces. */
export const publicPricingReadHarnessServices = NodeChildProcessSpawner.layer.pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(NodeCrypto.layer),
  Layer.provideMerge(FetchHttpClient.layer),
  Layer.provideMerge(staffAuthenticationNamespaceRegistryLayer(['catalog', 'pricing'])),
);
export class WholeCandidateReceiverTestUnavailable extends Schema.TaggedError<WholeCandidateReceiverTestUnavailable>()(
  'WholeCandidateReceiverTestUnavailable',
  { stage: Schema.String },
) {
  /** Surfaces the failing stage in the test report instead of an empty message. */
  override get message(): string {
    return this.stage;
  }
}
const unavailable = (stage: string) => new WholeCandidateReceiverTestUnavailable({ stage });
// Component setup intentionally uses Pricing's real scoped persistence, not registered
// DefinePrice admission. No Market/CCC authority or published whole result is invented.
const makeNativePrice = Effect.fn('WholeCandidate.nativePrice')(function* makeNativePrice(
  scope: OperationalScope,
  handoff: typeof CatalogQuantityHandoffReadySchema.Type,
  operationTime: string,
) {
  const actionInvocationId = yield* nextId;
  const priceId = yield* nextId;
  const identityKey = yield* Schema.decodeUnknownEffect(PriceIdentityKeySchema)({
    catalogSelection: handoff.selection,
    commercialScope: { ...HARNESS_MARKET, sellingLegalEntityId: scope.legalEntityId },
    currencyCode: 'CZK',
    priceGroupSelector: { kind: 'NO_GROUP' },
    unitBasis: { quantity: '1', unitRef: handoff.unitRef },
  });
  const assertion = yield* Schema.decodeUnknownEffect(PriceSourceAssertionInputSchema)({
    lineage: { kind: 'INITIAL' },
    mapping: { mappingContractRef: 'TEST:1225:Pricing-owned-component', mappingContractVersion: '1' },
    originalAssertion: {
      monetaryAmount: { amount: '100', currencyCode: 'CZK' },
      monetaryBoundary: 'PRE_TAX',
      unitBasis: identityKey.unitBasis,
    },
    sourceAssertionId: yield* nextId,
    sourceAuthority: { sourceAuthorityRef: 'TEST:1225:Pricing-owner-component', sourceAuthorityVersion: '1' },
    sourceRecord: {
      sourceChangeCorrelation: actionInvocationId,
      sourceRecordRef: priceId,
      sourceRecordVersion: '1',
      sourceSystem: { ownerModuleId: PRICING_MODULE, sourceSystemRef: 'TEST:1225:Pricing-native-setup' },
    },
    timing: { importedAt: operationTime, ownerBusinessEffectiveAt: operationTime, sourceEffectiveAt: operationTime },
  });
  const trustedOperationAt = DateTime.toDateUtc(DateTime.makeUnsafe(operationTime));
  const prepared = preparePriceSourceEvidence({
    actingPrincipalId: scope.principalId,
    effectiveFrom: operationTime,
    identityKey,
    monetaryAmount: { amount: '100', currencyCode: 'CZK' },
    sourceAssertion: assertion,
    tenantId: scope.tenantId,
    trustedOperationAt,
  });
  if (prepared.outcome !== 'READY_FOR_CANONICAL_WRITE') {
    return yield* Effect.die('Native Pricing-owned source must be ready');
  }
  return {
    actingPrincipalId: scope.principalId,
    actionInvocationId,
    effectiveFrom: operationTime,
    identityKey,
    monetaryAmount: { amount: '100', currencyCode: 'CZK' },
    priceRef: {
      moduleId: PRICING_MODULE,
      resourceId: priceId,
      resourceType: 'commerce.pricing.price',
      tenantId: scope.tenantId,
    },
    reason: 'Native Pricing component setup only; registered owner admission is separately required.',
    requestCorrelationId: actionInvocationId,
    sourceEvidence: prepared.evidence,
    trustedOperationAt,
  } satisfies DefinePricePersistenceCommand;
});

const produceNativeComponents = (
  transaction: ScopedTransactionExecutor,
  scope: OperationalScope,
  handoffs: readonly (typeof CatalogQuantityHandoffReadySchema.Type)[],
  operationTime: string,
) =>
  Effect.gen(function* produceNativeComponentsProgram() {
    const prices = yield* pricePersistenceForScope(transaction, scope);
    const tiers = yield* quantityTierPersistenceForScope(transaction, scope);
    return yield* Effect.forEach(
      handoffs,
      (handoff) =>
        Effect.gen(function* produceOnePriceAndTier() {
          const command = yield* makeNativePrice(scope, handoff, operationTime);
          expect(yield* prices.define(command)).toMatchObject({ outcome: 'CREATED' });
          const identityKey = yield* Schema.decodeUnknownEffect(QuantityTierIdentityKeySchema)({
            priceRef: command.priceRef,
            quantityBasis: {
              catalogQuantityBasis: handoff.quantityBasis,
              priceUnitBasis: command.identityKey.unitBasis,
            },
            thresholdQuantity: '2',
          });
          expect(
            yield* tiers.define({
              actingPrincipalId: scope.principalId,
              actionInvocationId: yield* nextId,
              effectivePeriod: { effectiveFrom: operationTime, effectiveTo: null },
              expectedState: { state: 'ABSENT' },
              identityKey,
              reason: 'Pricing native component threshold',
              requestCorrelationId: yield* nextId,
              resultingUnitPrice: { amount: '75', currencyCode: 'CZK' },
              trustedOperationAt: DateTime.toDateUtc(DateTime.makeUnsafe(operationTime)),
            }),
          ).toMatchObject({ outcome: 'QUANTITY_TIER_CREATED' });
          return { handoff, priceRef: command.priceRef };
        }),
      { concurrency: 1 },
    );
  });
interface CatalogSigningInput {
  readonly actor: typeof TrustedPrincipalContextSchema.Type;
  readonly buildMarker: string;
  readonly compositionRevision: string;
  readonly issuedAt: DateTime.Utc;
  readonly issuer: string;
  readonly kid: string;
  readonly privateKey: Parameters<typeof globalThis.crypto.subtle.sign>[1];
}
const issueCatalogAuthorization = (input: CatalogSigningInput) =>
  Effect.gen(function* issueCatalogAuthorizationProgram() {
    const { actor } = input;
    const now = Math.floor(DateTime.toEpochMillis(input.issuedAt) / 1000);
    const headerSchema = Schema.Struct({
      alg: Schema.Literal('EdDSA'),
      kid: Schema.String,
      typ: Schema.Literal('JWT'),
    });
    const header = Buffer.from(
      yield* Schema.encodeEffect(Schema.fromJsonString(headerSchema))({ alg: 'EdDSA', kid: input.kid, typ: 'JWT' }),
    ).toString('base64url');
    const claims = yield* decodeSupportedGatewayContextClaims({
      aud: 'catalog',
      compositionRevision: input.compositionRevision,
      exp: now + GATEWAY_ASSERTION_TTL_SECONDS,
      iat: now,
      iss: input.issuer,
      jti: yield* nextId,
      principal: actor,
      sub: actor.principalId,
      targetBuildMarker: input.buildMarker,
      ver: EXTERNAL_GATEWAY_ASSERTION_VERSION,
    });
    const payload = Buffer.from(
      yield* Schema.encodeEffect(Schema.fromJsonString(SupportedGatewayContextClaimsSchema))(claims),
    ).toString('base64url');
    const content = `${header}.${payload}`;
    // Bound thunks keep the WebCrypto promises out of async-function syntax, which two repository rules forbid.
    const { subtle } = globalThis.crypto;
    const signature = yield* Effect.tryPromise({
      catch: () => unavailable('assertion-sign'),
      try: subtle.sign.bind(subtle, 'Ed25519', input.privateKey, new TextEncoder().encode(content)),
    });
    return `Bearer ${content}.${Buffer.from(signature).toString('base64url')}`;
  });
const declaredMarketPrerequisite1225 = (payload: PricingCurrentMarketEvidenceRequest, nativeClock: Clock.Clock) =>
  Effect.gen(function* declaredMarketResponse1225() {
    const encodedRequest = yield* Schema.encodeEffect(PricingCurrentMarketEvidenceRequestSchema)(payload);
    const { channel, marketRef, sellingLegalEntityRef } = payload.commercialScope;
    const observedAt = DateTime.formatIso(yield* DateTime.now);
    // The owner answers a verification request with the proof it was asked about, so the reference is stable.
    const marketVerificationRef = 'TEST:harness:market-proof';
    const declared = {
      market: {
        channels: [channel],
        definitionRevisionRef: {
          ...marketRef,
          resourceId: 'TEST:1225:market-definition',
          resourceType: 'commerce.market-catalog.market-definition-revision',
        },
        effectivePeriod: { startsAt: encodedRequest.effectiveAt },
        jurisdictions: [{ code: 'CZ', kind: 'COUNTRY' }],
        lifecycle: 'ACTIVE',
        marketCode: 'CZ',
        marketRef,
        purpose: 'Explicit TEST non-Catalog prerequisite',
        revision: 1,
        sellingLegalEntityRef,
        supportedLocales: ['cs-CZ'],
      },
      outcome: 'PRICING_MARKET_SOURCE_PRESENT',
      receipt: {
        authority: {
          generation: 1,
          observedAt,
          ownerRootRef: 'TEST:1225:market-root',
          ownerSetRevisionRef: 'TEST:1225:market-set',
          predicateRef: 'TEST:1225:market-predicate',
          verificationRef: marketVerificationRef,
        },
        currentFacts: [
          {
            effectivePeriod: { startsAt: encodedRequest.effectiveAt },
            factRef: marketRef.resourceId,
            factRevisionRef: 'TEST:1225:market-definition',
            verificationRef: marketVerificationRef,
          },
        ],
        state: 'PRESENT',
      },
      request: encodedRequest,
    };
    // A generation-confirmation request is answered with the instant the owner verified through.
    if (encodedRequest.verifyThrough !== undefined) {
      Object.assign(declared, { verifiedThrough: encodedRequest.verifyThrough });
    }
    const response = yield* Schema.decodeUnknownEffect(PricingCurrentMarketEvidenceResponseSchema)(declared);
    return yield* Schema.encodeEffect(PricingCurrentMarketEvidenceResponseSchema)(response);
  }).pipe(Effect.orDie, Effect.provideService(Clock.Clock, nativeClock));
const catalogBuildIdentitySchema = Schema.Struct({ buildMarker: Schema.String, sourceRevision: Schema.String });
const currentCatalogBuildIdentity = Effect.fn('WholeCandidate.currentCatalogBuildIdentity')(
  function* currentIdentity() {
    // Resolve independently from the actual workspace and generation metadata, never from the description being checked.
    const program = `import { Effect, FileSystem, ManagedRuntime, Schema } from 'effect';
    import { NodeServices } from '@effect/platform-node';
    import { resolveUltramodernReleaseIdentity } from '@modern-js/app-tools-extensions/release-identity';
    const runtime = ManagedRuntime.make(NodeServices.layer);
    try { const text = await runtime.runPromise(Effect.gen(function* resolveCurrentCatalogIdentity() {
      const fs = yield* FileSystem.FileSystem;
      const unit = Schema.Struct({id: Schema.String,
        deliveryUnit: Schema.Struct({buildMarker: Schema.String, unitId: Schema.String})});
      const topology = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Struct({verticals: Schema.Array(unit)})))(
        yield* fs.readFileString('./topology/reference-topology.json'));
      const catalog = yield* Schema.decodeUnknownEffect(unit)(topology.verticals.find(entry => entry.id === 'catalog'));
      const identity = yield* Effect.try(() => resolveUltramodernReleaseIdentity({
        generationBuildMarker: catalog.deliveryUnit.buildMarker,
        unitId: catalog.deliveryUnit.unitId, workspaceRoot: process.cwd()
      }));
      return JSON.stringify({buildMarker: identity.buildMarker, sourceRevision: identity.sourceRevision});
    })); process.stdout.write(text); } finally { await runtime.dispose(); }`;
    const child = yield* ChildProcess.make(
      process.execPath,
      ['--experimental-strip-types', '--input-type=module', '--eval', program],
      { cwd: appRoot, stderr: 'pipe', stdin: 'ignore', stdout: 'pipe' },
    );
    const [code, output] = yield* Effect.all(
      [child.exitCode, child.stdout.pipe(Stream.decodeText(), Stream.mkString), Stream.runDrain(child.stderr)],
      { concurrency: 3 },
    );
    expect(code).toBe(0);
    return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(catalogBuildIdentitySchema))(output);
  },
);

const readOwnerContractDocument = Effect.fn('PublicPricingReadHarness.ownerContract')(function* readOwnerContract(
  vertical: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = `${appRoot}verticals/${vertical}/dist/public/.well-known/ontos-module-manifest.json`;
  return yield* fs
    .readFileString(path)
    .pipe(Effect.mapError(() => unavailable(`owner-contract-not-built:${vertical}`)));
});

const deriveHarnessSnapshot = Effect.fn('PublicPricingReadHarness.deriveSnapshot')(function* deriveSnapshot(
  catalogContractDocument: string,
  pricingContractDocument: string,
  extraContractDocuments: readonly string[],
) {
  const catalogContract = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(OntosModuleDeploymentContractSchema))(
    catalogContractDocument,
  );
  const fs = yield* FileSystem.FileSystem;
  const topology = yield* Schema.decodeUnknownEffect(
    Schema.fromJsonString(
      Schema.Struct({
        shell: Schema.Struct({ moduleFederation: Schema.Struct({ name: Schema.NonEmptyString }) }),
      }),
    ),
  )(yield* fs.readFileString(`${appRoot}topology/reference-topology.json`));
  const boundaries = new Set(catalogContract.manifest.publicSurface.components.map(({ mfBoundaryId }) => mfBoundaryId));
  const [catalogBoundary] = boundaries;
  if (boundaries.size !== 1 || catalogBoundary === undefined) {
    return yield* unavailable('catalog-source-mf-boundary');
  }
  const sourceFederationSchema = Schema.Struct({
    exposes: Schema.Array(Schema.Struct({ path: Schema.String })),
    name: Schema.String,
    shared: Schema.Array(Schema.Never),
  });
  const catalogManifestPath = `${appRoot}verticals/catalog/.output/mf-manifest.json`;
  const shellManifestPath = `${appRoot}apps/shell-super-app/.output/mf-manifest.json`;
  const available = yield* Effect.all({ catalog: fs.exists(catalogManifestPath), shell: fs.exists(shellManifestPath) });
  const observedBuildPair = available.catalog && available.shell;
  // SOURCE-native fixture observations when backend-only CI has no browser artifacts; no browser receipt is claimed.
  const metadata = yield* Effect.all({
    catalog: observedBuildPair
      ? fs.readFileString(catalogManifestPath)
      : Schema.encodeEffect(Schema.fromJsonString(sourceFederationSchema))({
          exposes: catalogContract.manifest.publicSurface.components.map(({ expose }) => ({ path: expose })),
          name: catalogBoundary,
          shared: [],
        }),
    shell: observedBuildPair
      ? fs.readFileString(shellManifestPath)
      : Schema.encodeEffect(Schema.fromJsonString(sourceFederationSchema))({
          exposes: [],
          name: topology.shell.moduleFederation.name,
          shared: [],
        }),
  });
  // Pricing is an actual API-only owner with no MF boundary or public components; its observation is server-only.
  const documents = new Map<string, string>([
    ['/catalog/source-native-mf-fixture.json', metadata.catalog],
    ['/shell-super-app/source-native-mf-fixture.json', metadata.shell],
  ]);
  const server = Context.get(yield* Layer.build(NodeHttpServer.layerTest), HttpServer.HttpServer);
  yield* server.serve(
    Effect.gen(function* serveActualOwnerMetadata() {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const document = documents.get(request.url);
      return document === undefined
        ? HttpServerResponse.empty({ status: 404 })
        : HttpServerResponse.text(document, { contentType: 'application/json' });
    }),
  );
  const address = yield* Schema.decodeUnknownEffect(Schema.Struct({ port: Schema.Number }))(server.address);
  const origin = `http://127.0.0.1:${address.port}`;
  const bridgeInputSchema = Schema.Struct({
    metadata: Schema.Array(Schema.Tuple([Schema.String, Schema.String])),
    sourceDocuments: Schema.Array(Schema.String),
  });
  const [inputDocument, inputPath] = yield* Effect.all([
    Schema.encodeEffect(Schema.fromJsonString(bridgeInputSchema))({
      metadata: [...documents.entries()],
      sourceDocuments: [catalogContractDocument, pricingContractDocument, ...extraContractDocuments],
    }),
    fs.makeTempFileScoped({ prefix: 'ontos-whole-candidate-', suffix: '.json' }),
  ]);
  yield* fs.writeFileString(inputPath, inputDocument);
  const literals = yield* Effect.all({
    origin: Schema.encodeEffect(Schema.fromJsonString(Schema.String))(origin),
    shellFederationUrl: Schema.encodeEffect(Schema.fromJsonString(Schema.String))(
      `${origin}/shell-super-app/source-native-mf-fixture.json`,
    ),
  });
  // The existing publisher derives the two actual contracts, observed MF bytes and canonical revision together.
  const program = `import { DateTime, Duration, Effect, FileSystem, ManagedRuntime, Schema } from 'effect';
    import { NodeServices } from '@effect/platform-node';
    import { resolveUltramodernReleaseIdentity } from '@modern-js/app-tools-extensions/release-identity';
    import { createShellRuntimeContract } from './scripts/generate-ontos-shell-runtime-contract.mts';
    import { deriveActiveApplicationCompositionSnapshot } from './scripts/active-application-composition.mts';
    import { makeApplicationCompositionSnapshotFixture } from '@app/core-runtime/testing/module-contract';
    import { ActiveApplicationCompositionSnapshotSchema, OntosModuleDeploymentContractSchema, OntosShellRuntimeContractSchema } from '@app/core-runtime';
    const runtime = ManagedRuntime.make(NodeServices.layer);
    try { const text = await runtime.runPromise(Effect.gen(function* deriveWholeCandidateOwners() {
      const fs = yield* FileSystem.FileSystem;
      const unit = Schema.Struct({id: Schema.String,
        deliveryUnit: Schema.Struct({buildMarker: Schema.String, unitId: Schema.String})});
      const topology = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Struct({shell: unit})))(
        yield* fs.readFileString('./topology/reference-topology.json'));
      const shellIdentity = yield* Effect.try(() => resolveUltramodernReleaseIdentity({
        generationBuildMarker: topology.shell.deliveryUnit.buildMarker,
        unitId: topology.shell.deliveryUnit.unitId, workspaceRoot: process.cwd()
      }));
      const input = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Struct({
        metadata: Schema.Array(Schema.Tuple([Schema.String, Schema.String])),
        sourceDocuments: Schema.Array(Schema.String)
      })), {onExcessProperty: 'error'})(yield* fs.readFileString(process.argv[1]));
      const sourceDocuments = input.sourceDocuments;
      const contracts = yield* Effect.forEach(sourceDocuments, document => Schema.decodeUnknownEffect(
        Schema.fromJsonString(OntosModuleDeploymentContractSchema))(document));
      const initial = yield* makeApplicationCompositionSnapshotFixture(contracts.map(contract => contract.deployment.appId),
        Object.fromEntries(contracts.map(contract => [contract.deployment.appId, contract.deployment.buildMarker])));
      const metadata = new Map(input.metadata);
      const artifact = (url, document) => ({url, bytes: new TextEncoder().encode(document)});
      const modules = contracts.map((contract, index) => {
        const placement = initial.composition.modules.find(module => module.deployment.appId === contract.deployment.appId);
        const path = '/' + contract.deployment.appId + '/source-native-mf-fixture.json';
        if (placement === undefined) { throw new Error('Actual owner placement is missing'); }
        const observed = {appId: contract.deployment.appId, backend: placement.backend,
          contract: artifact(placement.contract.url, sourceDocuments[index])};
        if (metadata.has(path)) { Object.assign(observed, {federationManifest: artifact(${literals.origin} + path, metadata.get(path))}); }
        return observed;
      });
      const shellDocument = yield* Schema.encodeEffect(Schema.fromJsonString(OntosShellRuntimeContractSchema))(
        createShellRuntimeContract(shellIdentity.buildMarker));
      const composition = yield* deriveActiveApplicationCompositionSnapshot({environment: 'development', modules,
        observedAt: initial.observedAt,
        shell: {runtimeContract: artifact(initial.composition.shell.runtimeContract.url, shellDocument),
          federationManifest: artifact(${literals.shellFederationUrl}, metadata.get('/shell-super-app/source-native-mf-fixture.json'))},
        validity: Duration.millis(DateTime.toEpochMillis(initial.validUntil) - DateTime.toEpochMillis(initial.observedAt))});
      return yield* Schema.encodeEffect(Schema.fromJsonString(ActiveApplicationCompositionSnapshotSchema))(composition);
    })); process.stdout.write(text); } finally { await runtime.dispose(); }`;
  const child = yield* ChildProcess.make(
    process.execPath,
    ['--experimental-strip-types', '--input-type=module', '--eval', program, inputPath],
    {
      cwd: appRoot,
      env: {
        APP_ENV_PATH: '/dev/null',
        HOME: yield* Config.String('HOME'),
        PATH: yield* Config.String('PATH'),
        TMPDIR: yield* Config.String('TMPDIR').pipe(Config.withDefault('/tmp')),
      },
      extendEnv: false,
      stderr: 'pipe',
      stdin: 'ignore',
      stdout: 'pipe',
    },
  );
  const [code, output] = yield* Effect.all(
    [child.exitCode, child.stdout.pipe(Stream.decodeText(), Stream.mkString), Stream.runDrain(child.stderr)],
    { concurrency: 3 },
  );
  expect(code).toBe(0);
  const snapshot = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ActiveApplicationCompositionSnapshotSchema))(
    output,
  );
  const pricing = snapshot.composition.modules.find(({ moduleId }) => moduleId === PRICING_MODULE);
  expect(pricing?.contractDocument).toBe(pricingContractDocument);
  expect(snapshot.composition.modules.find(({ deployment }) => deployment.appId === 'catalog')?.contractDocument).toBe(
    catalogContractDocument,
  );
  return snapshot;
});

// Real built contracts for every owner whose Pricing requirement the registered Read gates on.
const harnessContractVerticals = [
  'commerce-market-catalog',
  'commerce-customer-context',
  'price-group-catalog',
] as const;
const HARNESS_PRICING_AUDIENCES = [
  'catalog',
  'commerce-market-catalog',
  CUSTOMER_CONTEXT_AUDIENCE,
  PRICE_GROUP_CATALOG_AUDIENCE,
  'pricing',
];

const productionReadRuntime = (
  runtimeConnectionString: string,
  composition: typeof ActiveApplicationCompositionSnapshotSchema.Type,
  selectableLegalEntityIds: readonly string[],
  deployment: { readonly appId: string; readonly buildMarker: string },
) => {
  const database = Layer.effect(DatabaseConfig, parseDatabaseConfig({ DATABASE_URL: runtimeConnectionString }));
  const persistence = CorePersistenceLive.pipe(Layer.provide(database));
  const states = TenantModuleStateServiceLive.pipe(Layer.provide(persistence));
  const gate = ModuleStateGateLive.pipe(Layer.provide(states));
  const gateway = ModuleEntrypointGatewayLive.pipe(Layer.provide(gate));
  const access = makeTestAccessGateLayers({
    selectableLegalEntityIds,
    spec: { defaultAnswer: { outcome: 'ALLOWED' } },
  });
  const scopes = OperationalScopeResolverLive.pipe(
    Layer.provide(Layer.mergeAll(persistence, ContextAccessLive, access)),
  );
  const common = Layer.mergeAll(
    persistence,
    ContextAccessLive,
    gate,
    gateway,
    scopes,
    access,
    staffAuthenticationNamespaceRegistryLayer(['pricing']),
    makeActiveApplicationCompositionLayer(Effect.succeed(composition)),
    ModuleCallRouteLive.pipe(Layer.provide(Layer.mergeAll(NodeCrypto.layer, FetchHttpClient.layer))),
  );
  return makeReadRuntimeLive(deployment, pricingRegistration).pipe(
    Layer.provide(common),
    Layer.provide(NodeCrypto.layer),
  );
};

export interface PublicPricingReadHarnessOptions {
  readonly nativeClock: Clock.Clock;
}

const HarnessFeeSetObservationSchema = Schema.Struct({
  completenessObservedAt: Schema.DateTimeUtc,
  currentnessObservedAt: Schema.DateTimeUtc,
  currentnessRevalidatedAt: Schema.DateTimeUtc,
  /** The effective period of every Fee in the set; an owner-proven empty set has none. */
  feeEffectivePeriods: Schema.Array(
    Schema.Struct({ effectiveFrom: Schema.DateTimeUtc, effectiveTo: Schema.OptionFromNullOr(Schema.DateTimeUtc) }),
  ),
  /** The owner's next applicability boundary, when it reported one. */
  nextApplicabilityBoundary: Schema.Option(Schema.DateTimeUtc),
  /** `observedAt` of the set as the owner issued it: the actual owner observation, not the requested instant. */
  observedAt: Schema.DateTimeUtc,
  ownerReceiptObservedAt: Schema.DateTimeUtc,
});

/** One Commercial Fee Current set exactly as the Read retained it for the Pricing owner fence (never rewritten). */
export type HarnessFeeSetObservation = typeof HarnessFeeSetObservationSchema.Type;

/** One owner final-fence call and its typed outcome, kept beside the customer-safe projection. */
export interface HarnessFenceObservation {
  /** Sizes of the Catalog Pricing-purpose equivalence groups handed to this owner (one entry per group). */
  readonly equivalenceGroupSizes: readonly number[];
  readonly failure?: string;
  /** Kinds of owner-native source material the Read retained and handed to this owner, in order. */
  readonly materialKinds: readonly string[];
  readonly operation: string;
  readonly owner: string;
}

/** One whole-attempt result, so a customer-safe non-success stays diagnosable. */
export interface HarnessWholeAttemptObservation {
  /** The requested as-of instant of the owner fence request the attempt retained, when it retained one. */
  readonly effectiveAt: Option.Option<DateTime.Utc>;
  /** The Commercial Fee Current sets the attempt retained for its owner final fence, as the owner issued them. */
  readonly feeSets: readonly HarnessFeeSetObservation[];
  readonly kind: string;
  readonly outcome: string;
  readonly reason?: string;
}

const recordFence = (observed: HarnessFenceObservation[], entry: HarnessFenceObservation) =>
  Effect.sync(() => {
    observed.push(entry);
  });

interface ObservedTypedSources {
  readonly typedSources?: readonly { readonly verificationMaterial: { readonly kind: string } }[];
}

const isEquivalenceMaterial = Schema.is(
  Schema.Struct({
    kind: Schema.Literal('CATALOG_EQUIVALENCE_AUTHORITY'),
    request: Schema.Struct({ members: Schema.Array(Schema.Unknown) }),
  }),
);

const FeeAuthorityMaterialSchema = Schema.Struct({
  currentSet: Schema.Struct({
    completenessEvidence: Schema.Struct({
      nextApplicabilityBoundary: Schema.optionalKey(Schema.DateTimeUtcFromString),
      observedAt: Schema.DateTimeUtcFromString,
    }),
    currentnessEvidence: Schema.Struct({
      observedAt: Schema.DateTimeUtcFromString,
      revalidatedAt: Schema.DateTimeUtcFromString,
    }),
    fees: Schema.Array(
      Schema.Struct({
        effectivePeriod: Schema.Struct({
          effectiveFrom: Schema.DateTimeUtcFromString,
          effectiveTo: Schema.OptionFromNullOr(Schema.DateTimeUtcFromString),
        }),
      }),
    ),
    observedAt: Schema.DateTimeUtcFromString,
  }),
  kind: Schema.Literal('PRICING_COMMERCIAL_FEE_AUTHORITY'),
  ownerReadReceipt: Schema.Struct({ authority: Schema.Struct({ observedAt: Schema.DateTimeUtcFromString }) }),
});
const decodeFeeAuthorityMaterial = Schema.decodeUnknownOption(FeeAuthorityMaterialSchema);

const feeSetObservationsOf = (materials: readonly unknown[]): readonly HarnessFeeSetObservation[] =>
  materials.flatMap((material) =>
    Option.match(decodeFeeAuthorityMaterial(material), {
      onNone: () => [],
      onSome: ({ currentSet, ownerReadReceipt }) => [
        {
          completenessObservedAt: currentSet.completenessEvidence.observedAt,
          currentnessObservedAt: currentSet.currentnessEvidence.observedAt,
          currentnessRevalidatedAt: currentSet.currentnessEvidence.revalidatedAt,
          feeEffectivePeriods: currentSet.fees.map(({ effectivePeriod }) => effectivePeriod),
          nextApplicabilityBoundary: Option.fromNullishOr(currentSet.completenessEvidence.nextApplicabilityBoundary),
          observedAt: currentSet.observedAt,
          ownerReceiptObservedAt: ownerReadReceipt.authority.observedAt,
        },
      ],
    }),
  );

const fenceObservationOf = (
  input: ObservedTypedSources,
  entry: Pick<HarnessFenceObservation, 'failure' | 'operation' | 'owner'>,
): HarnessFenceObservation => {
  const materials = (input.typedSources ?? []).map(({ verificationMaterial }) => verificationMaterial);
  const observation = {
    equivalenceGroupSizes: materials.flatMap((material) =>
      isEquivalenceMaterial(material) ? [material.request.members.length] : [],
    ),
    materialKinds: materials.map(({ kind }) => kind),
    operation: entry.operation,
    owner: entry.owner,
  };
  return entry.failure === undefined ? observation : { ...observation, failure: entry.failure };
};

const observeGateway = (
  gateway: PricingOwnerMaterialEvidenceFenceGateway,
  owner: string,
  observed: HarnessFenceObservation[],
): PricingOwnerMaterialEvidenceFenceGateway => ({
  confirmObservedGenerationsThrough: (input) =>
    gateway.confirmObservedGenerationsThrough(input).pipe(
      Effect.tap(() => recordFence(observed, fenceObservationOf(input, { operation: 'confirm', owner }))),
      Effect.tapError((cause) =>
        recordFence(observed, fenceObservationOf(input, { failure: cause._tag, operation: 'confirm', owner })),
      ),
    ),
  verifyOpaqueProofsAgainstCurrentState: (input) =>
    gateway.verifyOpaqueProofsAgainstCurrentState(input).pipe(
      Effect.tap(() => recordFence(observed, fenceObservationOf(input, { operation: 'verify', owner }))),
      Effect.tapError((cause) =>
        recordFence(observed, fenceObservationOf(input, { failure: cause._tag, operation: 'verify', owner })),
      ),
    ),
});

/** Records each owner final-fence call and its typed outcome; the wrapped gateway still decides everything. */
const observeOwnerFence = <Self>(
  tag: Context.Service<Self, PricingOwnerMaterialEvidenceFenceGateway>,
  owner: string,
  observed: HarnessFenceObservation[],
) =>
  Layer.effect(
    tag,
    Effect.gen(function* observeFence() {
      return observeGateway(yield* tag, owner, observed);
    }),
  );

const RetainedOwnerFenceRequestSchema = Schema.Struct({
  materialEvidence: Schema.Struct({
    sourceEvidence: Schema.Struct({
      ownerFenceRequest: Schema.Struct({
        effectiveAt: Schema.DateTimeUtcFromString,
        sources: Schema.Array(Schema.Struct({ verificationMaterial: Schema.Unknown })),
      }),
    }),
  }),
});
const decodeRetainedOwnerFenceRequest = Schema.decodeUnknownOption(RetainedOwnerFenceRequestSchema);

const recordWholeAttempt = (
  observed: HarnessWholeAttemptObservation[],
  whole: {
    readonly attempt: { readonly kind: string; readonly publicationRequest?: unknown; readonly reason?: string };
    readonly outcome: { readonly outcome: string };
  },
) =>
  Effect.sync(() => {
    const { attempt, outcome } = whole;
    // A READY attempt retained the owner fence request its final publication hands to the owners.
    const retained = decodeRetainedOwnerFenceRequest(attempt.publicationRequest);
    const fenceRequest = retained.pipe(
      Option.map(({ materialEvidence }) => materialEvidence.sourceEvidence.ownerFenceRequest),
    );
    const entry = {
      effectiveAt: fenceRequest.pipe(Option.map(({ effectiveAt }) => effectiveAt)),
      feeSets: feeSetObservationsOf(
        Option.match(fenceRequest, {
          onNone: () => [],
          onSome: ({ sources }) => sources.map(({ verificationMaterial }) => verificationMaterial),
        }),
      ),
      kind: attempt.kind,
      outcome: outcome.outcome,
    };
    observed.push(attempt.reason === undefined ? entry : { ...entry, reason: attempt.reason });
  });

/**
 * TEST-ONLY interference point (declared, never production behaviour): an optional hook that runs after each whole
 * attempt returned its result and before that attempt's final publication and owner fences, i.e. exactly where a
 * concurrent owner write between "read" and "fence" lands. It decides nothing itself.
 */
interface HarnessAttemptHooks {
  afterWholeAttempt: ((ordinal: number) => Effect.Effect<void>) | null;
}

/** A failing hook is a test defect, so it surfaces as one instead of being absorbed by the Read. */
const hookWithCrypto = (hook: (ordinal: number) => HarnessEffect<void>, crypto: Crypto.Crypto) => (ordinal: number) =>
  hook(ordinal).pipe(Effect.provideService(Crypto.Crypto, crypto), Effect.orDie);

const observeWholeEvaluation = (
  factory: CurrentPricingDecisionEvaluationFactoryService,
  observed: HarnessWholeAttemptObservation[],
  hooks: HarnessAttemptHooks,
): CurrentPricingDecisionEvaluationFactoryService => ({
  make: (source, ...rest) =>
    factory.make(
      {
        ...source,
        loadFresh: (...input) =>
          source.loadFresh(...input).pipe(
            Effect.tap((whole) => recordWholeAttempt(observed, whole)),
            Effect.tap(() => hooks.afterWholeAttempt?.(input[2]) ?? Effect.void),
          ),
      },
      ...rest,
    ),
});

const observeEvaluationFactory = (observed: HarnessWholeAttemptObservation[], hooks: HarnessAttemptHooks) =>
  Layer.effect(
    CurrentPricingDecisionEvaluationFactory,
    Effect.gen(function* observeFactory() {
      return observeWholeEvaluation(yield* CurrentPricingDecisionEvaluationFactory, observed, hooks);
    }),
  );

/**
 * Production wiring for the registered Read. The only additions are pass-through observers of each whole attempt
 * and each owner final-fence call, plus the declared test-only attempt hook; they change nothing the owner
 * evaluation or the owners decide.
 */
const productionReadCollaborators = (
  observed: HarnessWholeAttemptObservation[],
  fences: HarnessFenceObservation[],
  hooks: HarnessAttemptHooks,
) =>
  observeEvaluationFactory(observed, hooks).pipe(
    Layer.provide(currentPricingDecisionEvaluationFactoryLive),
    Layer.provideMerge(pricingExternalOwnerEvidenceValidationService),
    Layer.provideMerge(pricingOrdinaryCurrentPublicationLive),
    Layer.provideMerge(
      Layer.mergeAll(
        observeOwnerFence(PricingCatalogMaterialEvidenceFenceGateway, 'catalog', fences),
        observeOwnerFence(PricingCustomerContextMaterialEvidenceFenceGateway, 'customer-context', fences),
        observeOwnerFence(PricingMarketMaterialEvidenceFenceGateway, 'market', fences),
        observeOwnerFence(PricingPromotionMaterialEvidenceFenceGateway, 'promotion', fences),
      ).pipe(Layer.provideMerge(pricingCurrentDecisionOwnerFinalFenceGatewaysLive)),
    ),
  );

const HarnessFeeFamilySchema = Schema.Literals(['COPYRIGHT_FEE', 'RECYCLING_FEE']);
type HarnessFeeFamily = typeof HarnessFeeFamilySchema.Type;

const harnessFeeIdentityKey = (
  legalEntityId: string,
  handoff: typeof CatalogQuantityHandoffReadySchema.Type,
  family: HarnessFeeFamily,
) => ({
  calculationBasis: { kind: 'FIXED_PER_LINE' as const },
  commercialScope: { ...HARNESS_MARKET, sellingLegalEntityId: legalEntityId },
  currencyCode: 'CZK' as const,
  family,
  monetaryBoundary: 'PRE_TAX' as const,
  target: { variantRef: handoff.selection.variantRef },
});

const harnessFeeCatalogTargetEvidence = (
  handoff: typeof CatalogQuantityHandoffReadySchema.Type,
  capturedAt: string,
) => {
  const { productRef, variantRef } = handoff.selection;
  return {
    capturedAt,
    catalogOwnerRevision: handoff.ownerRevision,
    productRef,
    snapshotId: `TEST:harness:fee-catalog-snapshot:${variantRef.resourceId}`,
    targetId: `TEST:harness:fee-target:${variantRef.resourceId}`,
    variantRef,
  };
};

const defineHarnessCommercialFee = Effect.fn('PublicPricingReadHarness.defineCommercialFee')(
  function* defineHarnessCommercialFee(
    transaction: ScopedTransactionExecutor,
    scope: OperationalScope,
    input: {
      readonly amount: string;
      readonly effectiveFrom: string;
      readonly effectiveTo?: string | null;
      readonly family?: HarnessFeeFamily;
      readonly handoff: typeof CatalogQuantityHandoffReadySchema.Type;
      /** The trusted operation instant of the write; defaults to `effectiveFrom` (a past instant). */
      readonly trustedOperationAt?: string;
    },
  ) {
    const { legalEntityId } = scope;
    if (legalEntityId === undefined) {
      return yield* unavailable('harness-fee-requires-legal-entity-scope');
    }
    const persistence = yield* commercialFeePersistenceForScope(transaction, scope);
    const actionInvocationId = yield* nextId;
    const trustedOperationAt = input.trustedOperationAt ?? input.effectiveFrom;
    return yield* persistence.define({
      actingPrincipalId: scope.principalId,
      actionInvocationId,
      catalogTargetEvidence: harnessFeeCatalogTargetEvidence(input.handoff, trustedOperationAt),
      configuredAmount: { amount: input.amount, currencyCode: 'CZK' },
      effectivePeriod: { effectiveFrom: input.effectiveFrom, effectiveTo: input.effectiveTo ?? null },
      identityKey: harnessFeeIdentityKey(legalEntityId, input.handoff, input.family ?? 'RECYCLING_FEE'),
      reason: 'Pricing public Read harness Fee',
      requestCorrelationId: actionInvocationId,
      trustedOperationAt: DateTime.toDateUtc(DateTime.makeUnsafe(trustedOperationAt)),
    });
  },
);

/**
 * A value-only revision of the Current Fee through Pricing's own scoped persistence: the revised amount is effective
 * from `effectiveFrom` (a past instant), so a later read at an instant after it sees the new revision.
 */
const reviseHarnessCommercialFee = Effect.fn('PublicPricingReadHarness.reviseCommercialFee')(
  function* reviseHarnessCommercialFee(
    transaction: ScopedTransactionExecutor,
    scope: OperationalScope,
    input: {
      readonly amount: string;
      readonly effectiveFrom: string;
      readonly family?: HarnessFeeFamily;
      readonly handoff: typeof CatalogQuantityHandoffReadySchema.Type;
    },
  ) {
    const { legalEntityId } = scope;
    if (legalEntityId === undefined) {
      return yield* unavailable('harness-fee-requires-legal-entity-scope');
    }
    const persistence = yield* commercialFeePersistenceForScope(transaction, scope);
    const identityKey = harnessFeeIdentityKey(legalEntityId, input.handoff, input.family ?? 'RECYCLING_FEE');
    const trustedOperationAt = DateTime.toDateUtc(DateTime.makeUnsafe(input.effectiveFrom));
    const schedule = yield* persistence.readSchedule({ identityKey, trustedOperationAt });
    if (schedule.outcome !== 'COMMERCIAL_FEE_SCHEDULE' || schedule.schedule.current === undefined) {
      return yield* unavailable('harness-fee-revision-requires-current-fee');
    }
    const { current } = schedule.schedule;
    const actionInvocationId = yield* nextId;
    const revised = yield* persistence.revise({
      actingPrincipalId: scope.principalId,
      actionInvocationId,
      catalogTargetEvidence: harnessFeeCatalogTargetEvidence(input.handoff, input.effectiveFrom),
      configuredAmount: { amount: input.amount, currencyCode: 'CZK' },
      effectiveFrom: input.effectiveFrom,
      expectedCurrent: {
        effectivePeriod: current.effectivePeriod,
        feeRef: current.definition.feeRef,
        identityKey,
        revision: current.definition.revision.revision,
        revisionId: current.definition.revision.revisionId,
        scheduleRevision: schedule.schedule.scheduleRevision,
      },
      identityKey,
      intent: 'VALUE_ONLY_CURRENT',
      reason: 'Pricing public Read harness Fee revision',
      requestCorrelationId: actionInvocationId,
      trustedOperationAt,
    });
    expect(revised.outcome).toBe('COMMERCIAL_FEE_REVISED');
    return revised;
  },
);

/**
 * Re-produces a Pricing Quantity Tier under a revised Catalog Unit rule through Pricing's own scoped persistence: the
 * Tier bound to the superseded rule is retired and an equivalent Tier is defined for the fresh Quantity Basis.
 * Pricing never rebinds a Tier on its own; selection fails closed while a Tier for another rule is still Current.
 */
const reproduceHarnessTier = Effect.fn('PublicPricingReadHarness.reproduceTier')(function* reproduceHarnessTier(
  transaction: ScopedTransactionExecutor,
  scope: OperationalScope,
  input: {
    readonly fresh: typeof CatalogQuantityHandoffReadySchema.Type;
    readonly previous: typeof CatalogQuantityHandoffReadySchema.Type;
    readonly priceRef: typeof PriceRefSchema.Type;
    readonly resultingUnitPrice: string;
    readonly thresholdQuantity: string;
  },
) {
  const tiers = yield* quantityTierPersistenceForScope(transaction, scope);
  const keyFor = (handoff: typeof CatalogQuantityHandoffReadySchema.Type) =>
    Schema.decodeUnknownEffect(QuantityTierIdentityKeySchema)({
      priceRef: input.priceRef,
      quantityBasis: {
        catalogQuantityBasis: handoff.quantityBasis,
        priceUnitBasis: { quantity: '1', unitRef: handoff.unitRef },
      },
      thresholdQuantity: input.thresholdQuantity,
    });
  const previousKey = yield* keyFor(input.previous);
  const freshKey = yield* keyFor(input.fresh);
  const trustedOperationAt = DateTime.toDateUtc(yield* DateTime.now);
  const effectiveAt = DateTime.formatIso(DateTime.fromDateUnsafe(trustedOperationAt));
  const schedule = yield* tiers.readSchedule({ identityKey: previousKey, trustedOperationAt });
  if (schedule.outcome !== 'QUANTITY_TIER_SCHEDULE_CURRENT' || schedule.schedule.current === undefined) {
    return yield* unavailable('harness-tier-previous-not-current');
  }
  const { current } = schedule.schedule;
  const retired = yield* tiers.revise({
    actingPrincipalId: scope.principalId,
    actionInvocationId: yield* nextId,
    effectiveTo: effectiveAt,
    expectedCurrent: {
      effectivePeriod: current.effectivePeriod,
      identityKey: previousKey,
      revision: current.definition.revision.revision,
      revisionId: current.definition.revision.revisionId,
      scheduleRevision: schedule.schedule.scheduleRevision,
    },
    identityKey: previousKey,
    intent: 'RETIRE_CURRENT',
    reason: 'Pricing public Read harness: retire the Tier bound to the superseded Unit rule',
    requestCorrelationId: yield* nextId,
    trustedOperationAt,
  });
  expect(retired.outcome).toBe('QUANTITY_TIER_REVISED');
  const defined = yield* tiers.define({
    actingPrincipalId: scope.principalId,
    actionInvocationId: yield* nextId,
    effectivePeriod: { effectiveFrom: effectiveAt, effectiveTo: null },
    expectedState: { state: 'ABSENT' },
    identityKey: freshKey,
    reason: 'Pricing public Read harness: Tier under the revised Unit rule',
    requestCorrelationId: yield* nextId,
    resultingUnitPrice: { amount: input.resultingUnitPrice, currencyCode: 'CZK' },
    trustedOperationAt,
  });
  expect(defined.outcome).toBe('QUANTITY_TIER_CREATED');
  return defined;
});

const defineHarnessContractualDiscount = Effect.fn('PublicPricingReadHarness.defineContractualDiscount')(
  function* defineHarnessContractualDiscount(
    transaction: ScopedTransactionExecutor,
    scope: OperationalScope,
    input: {
      readonly amount: string;
      readonly effectiveFrom: string;
      readonly handoff: typeof CatalogQuantityHandoffReadySchema.Type;
      readonly priceGroupRef: HarnessProfileIdentity['priceGroupRef'];
    },
  ) {
    const { legalEntityId } = scope;
    if (legalEntityId === undefined) {
      return yield* unavailable('harness-discount-requires-legal-entity-scope');
    }
    const persistence = yield* contractualDiscountPersistenceForScope(transaction, scope);
    const actionInvocationId = yield* nextId;
    const identityKey = yield* Schema.decodeUnknownEffect(PricingDiscountIdentityKeySchema)({
      audience: { kind: 'PRICE_GROUP', priceGroupRef: input.priceGroupRef },
      basis: {
        catalogSelection: input.handoff.selection,
        kind: 'VARIANT_LINE',
        unitBasis: { quantity: '1', unitRef: input.handoff.unitRef },
      },
      commercialScope: { ...HARNESS_MARKET, sellingLegalEntityId: legalEntityId },
      currencyCode: 'CZK',
      effectKind: 'FIXED_MONETARY_AMOUNT',
      family: 'CONTRACTUAL_DISCOUNT',
      monetaryBoundary: 'PRE_TAX',
      scope: 'VARIANT_LINE',
    });
    const result = yield* persistence.manage({
      actingPrincipalId: scope.principalId,
      actionInvocationId,
      configuredEffect: { kind: 'FIXED_MONETARY_AMOUNT', level: { amount: input.amount, currencyCode: 'CZK' } },
      effectivePeriod: { effectiveFrom: input.effectiveFrom, effectiveTo: null },
      expectedState: { state: 'ABSENT' },
      identityKey,
      intent: 'CREATE',
      reason: 'Pricing public Read harness Discount',
      requestCorrelationId: actionInvocationId,
      trustedOperationAt: DateTime.toDateUtc(DateTime.makeUnsafe(input.effectiveFrom)),
    });
    expect(result.outcome).toBe('CONTRACTUAL_DISCOUNT_CREATED');
    return result;
  },
);

const isProfileSubject = Schema.is(Schema.Struct({ kind: Schema.Literal('PROFILE') }));

/** Declared Customer Context purchase-context verdict for a Guest or a Profile subject (published contract only). */
const declaredPurchaseContextEvidence = (request: {
  readonly actor: { readonly kind: string; readonly principalId?: string };
  readonly operationTime: string;
  readonly purchasingContext: {
    readonly channelId: string;
    readonly contextRef: string;
    readonly contextRevision: string;
    readonly marketId: string;
    readonly sellingLegalEntityId: string;
  };
  readonly subject: unknown;
  readonly tenantId: string;
}) =>
  Schema.decodeUnknownEffect(PricingPurchaseContextVerificationEvidenceSchema)({
    currentness: {
      evaluatedAt: request.operationTime,
      observedAt: request.operationTime,
      validFrom: request.operationTime,
      validTo: null,
    },
    ownerRef: request.purchasingContext.contextRef,
    ownerRevisionRef: request.purchasingContext.contextRevision,
    subjectAuthority: isProfileSubject(request.subject)
      ? {
          actorPrincipalId: request.actor.principalId,
          kind: 'PROFILE',
          partyAuthorityRef: 'TEST:harness:declared-party-authority',
          partyAuthorityRevisionRef: '1',
          subject: request.subject,
          subjectAuthorityRef: 'TEST:harness:declared-profile-authority',
          subjectAuthorityRevisionRef: '1',
        }
      : {
          guestEvidenceAuthorityRef: 'TEST:harness:declared-guest-authority',
          guestSessionAuthorityRef: 'TEST:harness:declared-session-authority',
          kind: 'GUEST',
          subject: request.subject,
          subjectAuthorityRevisionRef: '1',
        },
    verificationRef: 'TEST:harness:declared-purchase-verification',
    verifiedScope: {
      channelId: request.purchasingContext.channelId,
      legalEntityId: request.purchasingContext.sellingLegalEntityId,
      marketId: request.purchasingContext.marketId,
      tenantId: request.tenantId,
    },
  });

// Declared Price Group Catalog definition: one fixed revision, so the Customer Context assignment evidence and the
// Catalog compatibility answer agree exactly, as two published owner answers about one Price Group would.
const harnessPriceGroupDefinition = {
  catalogRevision: 1,
  definitionEffectivePeriod: { effectiveFrom: '2020-01-01T00:00:00.000Z', effectiveTo: null },
  definitionRevisionId: '10000000-0000-4000-8000-0000000012d5',
  definitionRevisionNumber: 1,
  meaningFingerprint: 'd'.repeat(64),
  requiredContract: { contractId: 'commerce.customer-price-group-assignment.v1', version: 1 },
} as const;
const HARNESS_PRICE_GROUP_GENERATION = 'TEST:harness:price-group-generation:1';

interface HarnessProfileIdentity {
  readonly assignmentRef: {
    readonly moduleId: string;
    readonly resourceId: string;
    readonly resourceType: string;
    readonly tenantId: string;
  };
  readonly priceGroupRef: {
    readonly moduleId: string;
    readonly resourceId: string;
    readonly resourceType: string;
    readonly tenantId: string;
  };
}

/** Declared Price Group Catalog answer: the one harness definition is USABLE for the exact requested group. */
const declaredPriceGroupCompatibility = (request: ValidatePriceGroupCompatibilityRequest, nativeClock: Clock.Clock) =>
  Effect.gen(function* declaredPriceGroupCompatibilityResponse() {
    // The Price Group Catalog verifies at the exact operation instant it was asked about.
    const decision = yield* Schema.decodeUnknownEffect(PriceGroupCompatibilityDecisionSchema)({
      evidence: {
        ...harnessPriceGroupDefinition,
        priceGroupRef: request.priceGroupRef,
        requiredContract: request.requiredContract,
        trustedOperationAt: request.trustedOperationAt,
        verifiedAt: request.trustedOperationAt,
      },
      kind: 'USABLE',
    });
    return yield* Schema.encodeEffect(PriceGroupCompatibilityDecisionSchema)(decision);
  }).pipe(Effect.orDie, Effect.provideService(Clock.Clock, nativeClock));

/**
 * Declared Customer Context answer: the harness Profile is ASSIGNED to the declared Price Group, with one stable
 * generation on every replay so the owner final fence can confirm it.
 */
const declaredCustomerPriceGroupResolution = (
  request: CustomerPriceGroupResolutionRequest,
  identity: HarnessProfileIdentity,
  nativeClock: Clock.Clock,
) =>
  Effect.gen(function* declaredCustomerPriceGroupResolutionResponse() {
    const clockNow = DateTime.formatIso(yield* DateTime.now);
    const observedAt = clockNow < request.effectiveAt ? request.effectiveAt : clockNow;
    const predicateRef = customerPriceGroupResolutionPredicateRef(request.profile, request.effectiveAt);
    const generation = HARNESS_PRICE_GROUP_GENERATION;
    const response = yield* Schema.decodeUnknownEffect(CustomerPriceGroupResolutionResponseSchema)({
      completenessEvidence: { observedAt, ownerRevision: generation, scope: { kind: 'EXACT_PREDICATE', predicateRef } },
      currentnessEvidence: {
        evaluatedAt: request.effectiveAt,
        generation,
        observedAt,
        ownerRevision: generation,
        predicateRef,
        revalidatedAt: observedAt,
        verificationMode: 'OWNER_CURRENT_SET_REVALIDATED',
      },
      effectiveAt: request.effectiveAt,
      generation,
      observedAt,
      profile: request.profile,
      resolution: {
        _tag: 'ASSIGNED',
        assignmentRef: identity.assignmentRef,
        assignmentRevision: 1,
        compatibility: {
          ...harnessPriceGroupDefinition,
          priceGroupRef: identity.priceGroupRef,
          trustedOperationAt: request.effectiveAt,
          verifiedAt: request.effectiveAt,
        },
        effectiveFrom: '2020-01-01T00:00:00.000Z',
        effectiveTo: null,
        priceGroupRef: identity.priceGroupRef,
      },
      verificationReceipt: {
        generation,
        issuedAt: observedAt,
        ownerModuleId: CUSTOMER_CONTEXT_MODULE,
        ownerRevision: generation,
        predicateRef,
        // One verification reference per observation, as the owner issues: one reference never names two proofs.
        verificationRef: `TEST:harness:declared-price-group-verification:${observedAt}`,
      },
    });
    return yield* Schema.encodeEffect(CustomerPriceGroupResolutionResponseSchema)(response);
  }).pipe(Effect.orDie, Effect.provideService(Clock.Clock, nativeClock));

type HarnessEffect<Success> = Effect.Effect<Success, WholeCandidateReceiverTestUnavailable, Crypto.Crypto>;
type HarnessCatalogHandoff = typeof CatalogQuantityHandoffReadySchema.Type;
type HarnessPriceGroupRef = HarnessProfileIdentity['priceGroupRef'];
interface HarnessProfileSubject {
  readonly authorizationSubject: { readonly kind: 'RETAIL' };
  readonly kind: 'PROFILE';
  readonly profileRef: HarnessProfileIdentity['assignmentRef'];
}
type HarnessCatalogSelection = typeof CatalogSelectionSchema.Type;

/** What a scenario may rely on; every member is produced through a supported owner path or the registered Read. */
export interface PublicPricingReadHarness {
  /**
   * Installs the declared test-only hook that runs after each whole attempt and before its final publication and
   * owner fences, with the attempt ordinal (1 or 2); `clearAfterWholeAttempt` removes it.
   */
  readonly afterWholeAttempt: (hook: (ordinal: number) => HarnessEffect<void>) => Effect.Effect<void>;
  /** Catalog-signed owner credential, for direct Catalog owner reads. */
  readonly authorization: (issuedAt: DateTime.Utc) => HarnessEffect<string>;
  readonly clearAfterWholeAttempt: () => Effect.Effect<void>;
  readonly composition: typeof ActiveApplicationCompositionSnapshotSchema.Type;
  readonly endpoint: { readonly baseUrl: URL; readonly compositionRevision: string };
  /** Every owner final-fence call of the registered Read, in order. */
  readonly fenceCalls: readonly HarnessFenceObservation[];
  readonly handoffs: {
    readonly p1: HarnessCatalogHandoff;
    readonly p2: HarnessCatalogHandoff;
    readonly q1: HarnessCatalogHandoff;
  };
  readonly legalEntityId: string;
  readonly makeRequest: (input: {
    readonly lines: readonly { readonly handoff: HarnessCatalogHandoff; readonly occurrenceId: string }[];
    readonly operationTime: string;
    /**
     * Guest by default; PROFILE selects the declared Price Group assignment and its Discount audience;
     * OTHER_GROUP_PROFILE is a Profile the declared Customer Context assigns to a different Price Group.
     */
    readonly subject?: 'GUEST' | 'OTHER_GROUP_PROFILE' | 'PROFILE';
  }) => HarnessEffect<typeof CurrentPricingDecisionRequestSchema.Type>;
  readonly managerPrincipalId: string;
  /** Requests the declared Commerce Market stand-in answered through the published contract. */
  readonly marketRequests: readonly PricingCurrentMarketEvidenceRequest[];
  readonly operationTime: string;
  /** A Profile the declared Customer Context assigns to a DIFFERENT Price Group than `priceGroupRef`. */
  readonly otherGroupProfileSubject: HarnessProfileSubject;
  readonly prepareFreshHandoff: (selection: HarnessCatalogSelection) => HarnessEffect<HarnessCatalogHandoff>;
  readonly priceComponents: readonly {
    readonly handoff: HarnessCatalogHandoff;
    readonly priceRef: typeof PriceRefSchema.Type;
  }[];
  /** Requests the declared Price Group Catalog stand-in answered. */
  readonly priceGroupCompatibilityRequests: readonly ValidatePriceGroupCompatibilityRequest[];
  /** The declared Price Group the harness Profile is assigned to; Discounts are produced for this audience. */
  readonly priceGroupRef: HarnessPriceGroupRef;
  /** Requests the declared Customer Context price-group stand-in answered, including final-fence replays. */
  readonly priceGroupRequests: readonly CustomerPriceGroupResolutionRequest[];
  /**
   * A Commercial Fee through Pricing's own scoped persistence. By default a RECYCLING_FEE effective from the harness
   * start with no end. `effectiveFrom` in the future keeps the Variant's Fee set owner-proven EMPTY at earlier
   * instants (Price admission initialised its Fee root); `effectiveTo` sets the Fee's end, i.e. the owner's next
   * applicability boundary; `family` adds a second Fee family for the same Variant (a material insertion).
   */
  readonly produceCommercialFee: (input: {
    readonly amount: string;
    readonly effectiveFrom?: string;
    readonly effectiveTo?: string | null;
    readonly family?: HarnessFeeFamily;
    readonly handoff: HarnessCatalogHandoff;
  }) => HarnessEffect<void>;
  /** A Current Price Group VARIANT_LINE Discount of a fixed amount; visible to Profile subjects only. */
  readonly produceContractualDiscount: (input: {
    readonly amount: string;
    readonly handoff: HarnessCatalogHandoff;
  }) => HarnessEffect<void>;
  /** The harness Profile subject (RETAIL), assigned to `priceGroupRef` by the declared Customer Context. */
  readonly profileSubject: HarnessProfileSubject;
  /**
   * Retires the Tier bound to `previous` (the superseded Unit rule) and defines its equivalent for `fresh` (default
   * resulting unit price 75, threshold 2), through Pricing's own scoped persistence.
   */
  readonly reproduceTier: (input: {
    readonly fresh: HarnessCatalogHandoff;
    readonly previous: HarnessCatalogHandoff;
    readonly resultingUnitPrice?: string;
  }) => HarnessEffect<void>;
  /**
   * A value-only revision of the Variant's Current Fee, effective one millisecond after the previous harness
   * revision (the first one a millisecond after the harness start), so every Read as-of a later instant sees it.
   */
  readonly reviseCommercialFee: (input: {
    readonly amount: string;
    readonly family?: HarnessFeeFamily;
    readonly handoff: HarnessCatalogHandoff;
  }) => HarnessEffect<void>;
  readonly reviseFirstUnitRule: () => HarnessEffect<number>;
  /** One call through the registered production Read; nothing below the Read boundary is substituted. */
  readonly runRegisteredRead: (
    request: typeof CurrentPricingDecisionRequestSchema.Type,
  ) => HarnessEffect<typeof CurrentPricingDecisionResponseSchema.Type>;
  readonly selections: {
    readonly p1: HarnessCatalogSelection;
    readonly p2: HarnessCatalogSelection;
    readonly q1: HarnessCatalogSelection;
  };
  /** Paths the fixture Shell refused (an owner call it could not route). */
  readonly shellRefusals: readonly string[];
  readonly tenantId: string;
  /** Each whole-attempt result of the registered Read, so a customer-safe non-success stays diagnosable. */
  readonly wholeAttempts: readonly HarnessWholeAttemptObservation[];
}

const hasMessage = Schema.is(Schema.Struct({ message: Schema.String }));

/** Narrows every owner/runtime failure to this harness's one nameable, tagged failure. */
const confine = <Success, Failure extends { readonly _tag: string }, Requirements>(
  stage: string,
  effect: Effect.Effect<Success, Failure, Requirements>,
) =>
  effect.pipe(
    Effect.mapError((cause) => {
      const detail = hasMessage(cause) ? `:${cause.message.slice(0, 600)}` : '';
      return unavailable(`${stage}:${cause._tag}${detail}`);
    }),
  );

/**
 * Shared Pricing-owned native harness for the registered public Current Pricing Read (#1225, #1242, #1250, #1277).
 *
 * Real: the production `currentPricingDecisionRead` registration and its service factory, the production
 * evaluation, publication and owner final-fence layers, Core Read runtime and Composition built from the real
 * Pricing/Catalog/Market/Customer Context contracts, native PostgreSQL, Pricing's own scoped persistence for
 * Currency, Price, Quantity Tier and Commercial Fee, and the real Catalog receiver process reached through the
 * published Catalog client over a Shell fixture.
 *
 * Declared stand-ins, each labelled and answering only through a published owner contract, never a private owner
 * fixture:
 *  - Core access gate: `makeTestAccessGateLayers` with `defaultAnswer: ALLOWED` (allow-all for the Pricing Read's own
 *    permission check, in place of Core's SpiceDB-backed gate). Catalog's own permissions are real grants.
 *  - Delegated gateway context: the Shell fixture below issues the Catalog-signed module credential Pricing uses to
 *    reach owners (in place of the real Shell issuer); only an Assertion subject for this composition is admitted.
 *  - Commerce Market evidence owner (published Market evidence contract) and the Customer Context purchase-context
 *    verdict (published purchase-context contract).
 *  - Customer Context price-group assignment and Price Group Catalog compatibility (published contracts), answered
 *    only for a Profile subject, with the same generation on every replay so the owner final fence can confirm it.
 *  - Promotion is the production "not installed" fence.
 * Guest subjects have no Discount audience, so the production Discount reader returns its empty set. A Profile
 * subject is assigned the declared Price Group; Contractual Discounts are produced through Pricing's own scoped
 * persistence, not registered admission, and the production Discount reader/applicability reads them.
 *
 * Needs a clean git tree (release identity) and built catalog, pricing, commerce-market-catalog and
 * commerce-customer-context contracts plus the Shell output.
 */
const startHarnessEffect = (options: PublicPricingReadHarnessOptions) =>
  Effect.gen(function* startHarnessProgram() {
    const { nativeClock } = options;
    const fs = yield* FileSystem.FileSystem;
    const directory = `${appRoot}verticals/catalog/.cache/ontos-1225/`;
    yield* fs.makeDirectory(directory, { recursive: true });
    const artifact = `${directory}${yield* nextId}.mjs`;
    yield* Effect.addFinalizer(() => fs.remove(artifact, { force: true }).pipe(Effect.orDie));
    const buildIdentity = yield* currentCatalogBuildIdentity();
    const buildLiterals = yield* Effect.all({
      buildMarker: Schema.encodeEffect(Schema.fromJsonString(Schema.String))(buildIdentity.buildMarker),
      sourceRevision: Schema.encodeEffect(Schema.fromJsonString(Schema.String))(buildIdentity.sourceRevision),
    });
    const build = yield* ChildProcess.make(
      'mise',
      [
        'exec',
        '--',
        'pnpm',
        'exec',
        'esbuild',
        'verticals/catalog/tests/support/whole-candidate-catalog-receiver.fixture.ts',
        '--bundle',
        '--platform=node',
        '--format=esm',
        '--packages=external',
        `--define:ULTRAMODERN_BUILD_MARKER=${buildLiterals.buildMarker}`,
        `--define:ULTRAMODERN_SOURCE_REVISION=${buildLiterals.sourceRevision}`,
        `--outfile=${artifact}`,
      ],
      { cwd: appRoot, stderr: 'pipe', stdout: 'pipe' },
    );
    const [buildExit] = yield* Effect.all(
      [build.exitCode, Stream.runDrain(build.stdout), Stream.runDrain(build.stderr)],
      { concurrency: 3 },
    );
    expect(buildExit).toBe(0);
    const describe = yield* ChildProcess.make(process.execPath, [artifact, '--describe-whole-candidate'], {
      cwd: appRoot,
      stderr: 'pipe',
      stdout: 'pipe',
    });
    const [descriptionExit, descriptionJson] = yield* Effect.all(
      [describe.exitCode, describe.stdout.pipe(Stream.decodeText(), Stream.mkString), Stream.runDrain(describe.stderr)],
      { concurrency: 3 },
    );
    expect(descriptionExit).toBe(0);
    const description = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(WholeCandidateCatalogDescriptionSchema),
    )(descriptionJson.trim());
    expect(description.actionKeys).toEqual(catalogActionKeys);
    expect(description.buildMarker).toBe(buildIdentity.buildMarker);
    const pricingContractDocument = yield* readOwnerContractDocument('pricing');
    const pricingContract = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(OntosModuleDeploymentContractSchema),
    )(pricingContractDocument);
    const extraContractDocuments = yield* Effect.all(
      harnessContractVerticals.map((vertical) => readOwnerContractDocument(vertical)),
    );
    const composition = yield* deriveHarnessSnapshot(
      description.contractDocument,
      pricingContractDocument,
      extraContractDocuments,
    );
    const isolated = yield* makeIsolatedNativeDatabaseFixture({
      compositionSnapshot: composition,
      mode: 'schema-only',
      purpose: 'stabilization-1225-whole-candidate',
    });
    const fixture = yield* Effect.acquireRelease(
      makeLiveOperationFixture({
        actionExecutor: 'manager-only',
        actionKeys: catalogActionKeys,
        adminConnectionString: Redacted.make(isolated.connections.admin.connectionString),
        allowedAudiences: HARNESS_PRICING_AUDIENCES,
        authenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID,
        compositionRevision: composition.composition.revision,
        moduleAccess: 'configured-modules',
        moduleKeys: [
          CATALOG_MODULE,
          PRICING_MODULE,
          'commerce.market-catalog',
          CUSTOMER_CONTEXT_MODULE,
          PRICE_GROUP_CATALOG_MODULE,
        ],
        runtimeConnectionString: Redacted.make(isolated.connections.runtime.connectionString),
      }),
      (value) => value.close().pipe(Effect.orDie),
    );
    const runtimeIdentityMatches = yield* fixture.prepareOwner(
      (_transaction, scope) =>
        Effect.succeed(scope.tenantId === fixture.tenantId && scope.principalId === fixture.manager.principalId),
      'forbidden',
    );
    expect(runtimeIdentityMatches).toBe(true);
    const permissions = yield* makeContextPermissionRelationshipMutationLive();
    const principal = { principalId: fixture.manager.principalId, tenantId: fixture.tenantId };
    const targets = [
      { moduleId: CATALOG_MODULE, permission: 'commerce.catalog.read.quantity-preparation' },
      { moduleId: CATALOG_MODULE, permission: 'commerce.catalog.read.pricing-purpose-equivalence' },
      { moduleId: CATALOG_MODULE, permission: 'commerce.catalog.read.quantity-basis-compatibility' },
      { moduleId: CATALOG_MODULE, permission: 'commerce.catalog.read.media' },
    ];
    for (const target of targets) {
      yield* permissions.mutate({
        legalEntityId: fixture.legalEntityId,
        operation: 'grant',
        principal,
        target,
        tenantId: fixture.tenantId,
      });
      yield* Effect.addFinalizer(() =>
        permissions
          .mutate({
            legalEntityId: fixture.legalEntityId,
            operation: 'revoke',
            principal,
            target,
            tenantId: fixture.tenantId,
          })
          .pipe(Effect.orDie),
      );
    }
    const { subtle } = globalThis.crypto;
    const keys = yield* Effect.tryPromise({
      catch: () => unavailable('signing-key'),
      try: subtle.generateKey.bind(subtle, 'Ed25519', true, ['sign', 'verify']),
    });
    assert('privateKey' in keys);
    const publicKey = yield* Effect.tryPromise({
      catch: () => unavailable('public-key'),
      try: subtle.exportKey.bind(subtle, 'jwk', keys.publicKey),
    });
    const kid = 'whole-candidate-native';
    const issuer = 'https://whole-candidate-native.ontos.test';
    const publicJwkSchema = Schema.Struct({
      crv: Schema.Literal('Ed25519'),
      kty: Schema.Literal('OKP'),
      x: Schema.String,
    });
    const jwksSchema = Schema.Struct({
      keys: Schema.Array(
        Schema.Struct({
          ...publicJwkSchema.fields,
          alg: Schema.Literal('EdDSA'),
          kid: Schema.String,
          use: Schema.Literal('sig'),
        }),
      ),
    });
    const publicJwk = yield* Schema.decodeUnknownEffect(publicJwkSchema)(publicKey);
    const jwks = yield* Schema.encodeEffect(Schema.fromJsonString(jwksSchema))({
      keys: [{ ...publicJwk, alg: 'EdDSA', kid, use: 'sig' }],
    });
    const commands = yield* Queue.unbounded<Uint8Array, Cause.Done>();
    const protocolResponses = yield* Queue.unbounded<typeof WholeCandidateCatalogResponseSchema.Type>();
    const protocolFailure = yield* Deferred.make<never, WholeCandidateReceiverTestUnavailable>();
    const child = yield* ChildProcess.make(process.execPath, [artifact, '--serve-whole-candidate'], {
      additionalFds: { fd3: { type: 'output' }, fd4: { stream: Stream.fromQueue(commands), type: 'input' } },
      cwd: appRoot,
      extendEnv: true,
      stderr: 'pipe',
      stdin: 'ignore',
      stdout: 'pipe',
    });
    yield* Effect.addFinalizer(() => Queue.end(commands));
    yield* Stream.runDrain(child.stderr).pipe(Effect.forkScoped);
    yield* Stream.runDrain(child.stdout).pipe(Effect.forkScoped);
    yield* child.getOutputFd(3).pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.filter((line) => line.length > 0),
      Stream.mapEffect((line) =>
        Schema.decodeUnknownEffect(Schema.fromJsonString(WholeCandidateCatalogResponseSchema), {
          onExcessProperty: 'error',
        })(line),
      ),
      Stream.runForEach((response) => Queue.offer(protocolResponses, response)),
      Effect.catchCause(() => Deferred.fail(protocolFailure, unavailable('child-response-codec-or-stream-failed'))),
      Effect.forkScoped,
    );
    const send = (command: typeof WholeCandidateCatalogCommandSchema.Type) =>
      Schema.encodeEffect(Schema.fromJsonString(WholeCandidateCatalogCommandSchema))(command).pipe(
        Effect.flatMap((line) => Queue.offer(commands, new TextEncoder().encode(`${line}\n`))),
      );
    const receive = () =>
      Effect.raceFirst(
        Effect.raceFirst(Queue.take(protocolResponses), Deferred.await(protocolFailure)),
        child.exitCode.pipe(Effect.flatMap(() => Effect.fail(unavailable('child-exited-before-response')))),
      ).pipe(
        Effect.flatMap((response) =>
          response.type === 'failed'
            ? Effect.fail(unavailable(`catalog-child:${response.reasonCode}:${response.stage}`))
            : Effect.succeed(response),
        ),
      );
    yield* send({
      actor: fixture.manager,
      composition,
      databaseName: isolated.connections.runtime.database,
      deniedPrincipalId: fixture.denied.principalId,
      issuer,
      jwks,
      legalEntityId: WholeCandidateCatalogProducedSchema.fields.legalEntityId.make(fixture.legalEntityId),
      runtimeConnectionString: Redacted.make(isolated.connections.runtime.connectionString),
      scheduledConfiguration: true,
      type: 'bootstrap',
      version,
    });
    const produced = yield* Schema.decodeUnknownEffect(WholeCandidateCatalogProducedSchema)(yield* receive());
    expect(produced.actor).toEqual(fixture.manager);
    const [p1, p2, q1] = produced.selections;
    for (const resource of [p1.productRef, q1.productRef, p1.variantRef]) {
      yield* fixture.grantResourceAccess(resource, fixture.manager.principalId);
      yield* Effect.addFinalizer(() =>
        fixture.revokeResourceAccess(resource, fixture.manager.principalId).pipe(Effect.orDie),
      );
    }
    const authorization = (issuedAt: DateTime.Utc) =>
      issueCatalogAuthorization({
        actor: { ...fixture.manager, legalEntityId: fixture.legalEntityId },
        buildMarker: produced.buildMarker,
        compositionRevision: composition.composition.revision,
        issuedAt,
        issuer,
        kid,
        privateKey: keys.privateKey,
      });
    yield* send({
      authorizations: [
        Redacted.make(yield* authorization(yield* DateTime.now)),
        Redacted.make(yield* authorization(yield* DateTime.now)),
        Redacted.make(yield* authorization(yield* DateTime.now)),
      ],
      type: 'prepare',
      version,
    });
    const ready = yield* Schema.decodeUnknownEffect(WholeCandidateCatalogReadySchema)(yield* receive());
    const [handoffP1, handoffP2, handoffQ1] = ready.handoffs;
    expect(ready.handoffs.map((handoff) => handoff.status)).toEqual(['READY', 'READY', 'READY']);
    expect(ready.handoffs.map((handoff) => handoff.selection)).toEqual([p1, p2, q1]);
    const endpoint = {
      baseUrl: new URL(`http://127.0.0.1:${ready.port}`),
      compositionRevision: ready.compositionRevision,
    };

    // These are actual Catalog-issued handoffs. No receipt, validity time or owner
    // generation below is manufactured by the Pricing fixture.
    const operationTime = DateTime.formatIso(yield* DateTime.now);
    yield* fixture.prepareOwner(
      Effect.fn('WholeCandidate.establishCurrency')(function* establishCurrency(transaction, scope) {
        const currency = yield* currencySupportPersistenceForScope(
          transaction,
          scope,
          composition.composition.revision,
        );
        const payload = yield* Schema.decodeUnknownEffect(SetSupportedCurrenciesV2PayloadSchema)({
          expectedState: { state: 'ABSENT' },
          intendedEffectivePeriod: { effectiveFrom: operationTime, effectiveTo: null },
          intent: 'ESTABLISH_CURRENT',
          reason: 'Pricing native component setup',
          schemaVersion: '2',
          supportedCurrencies: ['CZK'],
        });
        expect(
          yield* currency.setCurrent({
            ...payload,
            actingPrincipalId: scope.principalId,
            actionInvocationId: yield* nextId,
            tenantId: scope.tenantId,
            trustedOperationAt: DateTime.toDateUtc(DateTime.makeUnsafe(operationTime)),
          }),
        ).toMatchObject({ outcome: 'CREATED' });
      }),
    );
    // ---- Pricing-owned producers: supported native persistence, not registered admission ----
    const priceComponents = yield* fixture.prepareOwner(
      (transaction, scope) => produceNativeComponents(transaction, scope, ready.handoffs, operationTime),
      'required',
    );
    const readContext = yield* Layer.build(
      productionReadRuntime(
        isolated.connections.runtime.connectionString,
        composition,
        [fixture.legalEntityId],
        pricingContract.deployment,
      ),
    );
    const runtime = Context.get(readContext, ReadRuntime);

    // ---- Owner Shell: Pricing reaches Catalog and Market only through its module credential ----
    const catalogPath = '/catalog-api';
    const marketPath = '/commerce-market-catalog-api';
    const customerContextPath = '/commerce-customer-context-api';
    const priceGroupCatalogPath = '/price-group-catalog-api';
    const shellContext = yield* Layer.build(NodeHttpServer.layerTest);
    const shell = Context.get(shellContext, HttpServer.HttpServer);
    const client = yield* HttpClient.HttpClient;
    const catalogAssertion = Effect.gen(function* issueActualCatalogAssertion() {
      return { ...endpoint, credential: Redacted.make(yield* authorization(yield* DateTime.now)) };
    }).pipe(
      Effect.orDie,
      Effect.provideService(Clock.Clock, nativeClock),
      Effect.provideService(Crypto.Crypto, yield* Crypto.Crypto),
    );
    const apiBaseUrlFor = (audience: string) =>
      Match.value(audience).pipe(
        Match.when('catalog', () => catalogPath),
        Match.when(CUSTOMER_CONTEXT_AUDIENCE, () => customerContextPath),
        Match.when(PRICE_GROUP_CATALOG_AUDIENCE, () => priceGroupCatalogPath),
        Match.orElse(() => marketPath),
      );
    const marketRequests: PricingCurrentMarketEvidenceRequest[] = [];
    const priceGroupRequests: CustomerPriceGroupResolutionRequest[] = [];
    const priceGroupCompatibilityRequests: ValidatePriceGroupCompatibilityRequest[] = [];
    const shellRefusals: string[] = [];
    const priceGroupRef = {
      moduleId: PRICE_GROUP_CATALOG_MODULE,
      resourceId: yield* nextId,
      resourceType: 'pricing.price-group-catalog.price-group',
      tenantId: fixture.tenantId,
    } as const;
    const profileIdentity: HarnessProfileIdentity = {
      assignmentRef: {
        moduleId: CUSTOMER_CONTEXT_MODULE,
        resourceId: yield* nextId,
        resourceType: 'commerce.customer-context.customer-price-group-assignment',
        tenantId: fixture.tenantId,
      },
      priceGroupRef,
    };
    const makeProfileSubject = Effect.fn('PublicPricingReadHarness.profileSubject')(function* makeProfileSubject() {
      return {
        authorizationSubject: { kind: 'RETAIL' as const },
        kind: 'PROFILE' as const,
        profileRef: {
          moduleId: CUSTOMER_CONTEXT_MODULE,
          resourceId: yield* nextId,
          resourceType: 'commerce.customer-context.retail-customer-profile',
          tenantId: fixture.tenantId,
        },
      };
    });
    const profileSubject = yield* makeProfileSubject();
    // A second Profile, assigned by the declared Customer Context to a DIFFERENT Price Group, for audience controls.
    const otherGroupProfileSubject = yield* makeProfileSubject();
    const otherGroupIdentity: HarnessProfileIdentity = {
      assignmentRef: { ...profileIdentity.assignmentRef, resourceId: yield* nextId },
      priceGroupRef: { ...priceGroupRef, resourceId: yield* nextId },
    };
    const wholeAttempts: HarnessWholeAttemptObservation[] = [];
    const fenceCalls: HarnessFenceObservation[] = [];
    const attemptHooks: HarnessAttemptHooks = { afterWholeAttempt: null };
    const crypto = yield* Crypto.Crypto;
    yield* shell.serve(
      Effect.gen(function* harnessShell() {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const url = new URL(request.url, 'https://shell.fixture');
        if (url.pathname.startsWith(`${catalogPath}/`)) {
          const headers: Record<string, string> = {};
          for (const name of ['accept', 'authorization', 'content-type', 'idempotency-key', 'x-correlation-id']) {
            const value = request.headers[name];
            if (value !== undefined) {
              headers[name] = value;
            }
          }
          const target = HttpClientRequest.make(request.method)(
            new URL(`${url.pathname.slice(catalogPath.length)}${url.search}`, endpoint.baseUrl),
            { headers },
          );
          const forward =
            request.method === 'GET'
              ? target
              : HttpClientRequest.bodyText(target, yield* request.text, headers['content-type']);
          const forwarded = yield* client
            .execute(forward)
            .pipe(Effect.mapError(() => unavailable('fixture-shell-forward')));
          return HttpServerResponse.fromClientResponse(forwarded);
        }
        if (url.pathname.startsWith(`${marketPath}/`)) {
          // The published Commerce Market evidence contract, answered by an explicit declared Market owner.
          const decoded = yield* request.json.pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(PricingCurrentMarketEvidenceRequestSchema)),
            Effect.mapError(() => unavailable('fixture-market-request')),
          );
          marketRequests.push(decoded);
          return yield* HttpServerResponse.json(yield* declaredMarketPrerequisite1225(decoded, nativeClock));
        }
        if (url.pathname === `${customerContextPath}/reads/customer-price-group-resolution`) {
          // The published Customer Context price-group assignment contract, answered by an explicit declared owner.
          const decoded = yield* request.json.pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(CustomerPriceGroupResolutionRequestSchema)),
            Effect.mapError(() => unavailable('fixture-price-group-request')),
          );
          priceGroupRequests.push(decoded);
          return yield* HttpServerResponse.json(
            yield* declaredCustomerPriceGroupResolution(
              decoded,
              decoded.profile.resourceId === otherGroupProfileSubject.profileRef.resourceId
                ? otherGroupIdentity
                : profileIdentity,
              nativeClock,
            ),
          );
        }
        if (url.pathname === `${priceGroupCatalogPath}/reads/validate-price-group-compatibility`) {
          // The published Price Group Catalog compatibility contract, answered by an explicit declared owner.
          const decoded = yield* request.json.pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(ValidatePriceGroupCompatibilityRequestSchema)),
            Effect.mapError(() => unavailable('fixture-price-group-compatibility-request')),
          );
          priceGroupCompatibilityRequests.push(decoded);
          return yield* HttpServerResponse.json(yield* declaredPriceGroupCompatibility(decoded, nativeClock));
        }
        if (url.pathname.startsWith(`${customerContextPath}/`)) {
          // The published Customer Context purchase-context contract, answered by an explicit declared owner.
          const decoded = yield* request.json.pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(PricingPurchaseContextVerificationRequestSchema)),
            Effect.mapError(() => unavailable('fixture-customer-context-request')),
          );
          const evidence = yield* declaredPurchaseContextEvidence(decoded);
          return yield* HttpServerResponse.json(
            yield* Schema.encodeEffect(PricingPurchaseContextVerificationResponseSchema)({
              evidence,
              outcome: 'PURCHASE_CONTEXT_VERIFIED',
              request: decoded,
            }).pipe(Effect.mapError(() => unavailable('fixture-customer-context-response'))),
          );
        }
        const payload = yield* request.json.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(GatewayDelegatedContextRequestSchema)),
          Effect.orElseSucceed(() => null),
        );
        if (
          url.pathname !== shellGatewayContextContract.issueDelegatedGatewayContextPath ||
          request.headers['x-api-key'] !== 'pricing-module-api-key-harness' ||
          payload === null ||
          payload.compositionRevision !== composition.composition.revision ||
          !isAssertionSubject(payload.subject)
        ) {
          shellRefusals.push(url.pathname);
          return HttpServerResponse.text('Delegated gateway context refused by the fixture Shell', { status: 403 });
        }
        const issued = yield* catalogAssertion;
        return yield* HttpServerResponse.json({
          apiBaseUrl: apiBaseUrlFor(payload.audience),
          compositionRevision: payload.compositionRevision,
          expiresAt: 2_000_000_000,
          token: Redacted.value(issued.credential).replace(/^Bearer /u, ''),
        });
      }),
    );
    const shellAddress = yield* Schema.decodeUnknownEffect(Schema.Struct({ port: Schema.Int }))(shell.address);
    const callerShell = yield* Layer.build(
      ConfigProvider.layerAdd(
        ConfigProvider.fromUnknown({
          ONTOS_GATEWAY_MODULE_API_KEY: 'pricing-module-api-key-harness',
          ONTOS_SHELL_GATEWAY_BASE_URL: new URL(
            shellGatewayContextContract.apiPrefix,
            `http://127.0.0.1:${shellAddress.port}`,
          ).toString(),
        }),
        { asPrimary: true },
      ),
    );
    const readPrincipal = trustVerifiedGatewayPrincipalContext(
      { ...fixture.manager, legalEntityId: fixture.legalEntityId },
      composition.composition.revision,
      { assertion: Redacted.make('TEST:harness:redeemed-pricing-assertion'), audience: 'pricing' },
    );

    /** A valid RECYCLING_FEE Current set for one Variant, produced through Pricing's own scoped persistence. */
    const produceCommercialFee = (input: Parameters<PublicPricingReadHarness['produceCommercialFee']>[0]) =>
      fixture
        .prepareOwner(
          (transaction, scope) =>
            defineHarnessCommercialFee(transaction, scope, {
              ...input,
              effectiveFrom: input.effectiveFrom ?? operationTime,
              trustedOperationAt: operationTime,
            }),
          'required',
        )
        .pipe(Effect.asVoid);

    let feeRevisions = 0;
    /** A value-only Fee revision effective `operationTime` plus one millisecond per harness revision. */
    const reviseCommercialFee = (input: Parameters<PublicPricingReadHarness['reviseCommercialFee']>[0]) => {
      feeRevisions += 1;
      const effectiveFrom = DateTime.formatIso(
        DateTime.add(DateTime.makeUnsafe(operationTime), { milliseconds: feeRevisions }),
      );
      return fixture
        .prepareOwner(
          (transaction, scope) => reviseHarnessCommercialFee(transaction, scope, { ...input, effectiveFrom }),
          'required',
        )
        .pipe(Effect.asVoid);
    };

    /**
     * A Current Contractual Discount for the declared Price Group on one exact Variant line, produced through
     * Pricing's own scoped persistence (not registered admission). WHOLE_PURCHASE Discounts are Counterparty-only by
     * domain rule, and the production Discount reader refuses a Counterparty Discount without Party owner evidence,
     * so the Price Group VARIANT_LINE Discount is the Discount fact the production Read can price today.
     */
    const produceContractualDiscount = (input: {
      readonly amount: string;
      readonly handoff: typeof CatalogQuantityHandoffReadySchema.Type;
    }) =>
      fixture
        .prepareOwner(
          (transaction, scope) =>
            defineHarnessContractualDiscount(transaction, scope, {
              ...input,
              effectiveFrom: operationTime,
              priceGroupRef,
            }),
          'required',
        )
        .pipe(Effect.asVoid);

    /** Retires the Tier bound to the superseded Unit rule and defines its equivalent for the fresh Quantity Basis. */
    const reproduceTier = Effect.fn('PublicPricingReadHarness.reproduceTierForRevisedRule')(
      function* reproduceTierForRevisedRule(input: {
        readonly fresh: HarnessCatalogHandoff;
        readonly previous: HarnessCatalogHandoff;
        readonly resultingUnitPrice?: string;
      }) {
        const component = priceComponents.find(
          ({ handoff }) => handoff.selection.variantRef.resourceId === input.previous.selection.variantRef.resourceId,
        );
        if (component === undefined) {
          return yield* unavailable('harness-tier-price-component-absent');
        }
        const resultingUnitPrice = input.resultingUnitPrice ?? '75';
        return yield* fixture.prepareOwner(
          (transaction, scope) =>
            reproduceHarnessTier(transaction, scope, {
              fresh: input.fresh,
              previous: input.previous,
              priceRef: component.priceRef,
              resultingUnitPrice,
              thresholdQuantity: '2',
            }),
          'required',
        );
      },
    );

    /** Catalog's own supported owner operation: revises the first Unit rule, superseding every earlier basis. */
    const reviseFirstUnitRule = Effect.fn('PublicPricingReadHarness.reviseFirstUnitRule')(function* reviseUnit() {
      yield* send({ expectedRevision: handoffP1.quantity.unitRuleRevision, type: 'revise-first-unit', version });
      const revised = yield* Schema.decodeUnknownEffect(
        Schema.Struct({
          ruleRevision: Schema.Int.check(Schema.isGreaterThan(0)),
          type: Schema.Literal('revised'),
          version: Schema.Literal(protocolVersion),
        }),
        { onExcessProperty: 'error' },
      )(yield* receive());
      return revised.ruleRevision;
    });

    /** A fresh Catalog quantity handoff for one exact selection, issued by the real Catalog receiver. */
    const prepareFreshHandoff = Effect.fn('PublicPricingReadHarness.prepareFreshHandoff')(function* prepareFresh(
      selection: typeof CatalogSelectionSchema.Type,
    ) {
      const fresh = yield* executeQuantityPreparationWithAuthorization(
        { amount: '1', purpose: 'PRICING', selection },
        yield* authorization(yield* DateTime.now),
        yield* nextId,
        endpoint,
      );
      if (fresh.status !== 'READY') {
        return yield* unavailable('fresh-handoff-not-ready');
      }
      return fresh;
    });

    const guestSubject = {
      guestEvidenceRef: 'TEST:harness:guest-evidence',
      guestSessionRef: 'TEST:harness:guest-session',
      kind: 'GUEST' as const,
    };
    const makeRequest = Effect.fn('PublicPricingReadHarness.request')(function* makeRequest(input: {
      readonly lines: readonly {
        readonly handoff: typeof CatalogQuantityHandoffReadySchema.Type;
        readonly occurrenceId: string;
      }[];
      readonly operationTime: string;
      readonly subject?: 'GUEST' | 'OTHER_GROUP_PROFILE' | 'PROFILE';
    }) {
      const profile = input.subject === 'PROFILE' || input.subject === 'OTHER_GROUP_PROFILE';
      let subject: typeof guestSubject | HarnessProfileSubject = guestSubject;
      if (input.subject === 'PROFILE') {
        subject = profileSubject;
      } else if (input.subject === 'OTHER_GROUP_PROFILE') {
        subject = otherGroupProfileSubject;
      }
      return yield* Schema.decodeUnknownEffect(CurrentPricingDecisionRequestSchema)({
        decision: {
          commercialScope: { ...HARNESS_MARKET, sellingLegalEntityId: fixture.legalEntityId },
          currencyCode: 'CZK',
          lines: input.lines.map(({ handoff, occurrenceId }) => ({
            catalog: handoff,
            occurrenceId,
            pricingBasis: { quantity: '1', unitRef: handoff.unitRef },
          })),
          monetaryBoundary: 'PRE_TAX',
          operationTime: input.operationTime,
          purchasingContext: {
            accessDecision: { decisionRef: 'TEST:harness:access', decisionRevision: '1' },
            actor: profile ? { kind: 'PRINCIPAL', principalId: fixture.manager.principalId } : guestSubject,
            commercialSettingsDecision: { decisionRef: 'TEST:harness:commercial-settings', decisionRevision: '1' },
            contextRef: 'TEST:harness:declared-purchase-context',
            contextRevision: '1',
            currencyResolution: {
              currencyCode: 'CZK',
              resolutionRef: 'TEST:harness:currency',
              resolutionRevision: '1',
            },
            subject,
          },
          tenantId: fixture.tenantId,
        },
        subject,
      });
    });

    // The Customer Context purchase-context verdict is the one explicitly declared owner response here; the
    // subject authority service and the owner final fence answer from the same declared evidence.
    const subjectAuthority: typeof CurrentPricingDecisionSubjectAuthority.Service = {
      verify: (input) =>
        declaredPurchaseContextEvidence({
          actor: input.request.decision.purchasingContext.actor,
          operationTime: input.request.decision.operationTime,
          purchasingContext: {
            channelId: input.request.decision.commercialScope.channelId,
            contextRef: input.request.decision.purchasingContext.contextRef,
            contextRevision: input.request.decision.purchasingContext.contextRevision,
            marketId: input.request.decision.commercialScope.marketId,
            sellingLegalEntityId: input.scope.sellingLegalEntityId,
          },
          subject: input.request.subject,
          tenantId: input.scope.principal.tenantId,
        }).pipe(
          Effect.map((evidence) => ({
            evidence,
            input,
            kind: 'CURRENT_PRICING_DECISION_SUBJECT_AUTHORITY_VERIFIED' as const,
          })),
          Effect.orDie,
        ),
    };

    const collaborators = yield* Layer.build(productionReadCollaborators(wholeAttempts, fenceCalls, attemptHooks)).pipe(
      Effect.provideService(
        ActiveApplicationCompositionService,
        makeActiveApplicationCompositionService(Effect.succeed(composition)),
      ),
      Effect.provideContext(Context.merge(callerShell, readContext)),
    );

    /** One call through the registered public Read; nothing below the Read boundary is substituted by this method. */
    const runRegisteredRead = Effect.fn('PublicPricingReadHarness.runRegisteredRead')(function* runRegisteredRead(
      request: typeof CurrentPricingDecisionRequestSchema.Type,
    ) {
      return yield* runtime
        .runRead({
          input: request,
          principal: readPrincipal,
          registration: currentPricingDecisionRead,
          transport: { correlationId: yield* nextId },
        })
        .pipe(
          Effect.provideService(CurrentPricingDecisionSubjectAuthority, subjectAuthority),
          Effect.provideContext(collaborators),
          Effect.provideService(
            ActiveApplicationCompositionService,
            makeActiveApplicationCompositionService(Effect.succeed(composition)),
          ),
          Effect.provideContext(Context.merge(callerShell, readContext)),
        );
    });

    return {
      afterWholeAttempt: (hook: Parameters<PublicPricingReadHarness['afterWholeAttempt']>[0]) =>
        Effect.sync(() => {
          attemptHooks.afterWholeAttempt = hookWithCrypto(hook, crypto);
        }),
      authorization: (issuedAt: DateTime.Utc) => confine('authorization', authorization(issuedAt)),
      clearAfterWholeAttempt: () =>
        Effect.sync(() => {
          attemptHooks.afterWholeAttempt = null;
        }),
      composition,
      endpoint,
      fenceCalls,
      handoffs: { p1: handoffP1, p2: handoffP2, q1: handoffQ1 },
      legalEntityId: fixture.legalEntityId,
      makeRequest: (input: Parameters<typeof makeRequest>[0]) => confine('make-request', makeRequest(input)),
      managerPrincipalId: fixture.manager.principalId,
      marketRequests,
      operationTime,
      otherGroupProfileSubject,
      prepareFreshHandoff: (selection: Parameters<typeof prepareFreshHandoff>[0]) =>
        confine('prepare-fresh-handoff', prepareFreshHandoff(selection)),
      priceComponents,
      priceGroupCompatibilityRequests,
      priceGroupRef,
      priceGroupRequests,
      produceCommercialFee: (input: Parameters<typeof produceCommercialFee>[0]) =>
        confine('produce-commercial-fee', produceCommercialFee(input)),
      produceContractualDiscount: (input: Parameters<typeof produceContractualDiscount>[0]) =>
        confine('produce-contractual-discount', produceContractualDiscount(input)),
      profileSubject,
      reproduceTier: (input: Parameters<typeof reproduceTier>[0]) =>
        confine('reproduce-tier', reproduceTier(input).pipe(Effect.asVoid)),
      reviseCommercialFee: (input: Parameters<typeof reviseCommercialFee>[0]) =>
        confine('revise-commercial-fee', reviseCommercialFee(input)),
      reviseFirstUnitRule: () => confine('revise-first-unit-rule', reviseFirstUnitRule()),
      runRegisteredRead: (request: Parameters<typeof runRegisteredRead>[0]) =>
        confine('registered-read', runRegisteredRead(request)),
      selections: { p1, p2, q1 },
      shellRefusals,
      tenantId: fixture.tenantId,
      wholeAttempts,
    } as const;
  }).pipe(Effect.mapError((cause) => unavailable(`harness-start:${cause._tag}`)));

export const startPublicPricingReadHarness: (
  options: PublicPricingReadHarnessOptions,
) => Effect.Effect<
  PublicPricingReadHarness,
  WholeCandidateReceiverTestUnavailable,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto | FileSystem.FileSystem | HttpClient.HttpClient | Scope.Scope
> = startHarnessEffect;
