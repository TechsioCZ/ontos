import {
  ActionRuntime,
  ActiveApplicationCompositionService,
  ApplicationCompositionSchema,
  BusinessPermissionRelationshipMutation,
  BusinessPermissionRelationshipMutationLive,
  ContextAccessLive,
  CoreSearchResourceRefSchema,
  DATABASE_IDENTITIES,
  GatewayAssertionRedemptionService,
  OntosModuleDeploymentContractSchema,
  OntosShellRuntimeContractSchema,
  OutboxRepositoryLive,
  canonicalizeApplicationComposition,
  extractOutboxWorkerSubscriptions,
  makeContextPermissionRelationshipMutationLive,
  matchOutboxMessages,
  loadDatabaseConfig,
  parseDatabaseConnectionPair,
  runOutboxCycle,
  validateActiveApplicationCompositionSnapshot,
} from '@app/core-runtime';
import { ChangeCounterpartyPurchaseLimitPayloadSchema } from '../../shared/actions/change-counterparty-purchase-limit.ts';
import { executeChangeCounterpartyPurchaseLimitWithAuthorization } from '../../src/api/change-counterparty-purchase-limit-action-client.ts';
import { beginGrant, settleGrant } from './purchasing-approval-native.ts';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import {
  executeCreateCartDraftWithAuthorization,
  executeInitializePopulationAuthorityWithAuthorization,
  executeReviseCartDraftWithAuthorization,
} from '@app/commerce-cart/api/client';
import { executePreapprovalCartObservationWithAuthorization } from '@app/commerce-cart/api/preapproval-cart-observation/client';
import { makeLiveOperationFixture } from '@app/core-runtime/testing/actions';
import { testCoreDatabase } from '@app/core-runtime/testing/owner-evidence';
import { makeIsolatedNativeDatabaseFixture } from '@app/core-runtime/testing/isolated-native-database';
import {
  makeApplicationCompositionSnapshotFixture,
  makeModuleContractFixture,
} from '@app/core-runtime/testing/module-contract';

import { CatalogSelectionSchema } from '@app/catalog-selection-contracts';
import { ProductUnitRefSchema } from '@app/catalog/resources/product-unit';
import { SetSupportedCurrenciesV2ResultSchema } from '@app/pricing-contracts/domain/currency-support';
import { PriceSourceAssertionAssessmentSchema } from '@app/pricing-contracts/domain/price-source-provenance';
import {
  CreatePartyPayloadSchema,
  CounterpartyCustomerOnboardPayloadSchema,
  DuplicateCandidateDetailResponseSchema,
  PartyMatchDecisionResponseSchema,
} from '@app/party-registry/api';
import { CatalogQuantityHandoffSchema } from '@app/catalog/domain/catalog-quantity-handoff';
import type { CreatePartyResultSchema } from '@app/party-registry/api';
import { STAFF_AUTHENTICATION_NAMESPACE_ID } from '@app/core-runtime/auth/staff-authentication-namespace';
import { issueApiKeyGatewayContext } from '@app/shared-contracts/server/gateway-context-api-key';
import { EXTERNAL_GATEWAY_ASSERTION_VERSION, GATEWAY_ASSERTION_TTL_SECONDS } from '@app/shared-contracts';
import type { GatewayContextRequest } from '@app/shared-contracts';
import {
  createPartyWithAuthorization,
  executeDuplicateCandidateDetailWithAuthorization,
  executePartyMatchDecisionWithAuthorization,
  resolveDuplicateCandidateCreateWithAuthorization,
  counterpartyCustomerOnboardWithAuthorization,
} from '@app/party-registry/api/client';
import { executeManageQuotationWithAuthorization } from '@app/pricing-contracts/manage-quotation/client';
import { pricingQuotationMatchesCurrentDecision } from '@app/pricing-contracts/quotation-verification';
import {
  Cause,
  Config,
  ConfigProvider,
  Context,
  DateTime,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Queue,
  Redacted,
  Schema,
  Stream,
} from 'effect';
import { ChildProcess } from 'effect/process';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { PgClient } from '@effect/sql-pg';
import { Reactivity } from 'effect/reactivity';
import { NodeHttpServer } from '@effect/platform-node';
import { HttpClient, HttpClientRequest, HttpServer, HttpServerRequest, HttpServerResponse } from 'effect/http';
import {
  AuthBindingIdSchema,
  PrincipalIdSchema,
  ProviderSubjectIdSchema,
  TenantIdSchema,
} from '@app/core-runtime/auth/external-identity-contracts';
import { bindGatewayPrincipalVerifier } from '@app/gateway-principal-verifier/server';
import { ActiveApplicationCompositionSnapshotSchema } from '@app/core-runtime/modules/active-application-composition';
import {
  GatewayAssertionRedemptionDatabaseLive,
  GatewayAssertionRedemptionLive,
} from '../../api/auth/gateway-assertion-redemption.ts';
import { outboxWorkerLayer } from '../../src/worker-host/layer.ts';
import { outboxWorkers } from '../../src/workers/index.ts';
import { ultramodernApiMarker } from '../../shared/ultramodern-build.ts';
import { readCurrentPurchaseProposalRoutine } from '../../src/persistence/purchase-limit-persistence.ts';

import { executeCreateCounterpartyPurchasingProfileWithAuthorization } from '../../src/api/create-counterparty-purchasing-profile-action-client.ts';
import { executeBootstrapCounterpartyAccessAdministratorWithAuthorization } from '../../src/api/bootstrap-counterparty-access-administrator-action-client.ts';
import { executeGrantCounterpartyCommerceAccessWithAuthorization } from '../../src/api/grant-counterparty-commerce-access-action-client.ts';
import { administerPurchaseCurrencyPolicyAction } from '../../src/actions/administer-purchase-currency-policy.action.ts';
import { commerceCustomerContextOwnerAuthorizationOverlayLive } from '../../src/persistence/owner-authorization-overlay.ts';
import { profileRetailPermissionReaderFactoryLive } from '../../src/integrations/retail-permission-reader.ts';
import { PurchaseCurrencyPolicyAdministrationPayloadSchema } from '../../shared/domain/customer-commerce-policy-administration.ts';
import {
  PurchaseProposalRevisionSchema,
  computePurchaseProposalCanonicalHash,
} from '../../shared/domain/purchasing-approval.ts';

import { executeCompletePurchaseProposalBasisWithAuthorization } from '../../src/api/complete-purchase-proposal-basis-action-client.ts';
import { CompletePurchaseProposalBasisActionConflictProblemSchema } from '../../shared/apis/complete-purchase-proposal-basis-action.ts';
import { executeCreatePurchaseProposalRevisionWithAuthorization } from '../../src/api/create-purchase-proposal-revision-action-client.ts';
import { executeCreateApprovalHierarchyWithAuthorization } from '../../src/api/create-approval-hierarchy-action-client.ts';
import { executeSubmitPurchaseApprovalRequestWithAuthorization } from '../../src/api/submit-purchase-approval-request-action-client.ts';
import { executeDecidePurchaseApprovalRequestWithAuthorization } from '../../src/api/decide-purchase-approval-request-action-client.ts';
import { CreateApprovalHierarchyPayloadSchema } from '../../shared/actions/create-approval-hierarchy.ts';
import { executePreparePurchaseProposalBasisWithAuthorization } from '../../src/api/prepare-purchase-proposal-basis-action-client.ts';
import { executePurchaseLimitEvaluationWithAuthorization } from '../../src/api/purchase-limit-evaluation-client.ts';
import { executePurchaseProposalBasisWithAuthorization } from '../../src/api/purchase-proposal-basis-client.ts';
import {
  CompletePurchaseProposalBasisPayloadSchema,
  PreparePurchaseProposalBasisPayloadSchema,
  PurchaseProposalBasisSchema,
} from '../../shared/apis/purchase-proposal-basis.ts';
import { PurchaseLimitEvaluationRequestSchema } from '../../shared/apis/purchase-limit-evaluation.ts';
import { PurchaseLimitSourceRevisionVectorSchema } from '../../shared/domain/purchase-limit-evaluation.ts';
import { PurchaseValueSchema } from '../../shared/domain/purchase-limit.ts';
import { CreatePurchaseProposalRevisionPayloadSchema } from '../../shared/actions/create-purchase-proposal-revision.ts';
import type { PurchaseProposalRevision } from '../../shared/domain/purchasing-approval.ts';

type NativeCoreFixture = Effect.Success<ReturnType<typeof makeLiveOperationFixture>>;
const cartAudience = 'commerce-cart';
const describeOwner = '--describe' as const;
const serveOwner = '--serve' as const;
const shellAudience = 'shell-super-app' as const;
const identityModule = 'core.identity' as const;
const contextModule = 'commerce.customer-context' as const;
const preproposalReceiver = 'preproposal-basis-receiver.fixture.ts' as const;

const pricingAudience = 'pricing' as const;
const catalogAudience = 'catalog' as const;
const catalogModule = 'commerce.catalog' as const;
const partyAudience = 'party-registry' as const;
const registryAudience = 'storefront-registry' as const;
const marketAudience = 'commerce-market-catalog' as const;
const finalizationReceiver = 'order-finalization-receiver.fixture.ts' as const;
const describePreproposal = '--describe-preproposal-basis' as const;
const servePreproposal = '--serve-preproposal-basis' as const;
const untrustedCommand = 'untrusted-command' as const;

const contextAudience = 'commerce-customer-context';
const serviceRole = 'ccc-service';
const pricingIssuerRole = 'pricing-issuer' as const;
const pricingOwner = 'verticals/pricing' as const;
const pricingModule = 'commerce.pricing' as const;
const NativeRoleSchema = Schema.Literals(['operator', 'buyer', pricingIssuerRole, serviceRole]);
const NativeAudienceSchema = Schema.Literals([cartAudience, contextAudience, pricingAudience]);
type NativeRole = typeof NativeRoleSchema.Type;
type NativeAudience = typeof NativeAudienceSchema.Type;

export interface PreproposalNativeCredential {
  readonly authorization: Redacted.Redacted;
  readonly options: { readonly baseUrl: URL; readonly compositionRevision: string };
}

/** Authentication is the only caller-supplied seam. Each acquisition must issue a fresh assertion. */
export interface PreproposalNativeTransport<Failure, Requirements> {
  readonly authorize: (
    role: NativeRole,
    audience: NativeAudience,
  ) => Effect.Effect<PreproposalNativeCredential, Failure, Requirements>;
  readonly buyerPrincipalId: string;
  readonly cccReaderPrincipalId: string;
  readonly core: { readonly evidence: () => ReturnType<NativeCoreFixture['evidence']> };
  readonly pricingIssuerPrincipalId: string;
}

export class PreproposalNativeProtocolError extends Schema.TaggedError<PreproposalNativeProtocolError>()(
  'PreproposalNativeProtocolError',
  { exitCode: Schema.optionalKey(Schema.Number), message: Schema.optionalKey(Schema.String), stage: Schema.String },
) {}
const requireProtocol = (condition: boolean, stage: string) =>
  condition ? Effect.void : Effect.fail(new PreproposalNativeProtocolError({ stage }));

/** Real Cart writes/read only; Catalog selection and Unit must already have real owner provenance. */
export const createRegisteredPreproposalCart = Effect.fn('PreproposalNative.createCart')(
  function* createRegisteredPreproposalCart<Failure, Requirements>(input: {
    readonly entries: Parameters<typeof executeCreateCartDraftWithAuthorization>[0]['entries'];
    readonly intent: string;
    readonly onCreated?: (cartRef: {
      readonly moduleId: string;
      readonly resourceId: string;
      readonly resourceType: string;
    }) => Effect.Effect<void, Failure, Requirements>;
    readonly population: Effect.Success<ReturnType<typeof executeInitializePopulationAuthorityWithAuthorization>>;
    readonly transport: PreproposalNativeTransport<Failure, Requirements>;
  }) {
    const { population } = input;
    const buyer = yield* input.transport.authorize('buyer', cartAudience);
    const created = yield* executeCreateCartDraftWithAuthorization(
      { entries: input.entries },
      Redacted.value(buyer.authorization),
      `${input.intent}:create-cart`,
      { ...buyer.options, idempotencyKey: `${input.intent}:create-cart` },
    );
    yield* requireProtocol(
      created.cart.status === 'OPEN' &&
        created.cart.preparationPrincipalId === input.transport.buyerPrincipalId &&
        created.cart.cartRef.tenantId === population.tenantId,
      'registered-cart-buyer-and-population',
    );
    if (input.onCreated !== undefined) {
      yield* input.onCreated(created.cart.cartRef);
    }
    const reviser = yield* input.transport.authorize('buyer', cartAudience);
    const revised = yield* executeReviseCartDraftWithAuthorization(
      {
        cartRef: created.cart.cartRef,
        entries: created.cart.entries.map((entry) => ({ kind: 'RETAIN' as const, selectionId: entry.selectionId })),
        expectedRevision: created.cart.revisionRef.revision,
      },
      Redacted.value(reviser.authorization),
      `${input.intent}:revise-cart`,
      { ...reviser.options, idempotencyKey: `${input.intent}:revise-cart` },
    );
    yield* requireProtocol(
      revised.cart.revisionRef.revision === created.cart.revisionRef.revision + 1 &&
        revised.cart.entries.every(
          (entry, index) =>
            entry.sourceActionInvocationId === created.cart.entries[index]?.sourceActionInvocationId &&
            entry.originRevisionId === created.cart.entries[index]?.originRevisionId,
        ),
      'registered-cart-revision-retains-original-occurrences',
    );
    const reader = yield* input.transport.authorize(serviceRole, cartAudience);
    const observed = yield* executePreapprovalCartObservationWithAuthorization(
      { cartRef: revised.cart.cartRef, revision: revised.cart.revisionRef.revision },
      Redacted.value(reader.authorization),
      `${input.intent}:observe-cart`,
      reader.options,
    );
    yield* requireProtocol(
      observed.cart.cartRef.resourceId === created.cart.cartRef.resourceId &&
        observed.cart.revisionRef.revisionId === revised.cart.revisionRef.revisionId &&
        observed.cart.preparationPrincipalId === input.transport.buyerPrincipalId,
      'exact-governed-cart-observation',
    );
    return { created, observed, population, revised };
  },
);

/**
 * Sequential public-owner producer, never an injected READY/quote/currentness implementation.
 * The proposal is an untrusted command assembled from actual owner setup receipts. Every source
 * used below is subsequently obtained from real registered Actions or governed owner/Core reads.
 * This helper performs no bootstrap and runs no operation merely by being imported.
 */
export const runRegisteredPreproposalBasisChain = Effect.fn('PreproposalNative.registeredChain')(
  function* runRegisteredPreproposalBasisChain<Failure, Requirements>(input: {
    readonly intent: string;
    readonly proposal: PurchaseProposalRevision;
    readonly transport: PreproposalNativeTransport<Failure, Requirements>;
  }) {
    const { intent, transport } = input;
    yield* requireProtocol(
      transport.buyerPrincipalId !== transport.pricingIssuerPrincipalId &&
        input.proposal.identity.buyer.principalId === transport.buyerPrincipalId,
      'distinct-buyer-and-actual-pricing-issuer',
    );
    const buyer = yield* transport.authorize('buyer', contextAudience);
    // The proposal is already decoded; validate its decoded (type-side) shape rather than the wire encoding.
    const preparation = yield* Schema.decodeUnknownEffect(Schema.toType(PreparePurchaseProposalBasisPayloadSchema))({
      idempotencyKey: `${intent}:prepare`,
      proposal: input.proposal,
    });
    const prepared = yield* executePreparePurchaseProposalBasisWithAuthorization(
      preparation,
      Redacted.value(buyer.authorization),
      `${intent}:prepare`,
      { ...buyer.options, idempotencyKey: `${intent}:prepare` },
    );
    yield* requireProtocol(prepared.status === 'PREPARED', 'registered-preparation');
    const selector = { sourceRef: prepared.proposal.proposalRevisionRef.resourceId, sourceRevision: '1' };
    const service = yield* transport.authorize(serviceRole, contextAudience);
    const pricingInput = yield* executePurchaseProposalBasisWithAuthorization(
      { ...selector, operation: 'PRICING_INPUT' },
      Redacted.value(service.authorization),
      `${intent}:pricing-input`,
      service.options,
    );
    yield* requireProtocol(
      pricingInput.basis.basisRef.resourceId === prepared.basisRef.resourceId &&
        pricingInput.basis.preparationInvocationId === prepared.preparationInvocationId &&
        pricingInput.facts === null,
      'retained-pricing-input',
    );
    const issuer = yield* transport.authorize(pricingIssuerRole, pricingAudience);
    const quotationIntent = `${intent}:quotation`;
    const issued = yield* executeManageQuotationWithAuthorization(
      {
        candidateRef: pricingInput.pricingCandidateRef,
        currentDecision: pricingInput.pricingInput,
        reason: 'Native preproposal producer: exact retained owner input',
      },
      Redacted.value(issuer.authorization),
      quotationIntent,
      { ...issuer.options, idempotencyKey: quotationIntent },
    );
    yield* requireProtocol(
      issued.quotation.binding.candidateRef === pricingInput.pricingCandidateRef &&
        pricingQuotationMatchesCurrentDecision(issued.quotation, pricingInput.pricingInput),
      'genuine-issued-quotation-input',
    );
    // Core owns these invocation records. Do not parse private quotation-reference grammar or
    // query Pricing tables to recover the original registered Action's actual invocation ID.
    const evidence = yield* transport.core.evidence();
    const invocations = evidence.invocations.filter(
      (row) =>
        row.actionKey === 'commerce.pricing.manage-quotation' &&
        row.idempotencyKey === quotationIntent &&
        row.principalId === transport.pricingIssuerPrincipalId &&
        row.tenantId === prepared.proposal.context.tenantId &&
        row.legalEntityId === prepared.proposal.context.sellingLegalEntityId &&
        row.status === 'succeeded',
    );
    const [invocation] = invocations;
    if (invocations.length !== 1 || invocation === undefined) {
      return yield* new PreproposalNativeProtocolError({ stage: 'exact-core-issuance-provenance' });
    }
    const completion = yield* Schema.decodeUnknownEffect(CompletePurchaseProposalBasisPayloadSchema)({
      ...selector,
      pricingIssuanceInvocationId: invocation.actionInvocationId,
    });
    const completer = yield* transport.authorize(serviceRole, contextAudience);
    const ready = yield* executeCompletePurchaseProposalBasisWithAuthorization(
      completion,
      Redacted.value(completer.authorization),
      `${intent}:complete`,
      { ...completer.options, idempotencyKey: `${intent}:complete` },
    );
    yield* requireProtocol(
      ready.status === 'READY' &&
        ready.pricingIssuanceInvocationId === invocation.actionInvocationId &&
        ready.pricingIssuerPrincipalId === transport.pricingIssuerPrincipalId,
      'registered-ready-provenance',
    );
    const currentReader = yield* transport.authorize(serviceRole, contextAudience);
    const current = yield* executePurchaseProposalBasisWithAuthorization(
      { ...selector, operation: 'CURRENT' },
      Redacted.value(currentReader.authorization),
      `${intent}:current`,
      currentReader.options,
    );
    if (current.facts === null || current.basis.status !== 'READY') {
      return yield* new PreproposalNativeProtocolError({ stage: 'genuine-current-facts' });
    }
    yield* requireProtocol(
      Schema.toEquivalence(PurchaseValueSchema)(current.facts.purchaseValue, ready.proposal.purchaseValue),
      'current-retained-purchase-value',
    );
    // Explicitly unobserved local revision claims request a comparison, never establish truth.
    // The governed evaluator returns the independently observed complete vector even for STALE_INPUT.
    const discovery = yield* Schema.decodeUnknownEffect(PurchaseLimitEvaluationRequestSchema)({
      counterpartyRef: ready.proposal.identity.counterpartyRef,
      expectedSourceRevisions: [
        ...current.facts.currentSourceRevisions,
        { revision: 'native:unobserved', source: 'counterparty-policy' },
        { revision: 'native:unobserved', source: 'principal-override' },
      ],
      purchaseValue: current.facts.purchaseValue,
      storefrontId: ready.proposal.context.storefrontId,
    });
    const evaluator = yield* transport.authorize('buyer', contextAudience);
    const observedEvaluation = yield* executePurchaseLimitEvaluationWithAuthorization(
      discovery,
      Redacted.value(evaluator.authorization),
      `${intent}:observe-policy-vector`,
      evaluator.options,
    );
    const sourceRevisions = yield* Schema.decodeUnknownEffect(PurchaseLimitSourceRevisionVectorSchema)(
      observedEvaluation.currentSourceRevisions,
    );
    const creator = yield* transport.authorize('buyer', contextAudience);
    // The retained proposal is already decoded, so validate its type-side shape.
    const command = yield* Schema.decodeUnknownEffect(Schema.toType(CreatePurchaseProposalRevisionPayloadSchema))({
      idempotencyKey: `${intent}:create-proposal`,
      proposal: current.basis.proposal,
      verifiedEvidence: {
        buyerPermission: 'ALLOWED',
        profileState: 'ACTIVE',
        proposalCurrent: true,
        sourceRevisions,
      },
    });
    const created = yield* executeCreatePurchaseProposalRevisionWithAuthorization(
      command,
      Redacted.value(creator.authorization),
      `${intent}:create-proposal`,
      { ...creator.options, idempotencyKey: `${intent}:create-proposal` },
    );
    const negativeCredential = yield* transport.authorize(serviceRole, contextAudience);
    const alteredIssuance = yield* Schema.decodeUnknownEffect(CompletePurchaseProposalBasisPayloadSchema)({
      ...completion,
      pricingIssuanceInvocationId: randomUUID(),
    });
    const wrongIssuance = yield* Effect.exit(
      executeCompletePurchaseProposalBasisWithAuthorization(
        alteredIssuance,
        Redacted.value(negativeCredential.authorization),
        `${intent}:wrong-issuance`,
        { ...negativeCredential.options, idempotencyKey: `${intent}:wrong-issuance` },
      ),
    );
    const wrongIssuanceProblems = Exit.isFailure(wrongIssuance)
      ? wrongIssuance.cause.reasons.flatMap((reason) =>
          Cause.isFailReason(reason) &&
          Schema.is(CompletePurchaseProposalBasisActionConflictProblemSchema)(reason.error)
            ? [reason.error]
            : [],
        )
      : [];
    const [wrongIssuanceProblem] = wrongIssuanceProblems;
    if (wrongIssuanceProblem?.code !== 'IDEMPOTENCY_CONFLICT') {
      return yield* new PreproposalNativeProtocolError({ stage: 'reject-changed-original-issuance-causal-conflict' });
    }
    const rejectionEvidence = yield* transport.core.evidence();
    const rejectedInvocations = rejectionEvidence.invocations.filter(
      (row) =>
        row.actionKey === 'commerce.customer-context.complete-purchase-proposal-basis' &&
        row.correlationId === `${intent}:wrong-issuance` &&
        row.idempotencyKey === `${intent}:wrong-issuance` &&
        row.principalId === transport.cccReaderPrincipalId &&
        row.tenantId === prepared.proposal.context.tenantId &&
        row.legalEntityId === prepared.proposal.context.sellingLegalEntityId,
    );
    const [rejectedInvocation] = rejectedInvocations;
    if (rejectedInvocations.length !== 1 || rejectedInvocation === undefined) {
      return yield* new PreproposalNativeProtocolError({ stage: 'changed-issuance-registered-request-provenance' });
    }
    const retainedCredential = yield* transport.authorize(serviceRole, contextAudience);
    const retained = yield* executePurchaseProposalBasisWithAuthorization(
      { ...selector, operation: 'CURRENT' },
      Redacted.value(retainedCredential.authorization),
      `${intent}:retained-after-rejection`,
      retainedCredential.options,
    );
    yield* requireProtocol(
      Schema.toEquivalence(PurchaseProposalBasisSchema)(retained.basis, current.basis),
      'wrong-issuance-leaves-ready-history-unchanged',
    );
    return {
      completion,
      created,
      current,
      invocation,
      issued,
      observedEvaluation,
      prepared,
      pricingInput,
      ready,
      retained,
      wrongIssuanceRejected: true,
      wrongIssuanceRejection: {
        actionInvocationId: rejectedInvocation.actionInvocationId,
        code: wrongIssuanceProblem.code,
        correlationId: rejectedInvocation.correlationId,
        invocationStatus: rejectedInvocation.status,
        principalId: rejectedInvocation.principalId,
        status: 409,
      },
    };
  },
);

type MutableNativeGatewayRequest = { -readonly [Key in keyof GatewayContextRequest]: GatewayContextRequest[Key] };
interface NativePermissionEnvironment {
  SPICEDB_CA_CERT?: string;
  SPICEDB_ENDPOINT: string;
  SPICEDB_PRESHARED_KEY: string;
  ULTRAMODERN_DEPLOYMENT_ENVIRONMENT?: string;
}
const permissionConfigProtocol = 'ontos.core.preproposal-basis.config.v1' as const;
const PermissionEnvironmentSchema = Schema.Struct({
  SPICEDB_CA_CERT: Schema.optionalKey(Schema.String),
  SPICEDB_ENDPOINT: Schema.String,
  SPICEDB_PRESHARED_KEY: Schema.String,
  ULTRAMODERN_DEPLOYMENT_ENVIRONMENT: Schema.optionalKey(Schema.String),
});

export const readAllocatedPermissionEnvironment = Effect.fn('PreproposalNative.readAllocatedPermissionConfiguration')(
  function* readAllocatedPermissionEnvironment() {
    const configuration = yield* Config.all({
      ca: Config.Redacted('SPICEDB_CA_CERT'),
      deployment: Config.String('ULTRAMODERN_DEPLOYMENT_ENVIRONMENT').pipe(Config.option),
      endpoint: Config.String('SPICEDB_ENDPOINT'),
      key: Config.Redacted('SPICEDB_PRESHARED_KEY'),
    }).parse(ConfigProvider.fromEnv({ preserveEmptyStrings: true }));
    const environment: NativePermissionEnvironment = {
      SPICEDB_CA_CERT: Redacted.value(configuration.ca),
      SPICEDB_ENDPOINT: configuration.endpoint,
      SPICEDB_PRESHARED_KEY: Redacted.value(configuration.key),
    };
    if (Option.isSome(configuration.deployment)) {
      environment.ULTRAMODERN_DEPLOYMENT_ENVIRONMENT = configuration.deployment.value;
    }
    return environment;
  },
);

export const matchesAllocatedPermissionEnvironment = (
  expected: NativePermissionEnvironment,
  actual: NativeCoreFixture['permissionEnvironment'],
) =>
  actual.SPICEDB_ENDPOINT === expected.SPICEDB_ENDPOINT &&
  Redacted.value(actual.SPICEDB_PRESHARED_KEY) === expected.SPICEDB_PRESHARED_KEY &&
  actual.SPICEDB_CA_CERT === expected.SPICEDB_CA_CERT &&
  actual.ULTRAMODERN_DEPLOYMENT_ENVIRONMENT === expected.ULTRAMODERN_DEPLOYMENT_ENVIRONMENT;

const applicationRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const ownerDefinitions = [
  {
    appId: shellAudience,
    describe: describeOwner,
    moduleId: identityModule,
    owner: 'apps/shell-super-app',
    receiver: 'tenant-party-shell-http.ts',
    serve: serveOwner,
  },
  {
    appId: partyAudience,
    describe: describeOwner,
    moduleId: 'party.registry',
    owner: 'verticals/party-registry',
    receiver: 'tenant-party-http.ts',
    serve: serveOwner,
  },
  {
    appId: cartAudience,
    describe: describePreproposal,
    moduleId: 'commerce.cart',
    owner: 'verticals/commerce-cart',
    receiver: preproposalReceiver,
    serve: servePreproposal,
  },
  {
    appId: catalogAudience,
    describe: describePreproposal,
    moduleId: catalogModule,
    owner: 'verticals/catalog',
    receiver: preproposalReceiver,
    serve: servePreproposal,
  },
  {
    appId: registryAudience,
    describe: describeOwner,
    moduleId: 'commerce.storefront-registry',
    owner: 'verticals/storefront-registry',
    receiver: finalizationReceiver,
    serve: serveOwner,
  },
  {
    appId: marketAudience,
    describe: describeOwner,
    moduleId: 'commerce.market-catalog',
    owner: 'verticals/commerce-market-catalog',
    receiver: finalizationReceiver,
    serve: serveOwner,
  },
  {
    appId: pricingAudience,
    describe: describeOwner,
    moduleId: pricingModule,
    owner: pricingOwner,
    receiver: finalizationReceiver,
    serve: serveOwner,
  },
  {
    appId: contextAudience,
    describe: describeOwner,
    moduleId: contextModule,
    owner: 'verticals/commerce-customer-context',
    receiver: 'enrollment-current-access-receiver.fixture.ts',
    serve: serveOwner,
  },
] as const;
const MarkerSchema = Schema.Struct({
  appId: Schema.String.pipe(Schema.brand('PreproposalOwnerAppId'), Schema.decodeTo(Schema.String)),
  buildMarker: Schema.String,
});
const ReadySchema = Schema.Struct({ marker: MarkerSchema, port: Schema.Int, type: Schema.Literal('ready') });
const safeFailure = (stage: string) => new PreproposalNativeProtocolError({ stage });
const io = <Value>(stage: string, operation: () => Promise<Value>) =>
  Effect.tryPromise({ catch: () => safeFailure(stage), try: operation });

/** Private scoped child IPC; the standard platform spawner owns termination/fds. */
export const openNativeChild = Effect.fn('PreproposalNative.openChild')(function* openNativeChild(input: {
  readonly args: readonly string[];
  readonly command?: string;
  readonly cwd?: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly stage: string;
}) {
  const inherited = yield* Config.all({ HOME: Config.String('HOME'), PATH: Config.String('PATH') });
  const commands = yield* Queue.unbounded<Uint8Array, Cause.Done>();
  const standardInput = yield* Queue.unbounded<Uint8Array, Cause.Done>();
  const publicLines = yield* Queue.unbounded<string, Cause.Done>();
  const privateLines = yield* Queue.unbounded<string, Cause.Done>();
  const child = yield* ChildProcess.make(input.command ?? process.execPath, [...input.args], {
    additionalFds: { fd3: { type: 'output' }, fd4: { stream: Stream.fromQueue(commands), type: 'input' } },
    cwd: input.cwd ?? applicationRoot,
    env: { ...inherited, ...input.environment },
    extendEnv: false,
    stderr: 'pipe',
    stdin: Stream.fromQueue(standardInput),
    stdout: 'pipe',
  });
  yield* Effect.addFinalizer(() => Effect.all([Queue.end(commands), Queue.end(standardInput)]));
  yield* child.stdout.pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.runForEach((line) => Queue.offer(publicLines, line)),
    Effect.ensuring(Queue.end(publicLines)),
    Effect.forkScoped,
  );
  yield* child.getOutputFd(3).pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.runForEach((line) => Queue.offer(privateLines, line)),
    Effect.ensuring(Queue.end(privateLines)),
    Effect.forkScoped,
  );
  const privateDocuments = new Set<string>();
  const redactDiagnostic = (text: string) => {
    const redacted = '[REDACTED]';
    let diagnostic = text;
    for (const [name, value] of Object.entries(input.environment)) {
      if (value.length > 0 && /SECRET|TOKEN|PASSWORD|PRIVATE|API_KEY|DATABASE_URL|PRESHARED_KEY/u.test(name)) {
        diagnostic = diagnostic.replaceAll(value, redacted).replaceAll(JSON.stringify(value).slice(1, -1), redacted);
        const credential = URL.canParse(value) ? new URL(value).password : '';
        if (credential.length > 0) {
          diagnostic = diagnostic.replaceAll(credential, redacted);
        }
        const privateKey = /"d"\s*:\s*"(?<secret>[^"]+)"/u.exec(value)?.[1];
        if (privateKey !== undefined) {
          diagnostic = diagnostic.replaceAll(privateKey, redacted);
        }
      }
    }
    for (const document of privateDocuments) {
      diagnostic = diagnostic
        .replaceAll(document, '[REDACTED private frame]')
        .replaceAll(JSON.stringify(document).slice(1, -1), '[REDACTED private frame]');
    }
    return diagnostic
      .replaceAll(/(?<scheme>\w+:\/\/)[^\s/@]+:[^\s/@]+@/gu, '$<scheme>[REDACTED]@')
      .replaceAll(/eyJ[\w-]+\.[\w-]+\.[\w-]+/gu, redacted)
      .replaceAll(/(?<field>"d"\s*:\s*")[^"]+"/gu, '$<field>[REDACTED]"');
  };
  // Only complete, redacted lines enter the bounded tail. Never retain a credential fragment.
  let stderr = '';
  let pendingStderr = '';
  let oversizedLine = false;
  const appendStderr = (line: string) => {
    stderr = `${stderr}${redactDiagnostic(line)}\n`.slice(-16_384);
  };
  const stderrDrain = yield* child.stderr.pipe(
    Stream.decodeText(),
    Stream.runForEach((chunk) =>
      Effect.sync(() => {
        const lines = chunk.split('\n');
        for (const [index, line] of lines.entries()) {
          if (!oversizedLine) {
            if (pendingStderr.length + line.length > 16_384) {
              pendingStderr = '';
              oversizedLine = true;
            } else {
              pendingStderr += line;
            }
          }
          if (index < lines.length - 1) {
            appendStderr(oversizedLine ? '[stderr oversized line omitted]' : pendingStderr);
            pendingStderr = '';
            oversizedLine = false;
          }
        }
      }),
    ),
    Effect.tap(() =>
      Effect.sync(() => {
        appendStderr(oversizedLine ? '[stderr oversized line omitted]' : pendingStderr);
        pendingStderr = '';
      }),
    ),
    Effect.forkScoped,
  );
  yield* Effect.addFinalizer((exit) =>
    Exit.isFailure(exit)
      ? Fiber.join(stderrDrain).pipe(
          Effect.timeoutOption('100 millis'),
          Effect.ignore,
          Effect.andThen(
            Effect.sync(() => {
              if (stderr.length > 0) {
                process.stderr.write(`${input.stage}: child stderr\n${stderr}`);
              }
            }),
          ),
        )
      : Effect.void,
  );
  const childFailure = (stage: string) =>
    Effect.gen(function* collectChildFailure() {
      let exitCode: number | undefined;
      // Closed protocol fds do not imply exit, and descendants may still hold stderr open.
      yield* Effect.all(
        [
          child.exitCode.pipe(
            Effect.map((code) => {
              exitCode = code;
              return code;
            }),
          ),
          Fiber.join(stderrDrain),
        ],
        { concurrency: 'unbounded' },
      ).pipe(Effect.timeoutOption('100 millis'));
      const outcome = exitCode === undefined ? 'protocol closed; child exit pending' : `exited with ${exitCode}`;
      const details = {
        message: `${input.stage}: ${outcome}\n${stderr}${pendingStderr.length > 0 || oversizedLine ? '[stderr incomplete line withheld]\n' : ''}`,
        stage,
      };
      return new PreproposalNativeProtocolError(exitCode === undefined ? details : { ...details, exitCode });
    });
  const read = <Codec extends Schema.Top>(schema: Codec, channel: 'public' | 'private') =>
    Effect.logInfo(`Preproposal native: ${input.stage} waiting for ${channel} frame`).pipe(
      Effect.andThen(Queue.take(channel === 'private' ? privateLines : publicLines)),
      Effect.catchTag('Done', () => Effect.flatMap(childFailure(`${input.stage}:early-exit`), Effect.fail)),
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(schema))),
      Effect.tap(() => Effect.logInfo(`Preproposal native: ${input.stage} received ${channel} frame`)),
    );
  return {
    exit: Effect.logInfo(`Preproposal native: ${input.stage} waiting for exit`).pipe(
      Effect.andThen(child.exitCode),
      Effect.tap((code) => Effect.logInfo(`Preproposal native: ${input.stage} exited with ${code}`)),
      Effect.flatMap((code) =>
        code === 0 ? Effect.void : Effect.flatMap(childFailure(`${input.stage}:exit-code`), Effect.fail),
      ),
    ),
    read,
    send: (document: string, channel: 'stdin' | 'private', end = false) =>
      Effect.gen(function* sendClosedCommand() {
        if (channel === 'private') {
          privateDocuments.add(document);
        }
        const destination = channel === 'private' ? commands : standardInput;
        yield* Queue.offer(destination, new TextEncoder().encode(`${document}\n`));
        if (end) {
          yield* Queue.end(destination);
        }
      }),
  };
});

const buildOwnerExecutable = Effect.fn('PreproposalNative.buildOwnerExecutable')(function* buildOwnerExecutable(
  owner: string,
  filename: string,
  artifactRoot: string,
) {
  const directory = yield* io('artifact-directory', async () => await mkdtemp(`${artifactRoot}/owner-`));
  yield* io(
    'artifact-dependency-link',
    async () => await symlink(`${applicationRoot}${owner}/node_modules`, `${directory}/node_modules`),
  );
  const artifact = `${directory}/owner.mjs`;
  // Resolve only the owning package's published self subpaths. No foreign source is imported here.
  const metadata = yield* io(
    'owner-package-metadata',
    async () => await readFile(`${applicationRoot}${owner}/package.json`, 'utf-8'),
  );
  const packageMetadata = yield* Schema.decodeUnknownEffect(
    Schema.fromJsonString(
      Schema.Struct({
        exports: Schema.Record(Schema.String, Schema.Unknown),
        name: Schema.String,
      }),
    ),
  )(metadata);
  const aliases = Object.entries(packageMetadata.exports).flatMap(([key, target]) =>
    Schema.is(Schema.String)(target) && key.startsWith('./')
      ? [`--alias:${packageMetadata.name}${key.slice(1)}=${applicationRoot}${owner}/${target.replace(/^\.\//u, '')}`]
      : [],
  );
  const builder = yield* openNativeChild({
    args: [
      'exec',
      '--',
      'pnpm',
      'exec',
      'esbuild',
      `${owner}/tests/support/${filename}`,
      '--bundle',
      '--platform=node',
      '--format=esm',
      '--packages=external',
      ...aliases,
      `--outfile=${artifact}`,
      `--metafile=${directory}/inputs.json`,
    ],
    command: 'mise',
    environment: {},
    stage: `build:${owner}:${filename}`,
  });
  yield* builder.exit;
  return artifact;
});

const loadAllocatedPermissionEnvironment = Effect.fn('PreproposalNative.allocatedPermissionConfiguration')(
  function* loadAllocatedPermissionEnvironment(artifactRoot: string) {
    const environment = yield* readAllocatedPermissionEnvironment();
    const artifact = yield* buildOwnerExecutable(
      'packages/core-runtime',
      'preproposal-basis-config.fixture.ts',
      artifactRoot,
    );
    const canonicalizer = yield* openNativeChild({
      args: [artifact, '--canonicalize-preproposal-config'],
      environment: {},
      stage: 'core-private-permission-canonicalizer',
    });
    yield* canonicalizer.send(JSON.stringify({ environment, protocol: permissionConfigProtocol }), 'private', true);
    const result = yield* canonicalizer.read(
      Schema.Union([
        Schema.Struct({
          environment: PermissionEnvironmentSchema,
          protocol: Schema.Literal(permissionConfigProtocol),
          type: Schema.Literal('canonical'),
        }),
        Schema.Struct({
          protocol: Schema.Literal(permissionConfigProtocol),
          stage: Schema.Literal('configuration-invalid'),
          type: Schema.Literal('failed'),
        }),
      ]),
      'private',
    );
    yield* canonicalizer.exit;
    if (result.type !== 'canonical') {
      return yield* safeFailure('allocated-permission-configuration-invalid');
    }
    return result.environment;
  },
);

const digestDocument = (value: string) => createHash('sha256').update(value).digest('hex');
const makeNativeComposition = Effect.fn('PreproposalNative.composition')(function* makeNativeComposition(
  owners: readonly {
    readonly appId: string;
    readonly marker: typeof MarkerSchema.Type;
    readonly moduleId: string;
    readonly origin: string;
  }[],
) {
  const modules = owners.filter((owner) => owner.appId !== shellAudience);
  const snapshot = yield* makeApplicationCompositionSnapshotFixture(
    modules.map((owner) => owner.appId),
    Object.fromEntries(modules.map((owner) => [owner.appId, owner.marker.buildMarker])),
  );
  const contractJson = Schema.fromJsonString(OntosModuleDeploymentContractSchema);
  const replacements = yield* Effect.all(
    modules.map((owner) =>
      Effect.gen(function* nativeContract() {
        const contract = yield* Schema.decodeUnknownEffect(OntosModuleDeploymentContractSchema)(
          makeModuleContractFixture({
            appId: owner.appId,
            buildMarker: owner.marker.buildMarker,
            moduleId: owner.moduleId,
            outboxSubscriptions: owner.appId === contextAudience ? extractOutboxWorkerSubscriptions(outboxWorkers) : [],
          }),
        );
        const contractDocument = yield* Schema.encodeEffect(contractJson)(contract);
        return { ...owner, contractDocument, hash: digestDocument(contractDocument) };
      }),
    ),
  );
  const composition = {
    ...snapshot.composition,
    modules: snapshot.composition.modules.map((module) => {
      const owner = replacements.find((candidate) => candidate.appId === module.deployment.appId);
      if (owner === undefined) {
        return module;
      }
      return {
        ...module,
        backend: { baseUrl: `${owner.origin}/`, transport: 'node-http' as const },
        contract: { ...module.contract, sha256: owner.hash },
        contractDocument: owner.contractDocument,
        moduleId: owner.moduleId,
        publicContract: { id: owner.moduleId, sha256: owner.hash, version: module.publicContract.version },
      };
    }),
    revision: '0'.repeat(64),
  };
  const shell = owners.find((owner) => owner.appId === shellAudience);
  if (shell === undefined) {
    return yield* safeFailure('shell-composition-marker');
  }
  const shellDocument = yield* Schema.encodeUnknownEffect(Schema.fromJsonString(OntosShellRuntimeContractSchema))({
    contributionAbi: composition.shell.contributionAbi,
    coreCapabilities: [],
    deployment: shell.marker,
    schemaVersion: '2',
  });
  const completeInput = {
    ...composition,
    shell: {
      ...composition.shell,
      deployment: shell.marker,
      runtimeContract: { ...composition.shell.runtimeContract, sha256: digestDocument(shellDocument) },
    },
  };
  const complete = yield* Schema.decodeUnknownEffect(ApplicationCompositionSchema)(completeInput);
  return yield* validateActiveApplicationCompositionSnapshot({
    ...snapshot,
    composition: { ...complete, revision: digestDocument(canonicalizeApplicationComposition(complete)) },
  });
});

/** Stable placement before the creator clone exists; unchanged bytes reach the real owner. */
const makeOwnerPlacement = Effect.fn('PreproposalNative.ownerPlacement')(function* makeOwnerPlacement(appId: string) {
  let destination: URL | undefined;
  const layer = yield* Layer.build(NodeHttpServer.layerTest);
  const server = Context.get(layer, HttpServer.HttpServer);
  const client = yield* HttpClient.HttpClient;
  yield* server.serve(
    Effect.gen(function* forwardOwnerRequest() {
      if (destination === undefined) {
        return HttpServerResponse.empty({ status: 503 });
      }
      const incoming = yield* HttpServerRequest.HttpServerRequest;
      const request = yield* HttpServerRequest.toWeb(incoming);
      const url = new URL(incoming.url, destination);
      // Party/Shell fixtures mount their generated public prefix themselves. The other default
      // handler fixtures expose the owner-relative router, so this placement mounts its public prefix.
      const prefix = `/${appId}-api`;
      if (appId !== partyAudience && appId !== shellAudience && url.pathname.startsWith(`${prefix}/`)) {
        url.pathname = url.pathname.slice(prefix.length);
      }
      // Buffer the body: a streamed web Request body cannot be re-sent without duplex support.
      const body = new Uint8Array(yield* Effect.promise(async () => await request.arrayBuffer()));
      // Hop-by-hop framing belongs to the incoming hop; the buffered body is re-framed for this one.
      const headers = new Headers(request.headers);
      for (const name of ['connection', 'content-length', 'host', 'keep-alive', 'transfer-encoding', 'upgrade']) {
        headers.delete(name);
      }
      const forwarded = new Request(url, {
        body: body.byteLength === 0 ? null : body,
        headers,
        method: request.method,
      });
      const response = yield* client.execute(HttpClientRequest.fromWeb(forwarded));
      return HttpServerResponse.fromClientResponse(response);
    }).pipe(
      Effect.tapCause((cause) =>
        Effect.sync(() =>
          process.stderr.write(
            `placement-cause ${appId}: ${Cause.pretty(cause)
              .replaceAll(/eyJ[\w-]+\.[\w-]+\.[\w-]+/gu, '[REDACTED]')
              .slice(0, 4096)}\n`,
          ),
        ),
      ),
    ),
  );
  const address = yield* Schema.decodeUnknownEffect(Schema.Struct({ port: Schema.Int }))(server.address);
  return {
    bind: (port: number) =>
      Effect.sync(() => {
        destination = new URL(`http://127.0.0.1:${port}/`);
      }),
    origin: `http://127.0.0.1:${address.port}`,
  };
});

const makeCompositionSource = Effect.fn('PreproposalNative.compositionSource')(function* makeCompositionSource(
  document: string,
) {
  const layer = yield* Layer.build(NodeHttpServer.layerTest);
  const server = Context.get(layer, HttpServer.HttpServer);
  yield* server.serve(Effect.succeed(HttpServerResponse.text(document, { contentType: 'application/json' })));
  const address = yield* Schema.decodeUnknownEffect(Schema.Struct({ port: Schema.Int }))(server.address);
  return `http://127.0.0.1:${address.port}/composition`;
});

const identityProtocol = 'ontos.shell.preproposal-basis.identity.v1';
const identityService = Schema.Struct({
  authBindingId: AuthBindingIdSchema,
  principalId: PrincipalIdSchema,
  secret: Schema.RedactedFromValue(Schema.String),
});
const IdentityCreatedSchema = Schema.Struct({
  operation: Schema.Literal('PROVIDER_USER_CREATED'),
  protocol: Schema.Literal(identityProtocol),
  providerUserId: ProviderSubjectIdSchema,
});
const IdentityKeysSchema = Schema.Struct({
  buyerPrincipalId: PrincipalIdSchema,
  cccReader: identityService,
  operation: Schema.Literal('SERVICE_KEYS_CREATED'),
  pricingIssuer: identityService,
  protocol: Schema.Literal(identityProtocol),
  tenantId: TenantIdSchema,
});
const distinctManagedIdentities = (identities: typeof IdentityKeysSchema.Type, buyer: string, tenant: string) =>
  identities.buyerPrincipalId === buyer &&
  identities.tenantId === tenant &&
  identities.cccReader.principalId !== identities.pricingIssuer.principalId &&
  identities.cccReader.principalId !== buyer &&
  identities.pricingIssuer.principalId !== buyer;

const catalogProducerProtocol = 'ontos.catalog.preproposal-basis.producer.v1' as const;
const CatalogProducedSchema = Schema.Struct({
  pricingQuantity: CatalogQuantityHandoffSchema,
  protocol: Schema.Literal(catalogProducerProtocol),
  provenance: Schema.Unknown,
  quantity: Schema.Unknown,
  selection: CatalogSelectionSchema,
  setup: Schema.Unknown,
  type: Schema.Literal('produced'),
  unitRef: ProductUnitRefSchema,
});

const nativeActionKeys = [
  'commerce.cart.initialize-population-authority',
  'commerce.cart.create-cart-draft',
  'commerce.cart.revise-cart-draft',
  'commerce.catalog.create-product',
  'commerce.catalog.create-product-unit',
  'commerce.catalog.set-product-unit-target-divisibility',
  'commerce.catalog.set-product-localized-facts',
  'commerce.catalog.update-product',
  'commerce.catalog.create-attribute-definition',
  'commerce.catalog.create-product-type',
  'commerce.catalog.set-product-type',
  'commerce.catalog.govern-product-attribute-applicability',
  'commerce.catalog.set-variant-attribute-override',
  'commerce.catalog.govern-variant-axes',
  'commerce.catalog.govern-variant-allowed-values',
  'commerce.catalog.confirm-variant-combination',
  'commerce.catalog.create-product-category',
  'commerce.catalog.add-product-category-assignment',
  'commerce.catalog.publish-product-configuration',
  'party.registry.create-party',
  'party.registry.counterparty-customer-onboard',
  'commerce.storefront-registry.register-storefront-application',
  'commerce.market-catalog.create-market',
  'commerce.market-catalog.associate-storefront',
  'commerce.pricing.set-supported-currencies',
  'commerce.pricing.define-price',
  'commerce.pricing.manage-quotation',
  'commerce.customer-context.create-counterparty-purchasing-profile',
  'commerce.customer-context.bootstrap-counterparty-access-administrator',
  'commerce.customer-context.grant-counterparty-commerce-access',
  'commerce.customer-context.administer-purchase-currency-policy',
  'commerce.customer-context.prepare-purchase-proposal-basis',
  'commerce.customer-context.complete-purchase-proposal-basis',
  'commerce.customer-context.create-purchase-proposal-revision',
  'commerce.customer-context.create-approval-hierarchy',
  'commerce.customer-context.change-counterparty-purchase-limit',
  'commerce.customer-context.submit-purchase-approval-request',
  'commerce.customer-context.decide-purchase-approval-request',
];
const identitySetupActionKeys = ['core.identity.create-non-human-principal', 'core.identity.bind-managed-api-key'];

const partySetupActionKeys = ['party.registry.resolve-duplicate-candidate-create'];

const originalPartyReviewEvidenceMatches = (
  original: typeof PartyMatchDecisionResponseSchema.Type,
  initial: Extract<typeof CreatePartyResultSchema.Type, { readonly outcome: 'AMBIGUOUS' }>,
  detail: typeof DuplicateCandidateDetailResponseSchema.Type,
) =>
  Schema.toEquivalence(PartyMatchDecisionResponseSchema.fields.decisionRef)(
    original.decisionRef,
    initial.decisionRef,
  ) &&
  original.operation === 'CREATE' &&
  original.outcome === 'AMBIGUOUS' &&
  original.committedCreateOutcome === 'AMBIGUOUS' &&
  original.caseRef !== null &&
  Schema.toEquivalence(DuplicateCandidateDetailResponseSchema.fields.caseRef)(original.caseRef, detail.caseRef) &&
  Schema.toEquivalence(PartyMatchDecisionResponseSchema.fields.evidenceExplanation)(
    original.evidenceExplanation,
    detail.evaluatedEvidence,
  );

const partyReviewResolutionMatches = (
  review: Effect.Success<ReturnType<typeof resolveDuplicateCandidateCreateWithAuthorization>>,
  initial: Extract<typeof CreatePartyResultSchema.Type, { readonly outcome: 'AMBIGUOUS' }>,
  tenantId: string,
) =>
  review.outcome === 'CREATE_NEW' &&
  review.lifecycleState === 'RESOLVED' &&
  Schema.toEquivalence(DuplicateCandidateDetailResponseSchema.fields.caseRef)(review.caseRef, initial.caseRef) &&
  review.partyRef?.tenantId === tenantId &&
  review.decisionRef?.tenantId === tenantId &&
  !Schema.toEquivalence(PartyMatchDecisionResponseSchema.fields.decisionRef)(review.decisionRef, initial.decisionRef);

const reviewedPartyCreationMatches = (
  decision: typeof PartyMatchDecisionResponseSchema.Type,
  review: Effect.Success<ReturnType<typeof resolveDuplicateCandidateCreateWithAuthorization>>,
  detail: typeof DuplicateCandidateDetailResponseSchema.Type,
) =>
  decision.outcome === 'CREATED' &&
  decision.committedCreateOutcome === 'CREATED' &&
  decision.operation === 'REVIEW_CREATE' &&
  review.decisionRef !== null &&
  Schema.toEquivalence(PartyMatchDecisionResponseSchema.fields.decisionRef)(decision.decisionRef, review.decisionRef) &&
  decision.partyRef !== null &&
  review.partyRef !== null &&
  Schema.toEquivalence(CounterpartyCustomerOnboardPayloadSchema.fields.partyRef)(decision.partyRef, review.partyRef) &&
  decision.evidenceEvaluation !== null &&
  decision.evidenceEvaluation !== undefined &&
  decision.evidenceEvaluation.subjectEligible &&
  decision.evidenceEvaluation.typeSupported &&
  decision.evidenceEvaluation.evidence.length > 0 &&
  Schema.toEquivalence(Schema.toEncoded(CreatePartyPayloadSchema.fields.candidate.fields.subjectEvidence))(
    decision.evidenceEvaluation.evidence,
    detail.candidate.subjectEvidence ?? [],
  );

/** Real public owner setup; review authority is manager-only, never a service grant. */
export const createRegisteredPreproposalParty = Effect.fn('PreproposalNative.createParty')(
  function* createRegisteredPreproposalParty<Failure, Requirements>(input: {
    readonly authorize: (legalEntity: boolean) => Effect.Effect<Redacted.Redacted, Failure, Requirements>;
    readonly intent: string;
    readonly options: Pick<Parameters<typeof createPartyWithAuthorization>[2], 'baseUrl' | 'compositionRevision'>;
    readonly payload: typeof CreatePartyPayloadSchema.Type;
    readonly tenantId: string;
  }) {
    const refuse = (outcome: string, reason: string) =>
      new PreproposalNativeProtocolError({
        message: `Party setup ${outcome}: ${reason}`,
        stage: 'registered-party-not-created',
      });
    const initialCreate = yield* createPartyWithAuthorization(
      input.payload,
      Redacted.value(yield* input.authorize(false)),
      { ...input.options, correlationId: `${input.intent}:party`, idempotencyKey: `${input.intent}:party` },
    );
    if (initialCreate.outcome === 'MATCHED_EXISTING') {
      return yield* refuse(initialCreate.outcome, 'A newly created Party is required; matching is not creation');
    }
    if (initialCreate.outcome === 'CREATED') {
      if (initialCreate.partyRef.tenantId !== input.tenantId || initialCreate.decisionRef.tenantId !== input.tenantId) {
        return yield* refuse(initialCreate.outcome, 'Create references do not belong to the setup tenant');
      }
      return { initialCreate, partyRef: initialCreate.partyRef };
    }
    const sameCase = Schema.toEquivalence(DuplicateCandidateDetailResponseSchema.fields.caseRef);
    if (initialCreate.caseRef.tenantId !== input.tenantId || initialCreate.decisionRef.tenantId !== input.tenantId) {
      return yield* refuse(initialCreate.outcome, 'Ambiguous references do not belong to the setup tenant');
    }
    const detail = yield* executeDuplicateCandidateDetailWithAuthorization(
      { caseRef: initialCreate.caseRef },
      Redacted.value(yield* input.authorize(true)),
      `${input.intent}:party-review-detail`,
      input.options,
    );
    if (
      !sameCase(detail.caseRef, initialCreate.caseRef) ||
      !['OPEN', 'NEEDS_EVIDENCE'].includes(detail.lifecycleState) ||
      detail.candidate.partyType !== 'PERSON' ||
      !Schema.toEquivalence(CreatePartyPayloadSchema)({ candidate: detail.candidate }, input.payload)
    ) {
      return yield* refuse(
        initialCreate.outcome,
        'Review detail must preserve the originating open case, candidate and evidence',
      );
    }
    const originalDecision = yield* executePartyMatchDecisionWithAuthorization(
      { decisionRef: initialCreate.decisionRef },
      Redacted.value(yield* input.authorize(true)),
      `${input.intent}:party-create-decision-before`,
      input.options,
    );
    if (!originalPartyReviewEvidenceMatches(originalDecision, initialCreate, detail)) {
      return yield* refuse(
        originalDecision.outcome,
        'The original create decision must prove this exact review case and evaluated evidence',
      );
    }
    const review = yield* resolveDuplicateCandidateCreateWithAuthorization(
      {
        caseRef: detail.caseRef,
        expectedRevision: detail.revision,
        reason:
          'Reviewed the original direct-interaction PERSON attestation for the distinct isolated purchase customer without a strong identifier',
      },
      Redacted.value(yield* input.authorize(true)),
      {
        ...input.options,
        correlationId: `${input.intent}:party-review-create`,
        idempotencyKey: `${input.intent}:party-review-create`,
      },
    );
    if (
      review.partyRef === null ||
      review.decisionRef === null ||
      !partyReviewResolutionMatches(review, initialCreate, input.tenantId)
    ) {
      return yield* refuse(
        review.outcome,
        'Review must create a new Party and decision for the originating case and tenant',
      );
    }
    const createdDecision = yield* executePartyMatchDecisionWithAuthorization(
      { decisionRef: review.decisionRef },
      Redacted.value(yield* input.authorize(true)),
      `${input.intent}:party-review-decision`,
      input.options,
    );
    if (!reviewedPartyCreationMatches(createdDecision, review, detail)) {
      return yield* refuse(
        createdDecision.outcome,
        'The public review decision must prove literal CREATED for that Party and original concrete subject evidence',
      );
    }
    const unchangedDecision = yield* executePartyMatchDecisionWithAuthorization(
      { decisionRef: initialCreate.decisionRef },
      Redacted.value(yield* input.authorize(true)),
      `${input.intent}:party-create-decision-after`,
      input.options,
    );
    if (!Schema.toEquivalence(PartyMatchDecisionResponseSchema)(unchangedDecision, originalDecision)) {
      return yield* refuse(unchangedDecision.outcome, 'Review changed the original create decision history');
    }
    return { createdDecision, initialCreate, originalDecision, partyRef: review.partyRef, review };
  },
);

/** Entire setup is scoped inside the explicitly selected integration case. */
export const makeRegisteredPreproposalNativeFixture = Effect.fn('PreproposalNative.fixture')(
  // oxlint-disable-next-line eslint/complexity -- One generator sequences the whole native owner chain; remove-when: the chain is split per owner.
  function* makeRegisteredPreproposalNativeFixture() {
    const configuration = yield* Config.all({
      admin: Config.Redacted('DATABASE_ADMIN_URL'),
      runtime: Config.Redacted('DATABASE_URL'),
      sourceDatabase: Config.String('ONTOS_PREPROPOSAL_SOURCE_DATABASE'),
      taskRoot: Config.String('ONTOS_PREPROPOSAL_TASK_ROOT'),
    });
    const sourceBootstrapDocument = yield* io(
      'controller-source-bootstrap-receipt',
      async () => await readFile(`${configuration.taskRoot}/source-bootstrap-completed.json`, 'utf-8'),
    );
    yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(sourceBootstrapDocument);
    // The controller validates its own phase/journal contract before invoking this test. Retain
    // its exact receipt bytes' digest; independently validate and clone the actual DB below.
    const sourceBootstrapReceiptSha256 = digestDocument(sourceBootstrapDocument);
    const sourceConnections = yield* parseDatabaseConnectionPair({
      DATABASE_ADMIN_URL: Redacted.value(configuration.admin),
      DATABASE_URL: Redacted.value(configuration.runtime),
    });
    yield* requireProtocol(
      sourceConnections.admin.database === configuration.sourceDatabase &&
        /^ontos_test_[a-z0-9_]+$/u.test(configuration.sourceDatabase) &&
        configuration.taskRoot.startsWith('/') &&
        !configuration.taskRoot.startsWith(applicationRoot),
      'task-owned-source-and-workspace',
    );
    yield* io('task-artifact-root', async () => await mkdir(configuration.taskRoot, { recursive: true }));
    const artifactRoot = yield* io(
      'task-artifact-root',
      async () => await mkdtemp(`${configuration.taskRoot}/preproposal-artifacts-`),
    );
    yield* Effect.addFinalizer(() =>
      io('artifact-cleanup', async () => await rm(artifactRoot, { force: true, recursive: true })).pipe(Effect.orDie),
    );
    const owners = yield* Effect.all(
      ownerDefinitions.map((definition) =>
        Effect.gen(function* prepareOwnerPlacement() {
          const artifact = yield* buildOwnerExecutable(definition.owner, definition.receiver, artifactRoot);
          // Generated build identity is metadata. Some historical --describe receivers install
          // their server Layer even on that branch; never execute them for discovery.
          const document = yield* io(
            `metadata:${definition.appId}`,
            async () => await readFile(`${applicationRoot}${definition.owner}/shared/ultramodern-build.json`, 'utf-8'),
          );
          const metadata = yield* Schema.decodeUnknownEffect(
            Schema.fromJsonString(
              Schema.Struct({ deliveryUnit: MarkerSchema, surfaces: Schema.Struct({ api: MarkerSchema }) }),
            ),
          )(document);
          const marker = definition.appId === shellAudience ? metadata.deliveryUnit : metadata.surfaces.api;
          yield* requireProtocol(marker.appId === definition.appId, `owner-marker:${definition.appId}`);
          const placement = yield* makeOwnerPlacement(definition.appId);
          return { ...definition, artifact, marker, ...placement };
        }),
      ),
    );
    const snapshot = yield* makeNativeComposition(owners);
    const compositionRevision = snapshot.composition.revision;
    const compositionDocument = yield* Schema.encodeEffect(
      Schema.fromJsonString(ActiveApplicationCompositionSnapshotSchema),
    )(snapshot);
    const compositionUrl = yield* makeCompositionSource(compositionDocument);
    const owned = yield* makeIsolatedNativeDatabaseFixture({
      compositionSnapshot: snapshot,
      mode: 'schema-only',
      purpose: 'stabilization-1257-approval-fresh-proof',
      sourceConnections,
    });
    yield* owned.assertClonedSchema();
    const nativeDatabase = PgClient.layer({ url: Redacted.make(owned.connections.runtime.connectionString) }).pipe(
      Layer.provideMerge(Reactivity.layer),
    );
    // Core's evidence reader now requires an explicit admin executor. Keep it on
    // this same isolated clone; the shared runtime role cannot read Core events.
    const evidenceServices = yield* Layer.build(
      PgClient.layer({ url: Redacted.make(owned.connections.admin.connectionString) }).pipe(
        Layer.provideMerge(Reactivity.layer),
      ),
    );
    const evidenceDatabase = yield* testCoreDatabase.pipe(Effect.provideContext(evidenceServices));
    const databaseIdentity = yield* Effect.gen(function* observeCreatorDatabase() {
      const sql = yield* PgClient.PgClient;
      const [identity] = yield* sql.unsafe(
        `select d.oid::integer as oid, pg_get_userbyid(d.datdba) as owner, current_user as role, current_database() as database from pg_catalog.pg_database d where d.datname=current_database()`,
      );
      return yield* Schema.decodeUnknownEffect(
        Schema.Struct({ database: Schema.String, oid: Schema.Int, owner: Schema.String, role: Schema.String }),
      )(identity);
    }).pipe(Effect.provide(nativeDatabase));
    yield* requireProtocol(
      databaseIdentity.database === owned.connections.runtime.database &&
        databaseIdentity.owner === owned.connections.admin.user &&
        databaseIdentity.role === 'ontos_runtime',
      'creator-database-identity',
    );
    const pair = yield* io('ephemeral-test-key', async () => await generateKeyPair('EdDSA', { extractable: true }));
    const publicJwk = yield* io('ephemeral-public-key', async () => await exportJWK(pair.publicKey));
    const privateJwk = yield* io('ephemeral-private-key', async () => await exportJWK(pair.privateKey));
    const issuer = 'https://preproposal-native-test.invalid';
    const kid = `preproposal-${randomUUID()}`;
    const shell = owners.find((owner) => owner.appId === shellAudience);
    if (shell === undefined) {
      return yield* safeFailure('shell-owner');
    }
    const allocatedPermissionEnvironment = yield* loadAllocatedPermissionEnvironment(artifactRoot);
    const ownerDatabaseEnvironment = Object.fromEntries(
      yield* Effect.all(
        DATABASE_IDENTITIES.map((identity) =>
          Effect.gen(function* isolatedOwnerDatabaseIdentity() {
            const configured = yield* loadDatabaseConfig({ identity });
            yield* requireProtocol(
              configured.host === sourceConnections.admin.host && configured.port === sourceConnections.admin.port,
              `same-isolated-database-server:${identity.id}`,
            );
            const connection = new URL(configured.connectionString);
            connection.pathname = `/${owned.connections.runtime.database}`;
            return [identity.urlKey, connection.href] as const;
          }),
        ),
      ),
    );
    const baseEnvironment = {
      ...allocatedPermissionEnvironment,
      ...ownerDatabaseEnvironment,
      BETTER_AUTH_SECRET: `${randomUUID()}${randomUUID()}`,
      BETTER_AUTH_TRUSTED_ORIGINS: shell.origin,
      BETTER_AUTH_URL: shell.origin,
      DATABASE_URL: owned.connections.runtime.connectionString,
      ONTOS_ACTIVE_APPLICATION_COMPOSITION_URL: compositionUrl,
      ONTOS_GATEWAY_ISSUER: issuer,
      ONTOS_GATEWAY_PRIVATE_JWK: JSON.stringify({ ...privateJwk, alg: 'EdDSA', kid, use: 'sig' }),
      ONTOS_GATEWAY_PUBLIC_JWKS: JSON.stringify({ keys: [{ ...publicJwk, alg: 'EdDSA', kid, use: 'sig' }] }),
      ONTOS_PREPROPOSAL_DATABASE_OID: String(databaseIdentity.oid),
      ONTOS_PREPROPOSAL_DATABASE_OWNER: databaseIdentity.owner,
      ONTOS_PREPROPOSAL_OWNED_DATABASE: databaseIdentity.database,
      ONTOS_PREPROPOSAL_SOURCE_DATABASE: sourceConnections.admin.database,
      RESEND_API_KEY: 're_native_preproposal_fixture_no_delivery',
      RESEND_API_URL: 'https://127.0.0.1:1/emails',
      RESEND_FROM_EMAIL: 'Native fixture <native@preproposal.example.test>',
    };
    const identityArtifact = yield* buildOwnerExecutable(
      'apps/shell-super-app',
      'preproposal-basis-identity.fixture.ts',
      artifactRoot,
    );
    const identityChild = yield* openNativeChild({
      args: [identityArtifact, servePreproposal],
      environment: baseEnvironment,
      stage: 'shell-identity',
    });
    const provider = yield* identityChild.read(IdentityCreatedSchema, 'private');
    const moduleKeys = owners.filter((owner) => owner.appId !== shellAudience).map((owner) => owner.moduleId);
    yield* Effect.logInfo('Preproposal native: initializing Core operation fixture');
    const core = yield* Effect.acquireRelease(
      makeLiveOperationFixture({
        actionExecutor: 'manager-only',
        actionKeys: [...nativeActionKeys, ...identitySetupActionKeys, ...partySetupActionKeys],
        adminConnectionString: Redacted.make(owned.connections.admin.connectionString),
        allowedAudiences: owners.map((owner) => owner.appId),
        authenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID,
        compositionRevision,
        managerIdentityAdmin: true,
        managerProviderSubjectId: provider.providerUserId,
        moduleAccess: 'configured-modules',
        moduleKeys,
        runtimeConnectionString: Redacted.make(owned.connections.runtime.connectionString),
      }),
      (resource) => resource.close().pipe(Effect.orDie),
    );
    yield* Effect.logInfo('Preproposal native: Core operation fixture ready');
    yield* requireProtocol(
      matchesAllocatedPermissionEnvironment(allocatedPermissionEnvironment, core.permissionEnvironment),
      'same-allocated-private-permission-configuration',
    );
    yield* identityChild.send(
      JSON.stringify({
        buyerPrincipalId: core.manager.principalId,
        operation: 'CREATE_SERVICE_KEYS',
        protocol: identityProtocol,
        tenantId: core.tenantId,
      }),
      'private',
    );
    const identities = yield* identityChild.read(IdentityKeysSchema, 'private');
    yield* requireProtocol(
      distinctManagedIdentities(identities, core.manager.principalId, core.tenantId),
      'genuine-distinct-managed-identities',
    );
    for (const service of [identities.cccReader, identities.pricingIssuer]) {
      yield* core.grantExistingService({
        actionKeys: nativeActionKeys,
        legalEntityId: core.legalEntityId,
        moduleKeys,
        principalId: service.principalId,
      });
    }
    yield* identityChild.send(JSON.stringify({ operation: 'STOP', protocol: identityProtocol }), 'private', true);
    yield* identityChild.read(
      Schema.Struct({ operation: Schema.Literal('STOPPED'), protocol: Schema.Literal(identityProtocol) }),
      'private',
    );
    yield* identityChild.exit;
    const permissionEnvironment: NativePermissionEnvironment = {
      SPICEDB_ENDPOINT: core.permissionEnvironment.SPICEDB_ENDPOINT,
      SPICEDB_PRESHARED_KEY: Redacted.value(core.permissionEnvironment.SPICEDB_PRESHARED_KEY),
    };
    if (core.permissionEnvironment.SPICEDB_CA_CERT !== undefined) {
      permissionEnvironment.SPICEDB_CA_CERT = core.permissionEnvironment.SPICEDB_CA_CERT;
    }
    if (core.permissionEnvironment.ULTRAMODERN_DEPLOYMENT_ENVIRONMENT !== undefined) {
      permissionEnvironment.ULTRAMODERN_DEPLOYMENT_ENVIRONMENT =
        core.permissionEnvironment.ULTRAMODERN_DEPLOYMENT_ENVIRONMENT;
    }
    const serviceGrant = {
      authenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID,
      legalEntityId: core.legalEntityId,
      principalId: identities.cccReader.principalId,
      tenantId: core.tenantId,
    };
    const environment = {
      ...baseEnvironment,
      ...permissionEnvironment,
      [`ONTOS_CATALOG_CART_POPULATION_${core.tenantId.replaceAll('-', '').toUpperCase()}_GATEWAY_API_KEY`]:
        Redacted.value(identities.cccReader.secret),
      [`ONTOS_CATALOG_CART_POPULATION_${core.tenantId.replaceAll('-', '').toUpperCase()}_OWNER_ORIGIN`]:
        owners.find((owner) => owner.appId === cartAudience)?.origin ?? '',
      [`ONTOS_CATALOG_CART_POPULATION_${core.tenantId.replaceAll('-', '').toUpperCase()}_SHELL_ORIGIN`]: shell.origin,
      ONTOS_CART_PREAPPROVAL_SERVICE_GRANTS: JSON.stringify([
        serviceGrant,
        { ...serviceGrant, principalId: identities.pricingIssuer.principalId },
      ]),
      // CCC's preproposal identity is the Pricing issuer: Pricing reports the calling principal as the Quotation issuer.
      ONTOS_CCC_PREPROPOSAL_GATEWAY_API_KEY: Redacted.value(identities.pricingIssuer.secret),
      ONTOS_CCC_PREPROPOSAL_PRICING_ISSUER_PRINCIPAL_ID: identities.pricingIssuer.principalId,
      ONTOS_CCC_PREPROPOSAL_SERVICE_GRANTS: JSON.stringify([
        serviceGrant,
        { ...serviceGrant, principalId: identities.pricingIssuer.principalId },
      ]),
      ONTOS_COMMERCE_CUSTOMER_CONTEXT_GATEWAY_API_KEY: Redacted.value(identities.cccReader.secret),
      ONTOS_PREPROPOSAL_FAILURE_SPAN: 'service.resolveSubmission',
      // Setup-only: Market validates the Storefront through the same granted service identity.
      ONTOS_COMMERCE_MARKET_CATALOG_GATEWAY_API_KEY: Redacted.value(identities.cccReader.secret),
      // Run-local signing material for Pricing immutable owner proofs; never a deployed secret.
      ONTOS_PRICING_CONFIRMATION_KEY_LINEAGE_REF: 'preproposal-native-lineage',
      ONTOS_PRICING_CONFIRMATION_KEY_REF: 'preproposal-native-key',
      ONTOS_PRICING_CONFIRMATION_KEY_VERSION: '1',
      ONTOS_PRICING_CONFIRMATION_SIGNING_SECRET: randomBytes(32).toString('hex'),
      ONTOS_PRICING_GATEWAY_API_KEY: Redacted.value(identities.pricingIssuer.secret),
      ONTOS_PRICING_PREPROPOSAL_NAMESPACE_ID: STAFF_AUTHENTICATION_NAMESPACE_ID,
      ONTOS_PRICING_PREPROPOSAL_PRINCIPAL_ID: identities.pricingIssuer.principalId,
      ONTOS_SHELL_GATEWAY_BASE_URL: `${shell.origin}/shell-super-app-api`,
    };
    for (const owner of owners) {
      const receiver = yield* openNativeChild({
        args: [owner.artifact, owner.serve],
        environment,
        stage: `receiver:${owner.appId}`,
      });
      const ready = yield* receiver.read(ReadySchema, 'public');
      yield* requireProtocol(
        ready.marker.appId === owner.appId && ready.marker.buildMarker === owner.marker.buildMarker,
        `exact-receiver:${owner.appId}`,
      );
      yield* owner.bind(ready.port);
    }
    const storefrontId = `native-preproposal-${randomUUID()}`;
    const intent = `native-preproposal:${randomUUID()}`;
    const ownerFor = (audience: string) => {
      const owner = owners.find((candidate) => candidate.appId === audience);
      if (owner === undefined) {
        throw safeFailure('fixed-owner-audience');
      }
      return owner;
    };
    const scopeGrantArtifact = yield* buildOwnerExecutable(
      'packages/core-runtime',
      'preproposal-scope-grant.fixture.ts',
      artifactRoot,
    );
    const scopeGrantChild = yield* openNativeChild({
      args: [scopeGrantArtifact],
      environment,
      stage: 'core-signed-assertion-registrar',
    });
    yield* scopeGrantChild.read(Schema.Struct({ type: Schema.Literal('ready') }), 'public');
    const signBuyer = Effect.fn('PreproposalNative.TESTAuthenticationOnly')(function* signBuyer(
      audience: string,
      legalEntity: boolean,
      storefront: boolean,
    ) {
      const owner = ownerFor(audience);
      const now = Math.floor(DateTime.toEpochMillis(yield* DateTime.now) / 1000);
      const principal: typeof core.manager & { legalEntityId?: string; trustedStorefrontId?: string } = {
        ...core.manager,
      };
      if (legalEntity) {
        principal.legalEntityId = core.legalEntityId;
      }
      if (storefront) {
        principal.trustedStorefrontId = storefrontId;
      }
      const jti = randomUUID();
      const expiresAtEpochSeconds = now + GATEWAY_ASSERTION_TTL_SECONDS;
      const token = yield* io(
        'test-auth-only-signature',
        async () =>
          await new SignJWT({
            compositionRevision,
            principal,
            targetBuildMarker: owner.marker.buildMarker,
            ver: EXTERNAL_GATEWAY_ASSERTION_VERSION,
          })
            .setProtectedHeader({ alg: 'EdDSA', kid, typ: 'JWT' })
            .setIssuer(issuer)
            .setAudience(audience)
            .setSubject(core.manager.principalId)
            .setIssuedAt(now)
            .setExpirationTime(expiresAtEpochSeconds)
            .setJti(jti)
            .sign(pair.privateKey),
      );
      if (audience === partyAudience) {
        yield* scopeGrantChild.send(
          JSON.stringify({
            assertion: token,
            audience,
            expiresAtEpochSeconds,
            jti,
            legalEntityId: principal.legalEntityId,
            principalId: core.manager.principalId,
            tenantId: core.tenantId,
          }),
          'stdin',
        );
        yield* scopeGrantChild.read(Schema.Struct({ type: Schema.Literal('registered') }), 'public');
      }
      return Redacted.make(`Bearer ${token}`);
    });
    const serviceCredential = Effect.fn('PreproposalNative.actualShellServiceCredential')(function* serviceCredential(
      service: typeof identities.cccReader,
      audience: string,
      legalEntity: boolean,
    ) {
      const request: MutableNativeGatewayRequest = {
        audience,
        compositionRevision,
      };
      if (legalEntity) {
        request.legalEntityId = core.legalEntityId;
      }
      const result = yield* issueApiKeyGatewayContext(request, {
        apiKey: service.secret,
        baseUrl: `${shell.origin}/shell-super-app-api`,
        requestCorrelation: `${intent}:service-credential`,
      });
      yield* requireProtocol(result.compositionRevision === compositionRevision, 'actual-shell-composition');
      return Redacted.make(`Bearer ${result.token}`);
    });
    const authorize = Effect.fn('PreproposalNative.authorize')(function* authorize(
      role: NativeRole,
      audience: NativeAudience,
    ) {
      const authorization =
        role === 'buyer' || role === 'operator'
          ? yield* signBuyer(
              audience,
              !(role === 'operator' && audience === cartAudience),
              role === 'buyer' && audience === contextAudience,
            )
          : yield* serviceCredential(
              role === pricingIssuerRole ? identities.pricingIssuer : identities.cccReader,
              audience,
              true,
            );
      return {
        authorization,
        options: { baseUrl: new URL(`${ownerFor(audience).origin}/${audience}-api`), compositionRevision },
      };
    });
    const transport = {
      authorize,
      buyerPrincipalId: core.manager.principalId,
      cccReaderPrincipalId: identities.cccReader.principalId,
      core: { evidence: () => core.evidence(evidenceDatabase) },
      pricingIssuerPrincipalId: identities.pricingIssuer.principalId,
    };
    const now = yield* DateTime.now;
    const at = DateTime.formatIso(now);
    const legalEntityRef = {
      moduleId: identityModule,
      resourceId: core.legalEntityId,
      resourceType: 'core.identity.legal-entity',
      tenantId: core.tenantId,
    };
    const principalRef = { principalId: core.manager.principalId, tenantId: core.tenantId };
    const partyPayload = yield* Schema.decodeUnknownEffect(CreatePartyPayloadSchema)({
      candidate: {
        displayName: `Native preproposal buyer ${randomUUID()}`,
        evidenceRefs: [`${intent}:subject-attestation`],
        officialIdentifiers: [],
        partyType: 'PERSON',
        provenance: { method: 'DIRECT_INTERACTION', source: 'NATIVE_REGISTERED_OWNER_PROOF' },
        subjectEvidence: [
          {
            basis: 'DIRECT_INTERACTION',
            evidenceRef: `${intent}:subject-attestation`,
            kind: 'ACTOR_ATTESTATION',
            observedSubject: 'PERSON',
            statement: 'Operator attests the distinct human customer for this isolated native purchase',
            subjectKey: `${intent}:customer`,
          },
        ],
        validFrom: at,
      },
    });
    const party = yield* createRegisteredPreproposalParty({
      authorize: (legalEntity) => signBuyer(partyAudience, legalEntity, false),
      intent,
      options: { baseUrl: `${ownerFor(partyAudience).origin}/party-registry-api`, compositionRevision },
      payload: partyPayload,
      tenantId: core.tenantId,
    });
    const onboardPayload = yield* Schema.decodeUnknownEffect(CounterpartyCustomerOnboardPayloadSchema)({
      counterpartyProvenance: {
        evidenceReference: `${intent}:counterparty-relationship`,
        method: 'APPROVED_COMMERCIAL_RELATIONSHIP',
        reason: 'Operator approves this isolated commercial relationship with the selling Legal Entity',
        source: 'NATIVE_REGISTERED_OWNER_PROOF',
      },
      customerEvidence: {
        evidenceReference: `${intent}:customer-role`,
        method: 'APPROVED_PURCHASING_RELATIONSHIP',
        reason: 'Operator approves this isolated CUSTOMER purchasing relationship',
        source: 'NATIVE_REGISTERED_OWNER_PROOF',
      },
      partyRef: party.partyRef,
      validFrom: at,
    });
    const counterparty = yield* counterpartyCustomerOnboardWithAuthorization(
      onboardPayload,
      Redacted.value(yield* signBuyer(partyAudience, true, false)),
      {
        baseUrl: `${ownerFor(partyAudience).origin}/party-registry-api`,
        compositionRevision,
        correlationId: `${intent}:customer`,
        idempotencyKey: `${intent}:customer`,
      },
    );
    yield* core.grantResourceAccess(counterparty.counterpartyRef, identities.cccReader.principalId, 'reader');
    yield* core.grantResourceAccess(counterparty.counterpartyRef, identities.pricingIssuer.principalId, 'reader');
    const profileCredential = yield* authorize('operator', contextAudience);
    const profile = yield* executeCreateCounterpartyPurchasingProfileWithAuthorization(
      {
        effectiveAt: at,
        subject: { counterpartyRef: counterparty.counterpartyRef, kind: 'COUNTERPARTY' },
        trigger: 'AUTHORIZED_ONBOARDING',
      },
      Redacted.value(profileCredential.authorization),
      `${intent}:profile`,
      { ...profileCredential.options, idempotencyKey: `${intent}:profile` },
    );
    yield* requireProtocol(
      profile.outcome === 'PROFILE_CREATED' && profile.state === 'ACTIVE',
      'registered-active-profile',
    );

    const overlay = commerceCustomerContextOwnerAuthorizationOverlayLive.pipe(
      Layer.provide(profileRetailPermissionReaderFactoryLive),
      Layer.provide(ContextAccessLive),
    );
    const coreLayer = core.layer.pipe(Layer.provide(overlay));
    const runtimeContext = yield* Layer.build(coreLayer);
    const ownerConfiguration = ConfigProvider.layer(ConfigProvider.fromUnknown(environment));
    const redemptionLayer = GatewayAssertionRedemptionLive.pipe(
      Layer.provide(GatewayAssertionRedemptionDatabaseLive),
      Layer.provide(nativeDatabase),
    );
    const redemption = Context.get(yield* Layer.build(redemptionLayer), GatewayAssertionRedemptionService);
    const authenticatedOperator = yield* bindGatewayPrincipalVerifier(contextAudience, ultramodernApiMarker)
      .verifyAndRedeem(yield* signBuyer(contextAudience, true, false), { environment, redemption })
      .pipe(Effect.provideService(ActiveApplicationCompositionService, { load: Effect.succeed(snapshot) }));
    const administerCurrencyPolicy = (
      label: string,
      expectedGeneration: number,
      value: { readonly currencyCode: 'CZK'; readonly kind: 'ALLOWED_CURRENCY_CONSTRAINT' | 'DEFAULT_CURRENCY' },
    ) =>
      Effect.gen(function* administerRevision() {
        const payload = yield* Schema.decodeUnknownEffect(PurchaseCurrencyPolicyAdministrationPayloadSchema)({
          _tag: 'CREATE_REVISION',
          expectedGeneration,
          revision: {
            effectiveFrom: at,
            effectiveTo: null,
            field: 'PURCHASE_CURRENCY',
            idempotencyKey: `${intent}:currency-policy:${label}`,
            lifecycle: 'ACTIVE',
            reason: 'Native genuine currency policy',
            revisionId: randomUUID(),
            scope: { kind: 'SELLER', sellingLegalEntityId: core.legalEntityId },
            value,
          },
        });
        return yield* Context.get(runtimeContext, ActionRuntime)
          .runAction({
            audience: contextAudience,
            payload,
            principal: authenticatedOperator,
            registration: administerPurchaseCurrencyPolicyAction,
            transport: {
              correlationId: `${intent}:currency-policy:${label}`,
              idempotencyKey: `${intent}:currency-policy:${label}`,
              targetModuleKey: contextModule,
            },
          })
          .pipe(Effect.provideContext(runtimeContext));
      });
    yield* administerCurrencyPolicy('allowed', 0, { currencyCode: 'CZK', kind: 'ALLOWED_CURRENCY_CONSTRAINT' });
    const currencyPolicy = yield* administerCurrencyPolicy('default', 1, {
      currencyCode: 'CZK',
      kind: 'DEFAULT_CURRENCY',
    });
    yield* requireProtocol(currencyPolicy.changed, 'registered-currency-policy');
    const workerLayer = outboxWorkerLayer.pipe(
      Layer.provide(OutboxRepositoryLive),
      Layer.provide(ContextAccessLive),
      Layer.provide(BusinessPermissionRelationshipMutationLive),
      Layer.provideMerge(coreLayer),
      Layer.provide(ownerConfiguration),
    );
    const workerContext = yield* Layer.build(workerLayer);
    const cycle = () =>
      Effect.gen(function* settleActualAuthorizationMutation() {
        yield* matchOutboxMessages({ compositionRevision });
        return yield* runOutboxCycle({
          claimOwner: `${intent}:authorization`,
          compositionRevision,
          maxDeliveries: 100,
          registrations: outboxWorkers,
          subscriptions: extractOutboxWorkerSubscriptions(outboxWorkers),
        });
      }).pipe(Effect.provideContext(workerContext));
    // Initial internal authority is a native authorization prerequisite. Customer
    // delegation must never provision these permissions. Business mutations below
    // still pass through their registered Actions.
    const initializeInternalApprovalPermission = Effect.fn('PreproposalNative.internalApprovalPermission')(
      function* initializeInternalApprovalPermission(
        permission: 'counterparty.approval_hierarchy.manage' | 'counterparty.purchase_limit.manage',
      ) {
        const grants = yield* core
          .prepareOwner(
            (transaction) =>
              transaction.invoke(beginGrant, [
                counterparty.counterpartyRef.resourceId,
                principalRef.principalId,
                permission,
                null,
                principalRef.principalId,
                randomUUID(),
                'TEST initial internal approval authorization prerequisite',
                false,
              ]),
            'required',
          )
          .pipe(Effect.provideContext(runtimeContext));
        const [initialGrant] = grants;
        yield* requireProtocol(initialGrant !== undefined, 'initial-approval-grant-prepared');
        if (initialGrant === undefined) {
          return yield* safeFailure('initial-approval-grant-missing');
        }
        const permissionRelation = {
          permission,
          principal: principalRef,
          target: {
            counterpartyId: counterparty.counterpartyRef.resourceId,
            kind: 'counterparty' as const,
            legalEntityId: core.legalEntityId,
            tenantId: core.tenantId,
          },
        };
        const permissionMutation = Context.get(
          yield* Layer.build(BusinessPermissionRelationshipMutationLive.pipe(Layer.provide(ownerConfiguration))),
          BusinessPermissionRelationshipMutation,
        );
        yield* permissionMutation.mutate({ ...permissionRelation, operation: 'grant' });
        yield* Effect.addFinalizer(() =>
          permissionMutation.mutate({ ...permissionRelation, operation: 'revoke' }).pipe(Effect.orDie),
        );
        yield* core
          .prepareOwner(
            (transaction) =>
              transaction.invoke(settleGrant, [initialGrant.grant_id, initialGrant.mutation_id, 'grant', 'ACTIVE']),
            'required',
          )
          .pipe(Effect.provideContext(runtimeContext));
        return yield* Effect.void;
      },
    );
    yield* initializeInternalApprovalPermission('counterparty.purchase_limit.manage');
    const limitCredential = yield* authorize('buyer', contextAudience);
    const purchaseLimit = yield* executeChangeCounterpartyPurchaseLimitWithAuthorization(
      yield* Schema.decodeUnknownEffect(ChangeCounterpartyPurchaseLimitPayloadSchema)({
        change: { _tag: 'SET', policy: { _tag: 'MONETARY_LIMIT', limit: { amount: '50', currency: 'CZK' } } },
        counterpartyRef: counterparty.counterpartyRef,
        expectedRevision: null,
        reason: 'Native purchase requires approval above the genuine fifty CZK owner limit',
      }),
      Redacted.value(limitCredential.authorization),
      `${intent}:purchase-limit`,
      { ...limitCredential.options, idempotencyKey: `${intent}:purchase-limit` },
    );
    if (purchaseLimit.currentPolicy === null) {
      return yield* safeFailure('registered-purchase-limit');
    }
    const bootstrapCredential = yield* authorize(serviceRole, contextAudience);
    const administrator = yield* executeBootstrapCounterpartyAccessAdministratorWithAuthorization(
      {
        counterpartyRef: counterparty.counterpartyRef,
        reason: 'Actual internal owner bootstraps distinct human buyer administration',
        recipient: principalRef,
      },
      Redacted.value(bootstrapCredential.authorization),
      `${intent}:administrator`,
      { ...bootstrapCredential.options, idempotencyKey: `${intent}:administrator` },
    );
    yield* cycle();
    for (const permission of ['counterparty.purchase.prepare', 'counterparty.purchase.submit'] as const) {
      const grantCredential = yield* authorize('buyer', contextAudience);
      yield* executeGrantCounterpartyCommerceAccessWithAuthorization(
        {
          counterpartyRef: counterparty.counterpartyRef,
          permission,
          reason: 'Native registered human buyer authority',
          recipient: principalRef,
          scope: { kind: 'storefront', storefrontKey: storefrontId },
        },
        Redacted.value(grantCredential.authorization),
        `${intent}:${permission}`,
        { ...grantCredential.options, idempotencyKey: `${intent}:${permission}` },
      );
      yield* cycle();
    }
    // Pricing reads the buyer's PriceGroup resolution as its own granted service identity (Counterparty-wide).
    const pricingGrantCredential = yield* authorize('buyer', contextAudience);
    yield* executeGrantCounterpartyCommerceAccessWithAuthorization(
      {
        counterpartyRef: counterparty.counterpartyRef,
        permission: 'counterparty.profile.read',
        reason: 'Native Pricing service identity reads the Counterparty profile',
        recipient: { principalId: identities.pricingIssuer.principalId, tenantId: core.tenantId },
        scope: { kind: 'counterparty' },
      },
      Redacted.value(pricingGrantCredential.authorization),
      `${intent}:pricing-profile-read`,
      { ...pricingGrantCredential.options, idempotencyKey: `${intent}:pricing-profile-read` },
    );
    yield* cycle();
    yield* core
      .grantResourceAccess(profile.profileRef, identities.pricingIssuer.principalId, 'reader')
      .pipe(Effect.mapError(() => safeFailure('pricing-profile-resource-grant')));

    const invokeOwnerConfiguration = Effect.fn('PreproposalNative.ownerConfiguration')(
      function* invokeOwnerConfiguration<Codec extends Schema.Top>(
        owner: string,
        operation: string,
        parameters: Schema.Json,
        result: Codec,
      ) {
        const definition = ownerFor(owner);
        const artifact = yield* buildOwnerExecutable(
          definition.owner,
          'order-finalization-config-bootstrap.fixture.ts',
          artifactRoot,
        );
        const child = yield* openNativeChild({
          args: [artifact],
          environment,
          stage: `registered-config:${owner}:${operation}`,
        });
        const authorization = yield* signBuyer(owner, true, false);
        yield* child.send(
          JSON.stringify({
            authorization: Redacted.value(authorization),
            compositionRevision,
            correlationId: `${intent}:${operation}`,
            databaseName: databaseIdentity.database,
            idempotencyKey: `${intent}:${operation}`,
            operation,
            parameters,
            runtimeConnectionString: owned.connections.runtime.connectionString,
          }),
          'stdin',
          true,
        );
        const receipt = yield* child.read(
          Schema.Struct({ operation: Schema.String, result: Schema.Unknown }),
          'private',
        );
        yield* child.exit;
        return yield* Schema.decodeUnknownEffect(result)(receipt.result);
      },
    );
    // Each owner Action declares a write permission on its own target resource; seed exactly those relations.
    yield* core.grantResourceAccess(
      {
        moduleId: 'commerce.storefront-registry',
        resourceId: storefrontId,
        resourceType: 'commerce.storefront-registry.storefront-application',
      },
      core.manager.principalId,
      'writer',
    );
    yield* core.grantResourceAccess(
      {
        moduleId: 'commerce.market-catalog',
        resourceId: core.legalEntityId,
        resourceType: 'commerce.market-catalog.market-catalog-root',
      },
      core.manager.principalId,
      'writer',
    );
    const registry = yield* invokeOwnerConfiguration(
      registryAudience,
      'REGISTER_STOREFRONT',
      {
        allowedChannels: ['B2B'],
        effectiveInterval: { effectiveFrom: at },
        lifecycle: 'ACTIVE',
        reason: 'Native actual Storefront',
        storefrontAppId: storefrontId,
      },
      Schema.Unknown,
    );
    const market = yield* invokeOwnerConfiguration(
      marketAudience,
      'CREATE_MARKET',
      {
        channels: ['B2B'],
        effectivePeriod: { startsAt: at },
        jurisdictions: [{ code: 'CZ', kind: 'COUNTRY' }],
        lifecycle: 'ACTIVE',
        marketCode: 'NATIVE_PREPROPOSAL',
        marketId: randomUUID(),
        purpose: 'Native genuine Market',
        reason: 'Native genuine Market setup',
        sellingLegalEntityRef: legalEntityRef,
        supportedLocales: ['en'],
      },
      Schema.Struct({
        definitionRevisionRef: Schema.Json,
        marketRef: CoreSearchResourceRefSchema,
      }),
    );
    yield* core.grantResourceAccess(market.marketRef, core.manager.principalId, 'writer');
    const association = yield* invokeOwnerConfiguration(
      marketAudience,
      'ASSOCIATE_STOREFRONT',
      {
        associationId: randomUUID(),
        channel: 'B2B',
        effectivePeriod: { startsAt: at },
        expectedMarketDefinitionRevisionRef: market.definitionRevisionRef,
        marketRef: market.marketRef,
        provenance: { kind: 'CONFIGURATION_ACTION', reference: `${intent}:association` },
        reason: 'Native real Storefront Market association',
        sellingLegalEntityRef: legalEntityRef,
        storefrontRef: { appId: storefrontId, tenantId: core.tenantId },
      },
      Schema.Unknown,
    );
    const populationOperator = yield* authorize('operator', cartAudience);
    const initializedPopulation = yield* executeInitializePopulationAuthorityWithAuthorization(
      {},
      Redacted.value(populationOperator.authorization),
      `${intent}:initialize`,
      { ...populationOperator.options, idempotencyKey: `${intent}:initialize` },
    );
    const catalog = ownerFor(catalogAudience);
    // Catalog reads authorize through named context permissions; seed exactly the three the producer exercises.
    const contextPermissions = yield* makeContextPermissionRelationshipMutationLive().pipe(
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(environment))),
    );
    const catalogReads = [
      { legalEntity: false, permission: 'commerce.catalog.read.variant-history' },
      { legalEntity: true, permission: 'commerce.catalog.read.quantity-preparation' },
    ] as const;
    // Catalog reads Cart's tenant-wide population as the granted service identity behind its Tenant binding.
    yield* contextPermissions.mutate({
      operation: 'grant',
      principal: { principalId: identities.cccReader.principalId, tenantId: core.tenantId },
      target: { moduleId: 'commerce.cart', permission: 'commerce.cart.read.open_selection_population' },
      tenantId: core.tenantId,
    });
    // Pricing validates the Catalog selection as its own granted service identity (Tenant-wide read).
    yield* contextPermissions.mutate({
      operation: 'grant',
      principal: { principalId: identities.pricingIssuer.principalId, tenantId: core.tenantId },
      target: { moduleId: catalogModule, permission: 'commerce.catalog.read.selection-evidence' },
      tenantId: core.tenantId,
    });
    // CCC resolves Purchase Currency support from Pricing as its granted service identity (Tenant-wide read).
    for (const principalId of [identities.cccReader.principalId, identities.pricingIssuer.principalId]) {
      yield* contextPermissions.mutate({
        operation: 'grant',
        principal: { principalId, tenantId: core.tenantId },
        target: { moduleId: 'commerce.pricing', permission: 'pricing.currency_support.read' },
        tenantId: core.tenantId,
      });
    }
    // Pricing validates quantity-basis and purpose equivalence as its granted service identity (LE-scoped reads).
    for (const permission of [
      'commerce.catalog.read.quantity-basis-compatibility',
      'commerce.catalog.read.pricing-purpose-equivalence',
    ] as const) {
      yield* contextPermissions.mutate({
        legalEntityId: core.legalEntityId,
        operation: 'grant',
        principal: { principalId: identities.pricingIssuer.principalId, tenantId: core.tenantId },
        target: { moduleId: catalogModule, permission },
        tenantId: core.tenantId,
      });
    }
    for (const read of catalogReads) {
      // CCC reads the same Catalog facts as its granted service identity during basis preparation.
      for (const principalId of [
        core.manager.principalId,
        identities.cccReader.principalId,
        identities.pricingIssuer.principalId,
      ]) {
        const grant: Parameters<typeof contextPermissions.mutate>[0] = {
          operation: 'grant',
          principal: { principalId, tenantId: core.tenantId },
          target: { moduleId: catalogModule, permission: read.permission },
          tenantId: core.tenantId,
        };
        const scopedGrant = read.legalEntity ? { ...grant, legalEntityId: core.legalEntityId } : grant;
        yield* contextPermissions.mutate(scopedGrant);
      }
    }
    const GrantRequestSchema = Schema.Struct({
      protocol: Schema.Literal(catalogProducerProtocol),
      resources: Schema.Array(
        Schema.Struct({
          moduleId: CoreSearchResourceRefSchema.fields.moduleId,
          resourceId: CoreSearchResourceRefSchema.fields.resourceId,
          resourceType: CoreSearchResourceRefSchema.fields.resourceType,
        }),
      ),
      type: Schema.Literal('grant'),
    });
    const ProducerFrameSchema = Schema.Union([
      GrantRequestSchema,
      CatalogProducedSchema,
      Schema.Struct({
        protocol: Schema.Literal(catalogProducerProtocol),
        stage: Schema.String,
        type: Schema.Literal('failed'),
      }),
    ]);
    // One registered Catalog producer run yields one distinct Product, Variant, and Unit with fresh assertions.
    const produceCatalogSelection = Effect.fn('PreproposalNative.produceCatalogSelection')(
      function* produceCatalogSelection(ordinal: number) {
        const credentials = Object.fromEntries(
          yield* Effect.forEach(
            [
              'createProduct',
              'variantCreatedHistory',
              'createAttributeDefinition',
              'createProductType',
              'setProductType',
              'governApplicability',
              'setVariantOverride',
              'governAxes',
              'governAllowedValues',
              'confirmCombination',
              'createUnit',
              'localizedFacts',
              'activateProduct',
              'variantActivatedHistory',
              'setDivisibility',
              'createCategory',
              'assignCategory',
              'publishConfigurationCurrent',
              'publishConfigurationSuccessor',
              'pricingQuantityPreparation',
              'quantityPreparation',
            ],
            (step) =>
              signBuyer(
                catalogAudience,
                // Only reads whose registration requires a Legal Entity carry one; history and evidence forbid it.
                ['pricingQuantityPreparation', 'quantityPreparation'].includes(step),
                false,
              ).pipe(Effect.map((credential) => [step, Redacted.value(credential)])),
          ),
        );
        const stage = `catalog-registered-producer:${ordinal}`;
        const catalogProducer = yield* openNativeChild({
          args: [catalog.artifact, '--produce-preproposal-basis'],
          environment,
          stage,
        });
        yield* catalogProducer.send(
          JSON.stringify({
            baseUrl: `${catalog.origin}/catalog-api`,
            compositionRevision,
            credentials,
            // Empty open-selection population: the exact token the Catalog reads back from the Cart owner.
            impactBasis: `cart:v1:${core.tenantId}:${initializedPopulation.generation}:${createHash('sha256').update('[]').digest('hex')}`,
            protocol: catalogProducerProtocol,
            runKey: randomUUID(),
            tenantId: core.tenantId,
            unitId: randomUUID(),
          }),
          'private',
          false,
        );
        let product = yield* catalogProducer.read(ProducerFrameSchema, 'private');
        while (product.type === 'grant') {
          for (const resource of product.resources) {
            yield* core.grantResourceAccess(resource, core.manager.principalId, 'reader');
            yield* core.grantResourceAccess(resource, core.manager.principalId, 'writer');
            // CCC's granted service identity reads the same Catalog resources during basis preparation.
            yield* core.grantResourceAccess(resource, identities.cccReader.principalId, 'reader');
            // Pricing's granted service identity validates quantity/size facts against the same Catalog resources.
            yield* core.grantResourceAccess(resource, identities.pricingIssuer.principalId, 'reader');
          }
          yield* catalogProducer.send('ack-grant-v1', 'private', false);
          product = yield* catalogProducer.read(ProducerFrameSchema, 'private');
        }
        if (product.type === 'failed') {
          return yield* safeFailure(`${stage}:${product.stage}`);
        }
        yield* catalogProducer.exit;
        const quantity = yield* Schema.decodeUnknownEffect(CatalogQuantityHandoffSchema)(product.quantity);
        yield* requireProtocol(
          quantity.status === 'READY' && product.pricingQuantity.status === 'READY',
          'actual-catalog-purchase-and-pricing-quantity-ready',
        );
        return product;
      },
    );
    // Two distinct Catalog selections: CCC must authenticate to Catalog once per Cart entry.
    const products = [yield* produceCatalogSelection(1), yield* produceCatalogSelection(2)] as const;
    yield* requireProtocol(
      products[0].selection.variantRef.resourceId !== products[1].selection.variantRef.resourceId &&
        products[0].selection.productRef.resourceId !== products[1].selection.productRef.resourceId,
      'distinct-actual-catalog-selections',
    );
    const cart = yield* createRegisteredPreproposalCart({
      // The Cart owner issues no creator grant; seed the buyer's write and the service identity's read.
      entries: products.map((product) => ({
        kind: 'ADD' as const,
        quantity: { amount: '1', unitRef: product.unitRef },
        selection: product.selection,
      })),
      intent,
      onCreated: (cartRef) =>
        Effect.gen(function* grantCartAccess() {
          yield* core.grantResourceAccess(cartRef, core.manager.principalId, 'reader');
          yield* core.grantResourceAccess(cartRef, core.manager.principalId, 'writer');
          yield* core.grantResourceAccess(cartRef, identities.cccReader.principalId, 'reader');
          yield* core.grantResourceAccess(cartRef, identities.pricingIssuer.principalId, 'reader');
        }).pipe(Effect.mapError(() => safeFailure('cart-resource-grants'))),
      population: initializedPopulation,
      transport,
    });

    const pricingArtifact = yield* buildOwnerExecutable(
      pricingOwner,
      'preproposal-basis-producer.fixture.ts',
      artifactRoot,
    );
    const invokePricingSetup = Effect.fn('PreproposalNative.pricingSetup')(function* invokePricingSetup<
      Codec extends Schema.Top,
    >(operation: string, payload: Schema.Json, result: Codec, key: string = operation) {
      const child = yield* openNativeChild({
        args: [pricingArtifact, '--execute-preproposal-basis'],
        environment,
        stage: `pricing-setup:${key}`,
      });
      yield* child.send(
        JSON.stringify({
          // Supported-currency governance is Tenant-wide; its registration forbids a Legal Entity.
          authorization: Redacted.value(
            yield* signBuyer(pricingAudience, operation !== 'SET_SUPPORTED_CURRENCIES', false),
          ),
          baseUrl: `${ownerFor(pricingAudience).origin}/pricing-api`,
          compositionRevision,
          correlationId: `${intent}:${key}`,
          idempotencyKey: `${intent}:${key}`,
          operation,
          payload,
          protocol: 'ontos.pricing.preproposal-basis.producer.v1',
        }),
        'stdin',
        true,
      );
      const receipt = yield* child.read(
        Schema.Struct({
          operation: Schema.Literal(operation),
          protocol: Schema.Literal('ontos.pricing.preproposal-basis.producer.v1'),
          result: Schema.Unknown,
        }),
        'private',
      );
      yield* child.exit;
      return yield* Schema.decodeUnknownEffect(result)(receipt.result);
    });
    const currencies = yield* invokePricingSetup(
      'SET_SUPPORTED_CURRENCIES',
      {
        expectedState: { state: 'ABSENT' },
        intendedEffectivePeriod: { effectiveFrom: at, effectiveTo: null },
        intent: 'ESTABLISH_CURRENT',
        reason: 'Actual Pricing currency support for native proposal',
        schemaVersion: '2',
        supportedCurrencies: ['CZK'],
      },
      SetSupportedCurrenciesV2ResultSchema,
    );
    // Each distinct Catalog selection carries its own exact operator Price.
    const definePrice = Effect.fn('PreproposalNative.definePrice')(function* definePrice(
      product: (typeof products)[number],
      amount: string,
      ordinal: number,
    ) {
      const priceIdentityKey = {
        catalogSelection: product.selection,
        commercialScope: {
          channelId: 'B2B',
          marketId: market.marketRef.resourceId,
          sellingLegalEntityId: core.legalEntityId,
        },
        currencyCode: 'CZK',
        priceGroupSelector: { kind: 'NO_GROUP' },
        unitBasis: { quantity: '1', unitRef: product.unitRef },
      } as const;
      // No registered Action writes Pricing's Price Source Authority registry; the closed Pricing process stores it.
      yield* invokePricingSetup(
        'STORE_PRICE_AUTHORITY',
        {
          grant: {
            authority: {
              sourceAuthorityRef: `${intent}:operator-price-authority:${ordinal}`,
              sourceAuthorityVersion: '1',
            },
            effectivePeriod: { effectiveFrom: DateTime.formatIso(DateTime.subtract(now, { days: 1 })) },
            exactIdentityKey: priceIdentityKey,
            family: 'PRICE',
            mapping: { mappingContractRef: `${intent}:price-mapping`, mappingContractVersion: '1' },
            ownerModuleId: pricingModule,
            schemaVersion: '1',
            verificationRef: `${intent}:operator-price-authority-proof:${ordinal}`,
            verifiedAt: DateTime.formatIso(DateTime.subtract(now, { hours: 1 })),
          },
          legalEntityId: core.legalEntityId,
          principalId: core.manager.principalId,
          tenantId: core.tenantId,
        },
        Schema.Struct({ outcome: Schema.String }),
        `STORE_PRICE_AUTHORITY:${ordinal}`,
      );
      const price = yield* invokePricingSetup(
        'DEFINE_PRICE',
        {
          effectiveFrom: at,
          identityKey: priceIdentityKey,
          monetaryAmount: { amount, currencyCode: 'CZK' },
          priceRef: {
            moduleId: pricingModule,
            resourceId: randomUUID(),
            resourceType: 'commerce.pricing.price',
            tenantId: core.tenantId,
          },
          reason: 'Operator defines an actual pre-Tax native test Price',
          sourceAssertion: {
            lineage: { kind: 'INITIAL' },
            mapping: { mappingContractRef: `${intent}:price-mapping`, mappingContractVersion: '1' },
            originalAssertion: {
              monetaryAmount: { amount, currencyCode: 'CZK' },
              monetaryBoundary: 'PRE_TAX',
              unitBasis: { quantity: '1', unitRef: product.unitRef },
            },
            sourceAssertionId: randomUUID(),
            sourceAuthority: {
              sourceAuthorityRef: `${intent}:operator-price-authority:${ordinal}`,
              sourceAuthorityVersion: '1',
            },
            sourceRecord: {
              sourceChangeCorrelation: `${intent}:price:${ordinal}`,
              sourceRecordRef: `${intent}:price-record:${ordinal}`,
              sourceRecordVersion: '1',
              sourceSystem: { ownerModuleId: pricingModule, sourceSystemRef: `${intent}:manual-price-setup` },
            },
            timing: { importedAt: at, ownerBusinessEffectiveAt: at, sourceEffectiveAt: at },
          },
        },
        PriceSourceAssertionAssessmentSchema,
        `DEFINE_PRICE:${ordinal}`,
      );
      yield* requireProtocol(
        price.outcome === 'PRICE_SOURCE_ASSERTION_CANONICAL_ACCEPTED',
        'registered-price-canonical-accepted',
      );
      return price;
    });
    const prices = [yield* definePrice(products[0], '100', 1), yield* definePrice(products[1], '250', 2)] as const;
    const { entries } = cart.observed.cart;
    const sameSelection = Schema.toEquivalence(CatalogSelectionSchema);
    yield* requireProtocol(
      entries.length === products.length &&
        entries.every((entry, index) => {
          const product = products[index];
          return product !== undefined && sameSelection(entry.selection, product.selection);
        }),
      'actual-cart-entries-in-catalog-order',
    );
    // All monetary fields below are untrusted proposal claims. Only the actual retained Pricing
    // quotation may establish purchaseValue; these claims are never assertions of money truth.
    const zero = { amount: '0', currency: 'CZK' };
    const proposalInput = {
      // The registered monetary policy requires approval for the actual Pricing total.
      approvalEvaluation: 'APPROVAL_REQUIRED',
      approvalTrigger: {
        policyRevision: String(purchaseLimit.currentPolicy.revision),
        reasonCode: 'PURCHASE_LIMIT_EXCEEDED',
        source: 'PURCHASE_LIMIT',
      },
      canonicalHash: '0'.repeat(64),
      canonicalizationVersion: 'purchase-proposal.v1',
      context: {
        channelId: 'B2B',
        evaluatedAt: at,
        locale: 'en',
        marketId: market.marketRef.resourceId,
        sellingLegalEntityId: core.legalEntityId,
        storefrontId,
        tenantId: core.tenantId,
      },
      createdAt: at,
      currency: 'CZK',
      deliveryDestination: { address: {}, kind: 'DELIVERY', method: 'NATIVE_UNRESOLVED' },
      effectiveLimit: null,
      expiresAt: DateTime.formatIso(DateTime.add(now, { minutes: 10 })),
      hierarchyInputs: {
        counterpartyRef: counterparty.counterpartyRef,
        evaluatedAt: at,
        purchaseValue: zero,
        storefrontId,
      },
      identity: { buyer: principalRef, counterpartyRef: counterparty.counterpartyRef, profileRef: profile.profileRef },
      invoiceRecipient: { address: {}, kind: 'INVOICE', method: 'NATIVE_UNRESOLVED' },
      lines: entries.map((entry) => ({
        configuration: entry.selection,
        discount: zero,
        fees: [],
        lineId: entry.selectionId,
        lineTotal: zero,
        pricingRuleRevision: untrustedCommand,
        productRef: entry.selection.productRef,
        quantity: 1,
        tax: zero,
        unitPrice: zero,
      })),
      payment: 'NONE',
      paymentTerm: {
        code: 'UNRESOLVED',
        definitionRef: products[0].selection.productRef,
        definitionRevision: untrustedCommand,
      },
      policyRefs: [],
      pricingRevision: untrustedCommand,
      proposalRevisionRef: {
        moduleId: contextModule,
        resourceId: randomUUID(),
        resourceType: 'commerce.customer-context.purchase-proposal-revision',
        tenantId: core.tenantId,
      },
      proposalSequence: 1,
      purchaseValue: {
        monetaryAmount: zero,
        roundingRuleRevision: untrustedCommand,
        sourceRef: untrustedCommand,
        sourceRevision: untrustedCommand,
      },
      reservation: 'NONE',
      revision: 1,
      sourceCart: { cartRef: cart.created.cart.cartRef, revision: String(cart.observed.cart.revisionRef.revision) },
      state: 'CURRENT',
      taxRevision: untrustedCommand,
      totals: { discount: zero, fees: [], shipping: zero, subtotal: zero, tax: zero, total: zero },
    };
    const decoded = yield* Schema.decodeUnknownEffect(PurchaseProposalRevisionSchema)(proposalInput);
    const proposal = { ...decoded, canonicalHash: computePurchaseProposalCanonicalHash(decoded) };
    yield* io('bootstrap-receipt', async () => {
      try {
        await writeFile(
          `${configuration.taskRoot}/preproposal-native-bootstrap.json`,
          JSON.stringify(
            {
              administrator,
              association,
              buyerPrincipalId: core.manager.principalId,
              cart: { created: cart.created, initializedPopulation, revised: cart.revised },
              catalog: products,
              catalogProvenance: products.map((product) => product.provenance),
              cccReaderPrincipalId: identities.cccReader.principalId,
              compositionRevision,
              counterparty,
              currencies,
              currencyPolicy,
              database: databaseIdentity,
              market,
              party,
              prices,
              pricingIssuerPrincipalId: identities.pricingIssuer.principalId,
              profile,
              protocol: 'ontos.preproposal.native.v1',
              registry,
              sourceBootstrapReceiptSha256,
              status: 'REGISTERED_SETUP_COMPLETED',
            },
            null,
            2,
          ),
          { flag: 'w', mode: 0o600 },
        );
      } catch (error) {
        process.stderr.write(`bootstrap-receipt-error: ${String(error).replaceAll(/\/[^\s]*\//gu, '<path>/')}\n`);
        throw error;
      }
    });
    return {
      approveProposal: (proof: Effect.Success<ReturnType<typeof runRegisteredPreproposalBasisChain>>) =>
        Effect.gen(function* approveActualRetainedProposal() {
          const retained = proof.created.proposal;
          yield* initializeInternalApprovalPermission('counterparty.approval_hierarchy.manage');
          // The human approver receives the genuinely delegable authority through
          // the registered Action and its actual authorization worker.
          for (const permission of ['counterparty.approval.decide'] as const) {
            const credential = yield* authorize('buyer', contextAudience);
            const key = `${intent}:${permission}`;
            yield* executeGrantCounterpartyCommerceAccessWithAuthorization(
              {
                counterpartyRef: counterparty.counterpartyRef,
                permission,
                reason: 'Native registered approval authority for the genuine retained proposal',
                recipient: principalRef,
                scope: { kind: 'counterparty' },
              },
              Redacted.value(credential.authorization),
              key,
              { ...credential.options, idempotencyKey: key },
            );
            yield* cycle();
          }
          const hierarchyKey = `${intent}:hierarchy`;
          const hierarchyCommand = yield* Schema.decodeUnknownEffect(CreateApprovalHierarchyPayloadSchema)({
            hierarchy: {
              createdAt: at,
              effectiveFrom: at,
              effectiveTo: null,
              hierarchyRef: {
                moduleId: contextModule,
                resourceId: randomUUID(),
                resourceType: 'commerce.customer-context.approval-hierarchy',
                tenantId: core.tenantId,
              },
              levels: [
                {
                  completionRule: 'ONE_APPROVER',
                  eligiblePrincipals: [principalRef],
                  levelId: 'native-approval',
                  order: 1,
                  scopeConstraints: [],
                },
              ],
              ownerPrincipal: principalRef,
              reason: 'Explicit native self-approval policy for one genuine purchase',
              revision: 1,
              selector: {
                counterpartyRef: retained.identity.counterpartyRef,
                maximumPurchaseValue: null,
                minimumPurchaseValue: { amount: '0', currency: retained.currency },
                storefrontId,
              },
              selfApprovalPolicy: 'ALLOW',
              state: 'ACTIVE',
            },
            idempotencyKey: hierarchyKey,
          });
          const hierarchyCredential = yield* authorize('buyer', contextAudience);
          const hierarchy = yield* executeCreateApprovalHierarchyWithAuthorization(
            hierarchyCommand,
            Redacted.value(hierarchyCredential.authorization),
            hierarchyKey,
            { ...hierarchyCredential.options, idempotencyKey: hierarchyKey },
          );
          const submitKey = `${intent}:submit`;
          const submissionCredential = yield* authorize('buyer', contextAudience);
          const submitted = yield* executeSubmitPurchaseApprovalRequestWithAuthorization(
            {
              counterpartyRef: retained.identity.counterpartyRef,
              idempotencyKey: submitKey,
              proposalRevision: retained.revision,
              proposalRevisionRef: retained.proposalRevisionRef,
              requestExpiresAt: retained.expiresAt,
              storefrontId,
            },
            Redacted.value(submissionCredential.authorization),
            submitKey,
            { ...submissionCredential.options, idempotencyKey: submitKey },
          );
          const decisionKey = `${intent}:approve`;
          const decisionCredential = yield* authorize('buyer', contextAudience);
          const approved = yield* executeDecidePurchaseApprovalRequestWithAuthorization(
            {
              counterpartyRef: retained.identity.counterpartyRef,
              decidedAt: yield* DateTime.now,
              decision: 'APPROVE',
              expectedRequestRevision: submitted.request.requestRevision,
              idempotencyKey: decisionKey,
              proposalRevisionRef: retained.proposalRevisionRef,
              reason: null,
              requestRef: submitted.request.requestRef,
              storefrontId,
            },
            Redacted.value(decisionCredential.authorization),
            decisionKey,
            { ...decisionCredential.options, idempotencyKey: decisionKey },
          );
          yield* requireProtocol(
            submitted.outcome === 'SUBMITTED' && approved.request.status === 'APPROVED',
            'registered-genuine-proposal-approved',
          );
          yield* io(
            'approval-owner-operations-receipt',
            async () =>
              await writeFile(
                `${configuration.taskRoot}/preproposal-native-approval-operations.json`,
                JSON.stringify({
                  approved,
                  database: databaseIdentity,
                  hierarchy,
                  proposal: proof.created,
                  sourceBootstrapReceiptSha256,
                  status: 'OWNER_OPERATIONS_COMPLETED',
                  submitted,
                }),
                { flag: 'wx', mode: 0o600 },
              ),
          );
          return { approved, hierarchy, submitted };
        }),
      cart,
      catalogSelections: products.map((product) => product.selection),
      intent,
      proposal,
      recordProof: (proof: Effect.Success<ReturnType<typeof runRegisteredPreproposalBasisChain>>) =>
        io(
          'proof-receipt',
          async () =>
            await writeFile(
              `${configuration.taskRoot}/preproposal-native-outcome.json`,
              JSON.stringify(
                {
                  assertions: {
                    changedIssuanceRejectedWithoutHistoryMutation: proof.wrongIssuanceRejected,
                    distinctBuyerAndIssuer: true,
                    genuineCatalogQuantity: true,
                    genuineRegisteredCart: true,
                    genuineRegisteredCartRevision: true,
                    genuineRegisteredPricing: true,
                    originalInvocationRetained: true,
                    preparedReadyCurrentBinding: true,
                    priorInvocationHistoryUnchanged: true,
                  },
                  basisRef: proof.prepared.basisRef,
                  boundary: 'native business chain under TEST gateway authentication',
                  buyerPrincipalId: core.manager.principalId,
                  cccReaderPrincipalId: identities.cccReader.principalId,
                  compositionRevision,
                  created: proof.created,
                  current: proof.current,
                  database: databaseIdentity,
                  executedTestCount: 1,
                  preparationInvocationId: proof.prepared.preparationInvocationId,
                  prepared: proof.prepared,
                  pricingCandidateRef: proof.pricingInput.pricingCandidateRef,
                  pricingIssuanceInvocationId: proof.invocation.actionInvocationId,
                  pricingIssuerPrincipalId: identities.pricingIssuer.principalId,
                  protocol: 'ontos.preproposal.native.v1',
                  ready: proof.ready,
                  selectedCase:
                    'produces an exact preproposal basis through registered owners and retains its original Pricing issuance',
                  sourceBootstrapReceiptSha256,
                  sourceRef: proof.prepared.proposal.proposalRevisionRef.resourceId,
                  status: 'ASSERTIONS_COMPLETED',
                  wrongIssuanceRejection: proof.wrongIssuanceRejection,
                },
                null,
                2,
              ),
              { flag: 'w', mode: 0o600 },
            ),
        ),
      transport,
      verifyStoredProposal: (proof: Effect.Success<ReturnType<typeof runRegisteredPreproposalBasisChain>>) =>
        core
          .prepareOwner(
            (transaction) =>
              Effect.gen(function* readActualStoredProposal() {
                // The runtime role reads proposals only through the owner's scoped routine, never table SELECT.
                const rows = yield* transaction.invoke(readCurrentPurchaseProposalRoutine, [
                  { proposalRevisionResourceId: proof.created.proposal.proposalRevisionRef.resourceId },
                ]);
                const [row] = rows;
                if (rows.length !== 1 || row === undefined) {
                  return yield* safeFailure('exact-stored-created-proposal');
                }
                const { proposal: storedSnapshot } = yield* Schema.decodeUnknownEffect(
                  Schema.Struct({ proposal: Schema.Json }),
                )(row.result);
                const stored = yield* Schema.decodeUnknownEffect(PurchaseProposalRevisionSchema)(storedSnapshot);
                yield* requireProtocol(
                  proof.created.outcome === 'CREATED' &&
                    stored.identity.buyer.principalId === core.manager.principalId &&
                    stored.canonicalHash === proof.created.proposal.canonicalHash &&
                    stored.state === 'CURRENT' &&
                    Schema.toEquivalence(PurchaseProposalRevisionSchema)(stored, proof.created.proposal),
                  'stored-owner-proposal-equals-original-created-result',
                );
                return {
                  buyerPrincipalId: stored.identity.buyer.principalId,
                  canonicalHash: stored.canonicalHash,
                  proposalRevisionResourceId: stored.proposalRevisionRef.resourceId,
                  revision: stored.revision,
                };
              }),
            'required',
          )
          .pipe(Effect.provideContext(runtimeContext)),
    };
  },
);
