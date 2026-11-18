/**
 * Type-level proof of the SDK kernel contract. Compiled by the package typecheck, never executed and
 * never registered: `defineRead` is declared with the two signatures the read adapter adds.
 *
 * Core-runtime cannot import vertical packages (a composite project, and they depend on it), so the
 * provider and owner schemas below mirror the real contracts where the logic reads them. Sources:
 *   - customer-market-retirement-contracts/src/apis/market-subject-restrictions-current.ts
 *   - commerce-market-catalog/shared/apis/verify-market-eligibility-v1.ts, src/api/verify-market-eligibility-v1.read.ts
 *   - shared-contracts/src/owner-verifiable-set-completeness.ts
 *   - price-group-catalog-contracts/src/apis/validate-price-group-compatibility.ts, src/domain/price-group.ts
 *   - commerce-customer-context/src/api/customer-price-group-resolution.read.ts
 *
 * (a) market eligibility verification: a call before the transaction, then one READ ONLY transaction.
 * (b) customer price-group resolution: a transaction, a data-dependent fan-out of calls, a recheck.
 * (c) current pricing: a data-dependent loop of calls and transactions, then a final fence.
 * (d) a read that only needs extra access questions and stays one transaction.
 * (e) an Action and a worker delivery on the same neutral capabilities with another execution identity.
 */
import { Effect, Match, Option, Result, Schema } from 'effect';
import type { DateTime } from 'effect';

import type { ListAccessPredicate } from '../../src/access/decision/list-access.ts';
import { TenantIdSchema } from '../../src/auth/external-identity-contracts.ts';
import { defineTenantModuleEntrypoint } from '../../src/modules/module-entrypoint.ts';
import type { OperationalScope } from '../../src/operations/context.ts';
import type { ReadServiceFactory } from '../../src/reads/definition.ts';
import { ReadHandlerNotFound } from '../../src/reads/read-handler-not-found.ts';
import { ReadHandlerUnavailable } from '../../src/reads/read-handler-unavailable.ts';
import { ReadPermissionDenied } from '../../src/reads/read-permission-denied.ts';
import {
  IdempotencyKeySchema,
  callAnswer,
  coreOperations,
  declaredCall,
  declaredWriteCall,
  isUnexpired,
  moduleOperation,
} from '../../src/sdk/index.ts';
import type {
  CallOutcome,
  DeclaredCalls,
  ExecutionCapabilities,
  OperationOutput,
  TransactionAborted,
  WriteCallOutcome,
} from '../../src/sdk/index.ts';
import { canList, canRun, canSeeFields, readAnswer } from '../../src/sdk/read.ts';
import type {
  AccessQuestionTarget,
  DefineReadSdkForms,
  NoAccessQuestions,
  ReadRunContext,
} from '../../src/sdk/read.ts';

declare const defineRead: DefineReadSdkForms;

const READ = 'read';
const RUN = 'run';
const API = 'api';
const DETAIL = 'detail';
const SCHEMA_VERSION = '1';
const METADATA_ONLY = 'metadata_only';
const CUSTOMER_CONTEXT = 'commerce.customer-context';
const MARKET_CATALOG = 'commerce.market-catalog';
const PRICE_GROUP_RESOLUTION = 'commerce.customer-context.api.customer-price-group-resolution';

/* ================================================================================================ */
/* Shared mirrors                                                                                   */
/* ================================================================================================ */

const ProofIdSchema = Schema.NonEmptyString.pipe(Schema.brand('ProofId'));
const OwnerReferenceSchema = Schema.NonEmptyString.pipe(Schema.brand('OwnerReference'));

const CompletenessScopeSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('EXACT_PREDICATE'), predicateRef: OwnerReferenceSchema }),
  Schema.Struct({
    declaredScopeRef: OwnerReferenceSchema,
    kind: Schema.Literal('SAFELY_BROADER_SCOPE'),
    predicateRef: OwnerReferenceSchema,
  }),
]);
const CompletenessEvidenceSchema = Schema.Struct({
  nextApplicabilityBoundary: Schema.optionalKey(Schema.DateTimeUtcFromString),
  observedAt: Schema.DateTimeUtcFromString,
  ownerRevision: OwnerReferenceSchema,
  scope: CompletenessScopeSchema,
});
type CompletenessEvidence = typeof CompletenessEvidenceSchema.Type;

const TenantResourceSchema = Schema.Struct({ resourceId: ProofIdSchema, tenantId: TenantIdSchema });

const unavailable = (reason: string) => new ReadHandlerUnavailable({ code: 'read_handler_unavailable', reason });

/* ================================================================================================ */
/* (a) commerce.market-catalog.api.verify-market-eligibility-v1                                     */
/* ================================================================================================ */

const RestrictionSubjectSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('RETAIL_PROFILE'), profileRef: TenantResourceSchema }),
  Schema.Struct({
    counterpartyRef: TenantResourceSchema,
    kind: Schema.Literal('COUNTERPARTY'),
    profileRef: TenantResourceSchema,
  }),
]);
const MarketSubjectRestrictionsCurrentResponseSchema = Schema.Union([
  Schema.Struct({
    channelConstraint: Schema.Struct({ allowedChannels: Schema.Array(Schema.Literals(['B2C', 'B2B'])) }),
    completenessEvidence: CompletenessEvidenceSchema,
    decision: Schema.Literals(['ALLOWED', 'DENIED']),
    marketConstraint: Schema.Union([
      Schema.Struct({ kind: Schema.Literal('ANY_MARKET') }),
      Schema.Struct({ kind: Schema.Literal('ALLOWED_MARKETS'), marketRefs: Schema.Array(TenantResourceSchema) }),
    ]),
    outcome: Schema.Literal('SUBJECT_RESTRICTIONS_CURRENT'),
    ownerRevision: OwnerReferenceSchema,
    sellerConstraint: Schema.Union([
      Schema.Struct({ kind: Schema.Literal('FIXED_SELLER'), sellerRef: TenantResourceSchema }),
      Schema.Struct({ kind: Schema.Literal('ALLOWED_SELLERS'), sellerRefs: Schema.Array(TenantResourceSchema) }),
    ]),
  }),
  Schema.Struct({
    outcome: Schema.Literals(['SUBJECT_RESTRICTIONS_UNAVAILABLE', 'SUBJECT_RESTRICTIONS_UNVERIFIABLE']),
    reason: Schema.String,
    retryable: Schema.Boolean,
  }),
]);

/** What `@app/customer-market-retirement-contracts/market-subject-restrictions-current` will export. */
export const marketSubjectRestrictionsCurrentOperation = moduleOperation({
  kind: READ,
  path: '/reads/market-subject-restrictions-current',
  provider: {
    entrypointKey: 'commerce.customer-context.api.market-subject-restrictions-current',
    moduleId: CUSTOMER_CONTEXT,
    schemaVersion: SCHEMA_VERSION,
  },
  request: Schema.Struct({ subject: RestrictionSubjectSchema }),
  response: MarketSubjectRestrictionsCurrentResponseSchema,
});

const EligibleMarketTuplesRequestSchema = Schema.Struct({
  sellingLegalEntityRestriction: Schema.optionalKey(TenantResourceSchema),
  storefrontRef: Schema.Struct({ appId: ProofIdSchema, tenantId: TenantIdSchema }),
  subject: Schema.optionalKey(
    Schema.Union([Schema.Struct({ kind: Schema.Literal('GUEST') }), RestrictionSubjectSchema]),
  ),
});
type EligibleMarketTuplesRequest = typeof EligibleMarketTuplesRequestSchema.Type;
const VerifyMarketEligibilityV1RequestSchema = Schema.Struct({
  observedProof: CompletenessEvidenceSchema,
  originalRequest: EligibleMarketTuplesRequestSchema,
});
type VerifyMarketEligibilityV1Request = typeof VerifyMarketEligibilityV1RequestSchema.Type;
const VerifyMarketEligibilityV1ResponseSchema = Schema.Union([
  Schema.Struct({ currentProof: CompletenessEvidenceSchema, state: Schema.Literal('CURRENT') }),
  Schema.Struct({ state: Schema.Literal('STALE') }),
  Schema.Struct({ reason: Schema.String, retryable: Schema.Literal(true), state: Schema.Literal('UNAVAILABLE') }),
]);
type VerifyResponse = typeof VerifyMarketEligibilityV1ResponseSchema.Type;

interface MarketSubjectRestrictionSnapshot {
  readonly allowedChannels: readonly ('B2B' | 'B2C')[];
  readonly allowedMarkets: Option.Option<readonly string[]>;
  readonly allowedSellers: readonly string[];
  readonly decision: 'ALLOWED' | 'DENIED';
  readonly ownerRevision: string;
}
interface MarketResolutionPersistence {
  readonly load: (
    input: EligibleMarketTuplesRequest,
    subjectRestrictions: Option.Option<MarketSubjectRestrictionSnapshot>,
  ) => Effect.Effect<{ readonly completenessEvidence: CompletenessEvidence }, ReadHandlerUnavailable>;
}
/** The service factory builds only the module's own persistence: no Crypto, no reader, no gateway. */
declare const marketResolutionServices: ReadServiceFactory<MarketResolutionPersistence>;

type CurrentRestrictions = Extract<
  OperationOutput<typeof marketSubjectRestrictionsCurrentOperation>,
  { readonly outcome: 'SUBJECT_RESTRICTIONS_CURRENT' }
>;
const toSnapshot = (response: CurrentRestrictions): MarketSubjectRestrictionSnapshot => ({
  allowedChannels: response.channelConstraint.allowedChannels,
  allowedMarkets:
    response.marketConstraint.kind === 'ALLOWED_MARKETS'
      ? Option.some(response.marketConstraint.marketRefs.map(({ resourceId }) => resourceId))
      : Option.none(),
  allowedSellers:
    response.sellerConstraint.kind === 'FIXED_SELLER'
      ? [response.sellerConstraint.sellerRef.resourceId]
      : response.sellerConstraint.sellerRefs.map(({ resourceId }) => resourceId),
  decision: response.decision,
  ownerRevision: response.ownerRevision,
});

/** The provider's answer, as data: only a current restriction set is usable. */
const currentRestrictions = (
  answer: CallOutcome<OperationOutput<typeof marketSubjectRestrictionsCurrentOperation>>,
): Option.Option<MarketSubjectRestrictionSnapshot> =>
  Option.flatMap(callAnswer(answer), (value) =>
    value.outcome === 'SUBJECT_RESTRICTIONS_CURRENT' ? Option.some(toSnapshot(value)) : Option.none(),
  );

const isOutsideTrustedScope = (input: VerifyMarketEligibilityV1Request, scope: OperationalScope): boolean => {
  const request = input.originalRequest;
  return (
    request.storefrontRef.tenantId !== scope.tenantId ||
    scope.trustedStorefrontId === undefined ||
    request.storefrontRef.appId !== scope.trustedStorefrontId ||
    (request.sellingLegalEntityRestriction !== undefined &&
      request.sellingLegalEntityRestriction.tenantId !== scope.tenantId) ||
    (request.subject !== undefined &&
      request.subject.kind !== 'GUEST' &&
      request.subject.profileRef.tenantId !== scope.tenantId)
  );
};

const marketUnavailable = (): VerifyResponse => ({
  reason: 'Current Commerce Market eligibility could not be established',
  retryable: true,
  state: 'UNAVAILABLE',
});

/** A proof stays current while the transaction time is strictly before its next boundary. */
const proofIsCurrent = (observed: CompletenessEvidence, current: CompletenessEvidence, operationAt: DateTime.Utc) =>
  isUnexpired(operationAt, observed.nextApplicabilityBoundary) &&
  observed.ownerRevision === current.ownerRevision &&
  observed.scope.kind === current.scope.kind &&
  observed.scope.predicateRef === current.scope.predicateRef &&
  (observed.scope.kind !== 'SAFELY_BROADER_SCOPE' ||
    (current.scope.kind === 'SAFELY_BROADER_SCOPE' &&
      observed.scope.declaredScopeRef === current.scope.declaredScopeRef));

const verifyMarketEligibilityCalls = {
  subjectRestrictions: declaredCall(
    marketSubjectRestrictionsCurrentOperation,
    'commerce.market-catalog.requirement.verify-market-eligibility-v1-subject',
  ),
} as const;

export const runVerifyMarketEligibilityV1 = Effect.fn('VerifyMarketEligibilityV1Read.run')(function* run(
  input: VerifyMarketEligibilityV1Request,
  context: ReadRunContext<MarketResolutionPersistence, typeof verifyMarketEligibilityCalls, NoAccessQuestions>,
) {
  if (isOutsideTrustedScope(input, context.scope)) {
    return yield* new ReadPermissionDenied({
      code: 'read_permission_denied',
      reason: 'The request is outside the trusted operational context',
    });
  }
  const { subject } = input.originalRequest;
  // 1. The other module's answer, before any transaction: no connection is held meanwhile.
  let restrictions = Option.none<MarketSubjectRestrictionSnapshot>();
  if (subject !== undefined && subject.kind !== 'GUEST') {
    restrictions = currentRestrictions(yield* context.call('subjectRestrictions', { subject }));
    if (Option.isNone(restrictions)) {
      return readAnswer(marketUnavailable(), { resultCount: 1 });
    }
  }
  // 2. One READ ONLY owner transaction; its clock is the trusted "now" of the proof check.
  const verdict = yield* context.transaction((services, facts) =>
    services.load(input.originalRequest, restrictions).pipe(
      Effect.map((snapshot): VerifyResponse =>
        proofIsCurrent(input.observedProof, snapshot.completenessEvidence, facts.operationAt)
          ? { currentProof: snapshot.completenessEvidence, state: 'CURRENT' }
          : { state: 'STALE' },
      ),
      Effect.orElseSucceed(marketUnavailable),
    ),
  );
  // 3. Core validates the result, writes the read's and the call's evidence, projects, releases.
  return readAnswer(verdict, { resultCount: 1 });
});

export const verifyMarketEligibilityV1Read = defineRead(
  {
    accessDeclaration: {
      key: 'commerce.market-catalog.market-eligibility.verify',
      kind: READ,
      modes: [RUN],
      placement: { group: 'markets', level: 'basic' },
      risk: 'routine',
      selectors: [],
    },
    accessKind: DETAIL,
    calls: verifyMarketEligibilityCalls,
    entrypoint: defineTenantModuleEntrypoint({
      access: READ,
      authorization: { kind: 'protected' },
      entrypointKey: 'commerce.market-catalog.api.verify-market-eligibility-v1',
      moduleKey: MARKET_CATALOG,
      role: API,
    }),
    evidencePolicy: {
      captureMode: METADATA_ONLY,
      policyKey: 'commerce.market-catalog.api.verify-market-eligibility-v1.evidence.v1',
    },
    inputSchema: VerifyMarketEligibilityV1RequestSchema,
    legalEntityScope: 'optional',
    owningModuleKey: MARKET_CATALOG,
    policies: [],
    readKey: 'commerce.market-catalog.api.verify-market-eligibility-v1',
    resultSchema: VerifyMarketEligibilityV1ResponseSchema,
    schemaVersion: SCHEMA_VERSION,
  },
  { run: runVerifyMarketEligibilityV1 },
  marketResolutionServices,
);

/* ================================================================================================ */
/* (b) commerce.customer-context.api.customer-price-group-resolution                                */
/* ================================================================================================ */

const PriceGroupRefSchema = Schema.Struct({
  moduleId: Schema.Literal('pricing.price-group-catalog'),
  resourceId: ProofIdSchema,
  tenantId: TenantIdSchema,
});
type PriceGroupRef = typeof PriceGroupRefSchema.Type;
const CompatibilityEvidenceSchema = Schema.Struct({
  catalogRevision: OwnerReferenceSchema,
  definitionRevisionNumber: Schema.Finite,
  meaningFingerprint: OwnerReferenceSchema,
  priceGroupRef: PriceGroupRefSchema,
  trustedOperationAt: Schema.DateTimeUtcFromString,
});
type CompatibilityEvidence = typeof CompatibilityEvidenceSchema.Type;
const ValidatePriceGroupCompatibilityRequestSchema = Schema.Struct({
  expectedCurrent: Schema.optionalKey(CompatibilityEvidenceSchema),
  priceGroupRef: PriceGroupRefSchema,
  requiredContract: Schema.Struct({ contract: Schema.Literal('commerce.customer-price-group-assignment.v1') }),
  trustedOperationAt: Schema.DateTimeUtcFromString,
});
type ValidatePriceGroupCompatibilityRequest = typeof ValidatePriceGroupCompatibilityRequestSchema.Type;
const UnusableKindSchema = Schema.Literals(['INCOMPATIBLE', 'MISSING', 'RETIRED']);
const PriceGroupCompatibilityDecisionSchema = Schema.Union([
  Schema.Struct({ evidence: CompatibilityEvidenceSchema, kind: Schema.Literal('USABLE') }),
  Schema.Struct({ kind: UnusableKindSchema }),
]);

/** What `@app/price-group-catalog-contracts/validate-price-group-compatibility` will export. */
export const validatePriceGroupCompatibilityOperation = moduleOperation({
  kind: READ,
  path: '/reads/validate-price-group-compatibility',
  provider: {
    entrypointKey: 'pricing.price-group-catalog.api.validate-price-group-compatibility',
    moduleId: 'pricing.price-group-catalog',
    schemaVersion: SCHEMA_VERSION,
  },
  request: ValidatePriceGroupCompatibilityRequestSchema,
  response: PriceGroupCompatibilityDecisionSchema,
});

const ProfileTargetSchema = Schema.Struct({
  kind: Schema.Literals(['COUNTERPARTY_PURCHASING_PROFILE', 'RETAIL_CUSTOMER_PROFILE']),
  resourceId: ProofIdSchema,
  tenantId: TenantIdSchema,
});
type ProfileTarget = typeof ProfileTargetSchema.Type;
const CustomerPriceGroupResolutionRequestSchema = Schema.Struct({
  effectiveAt: Schema.optionalKey(Schema.DateTimeUtcFromString),
  profile: ProfileTargetSchema,
});
type CustomerPriceGroupResolutionRequest = typeof CustomerPriceGroupResolutionRequestSchema.Type;
const PriceGroupResolutionSchema = Schema.Union([
  Schema.TaggedStruct('NONE', {}),
  Schema.TaggedStruct('RESOLVED', { compatibility: CompatibilityEvidenceSchema }),
  Schema.TaggedStruct('UNUSABLE', { reason: UnusableKindSchema }),
  Schema.TaggedStruct('INCONSISTENT', { currentAssignmentCount: Schema.Finite }),
]);
type PriceGroupResolution = typeof PriceGroupResolutionSchema.Type;
const CustomerPriceGroupResolutionResponseSchema = Schema.Struct({
  effectiveAt: Schema.DateTimeUtcFromString,
  generation: OwnerReferenceSchema,
  observedAt: Schema.DateTimeUtcFromString,
  profile: ProfileTargetSchema,
  resolution: PriceGroupResolutionSchema,
});
type CustomerPriceGroupResolutionResponse = typeof CustomerPriceGroupResolutionResponseSchema.Type;

interface CustomerPriceGroupAssignment {
  readonly compatibility: Option.Option<CompatibilityEvidence>;
  readonly priceGroupRef: PriceGroupRef;
}
/** Owner services over the scoped transaction only: profile validation and the assignment store. */
interface CustomerPriceGroupResolutionServices {
  readonly effectiveAt: (requested: DateTime.Utc | undefined) => Effect.Effect<DateTime.Utc, ReadHandlerUnavailable>;
  readonly generationOf: (
    profile: ProfileTarget,
    assignments: readonly CustomerPriceGroupAssignment[],
  ) => CustomerPriceGroupResolutionResponse['generation'];
  /** `None` when the profile does not exist in the trusted tenant. */
  readonly resolve: (
    profile: ProfileTarget,
    effectiveAt: DateTime.Utc,
  ) => Effect.Effect<Option.Option<readonly CustomerPriceGroupAssignment[]>, ReadHandlerUnavailable>;
}
declare const customerPriceGroupResolutionServices: ReadServiceFactory<CustomerPriceGroupResolutionServices>;

const priceGroupCalls = {
  compatibility: declaredCall(
    validatePriceGroupCompatibilityOperation,
    'commerce.customer-context.requirement.price-group-single-assignment',
  ),
} as const;

/** The catalog's answer for one assignment, checked against the exact request as today. */
const resolutionOf = (
  assignment: CustomerPriceGroupAssignment,
  answer: CallOutcome<OperationOutput<typeof validatePriceGroupCompatibilityOperation>>,
): Effect.Effect<PriceGroupResolution, ReadHandlerUnavailable> =>
  Match.valueTags(answer, {
    Forbidden: () => Effect.fail(unavailable('The Price Group Catalog refused this caller')),
    NotFound: () => Effect.fail(unavailable('The Price Group Catalog operation is not installed')),
    Ok: ({ value }) => {
      if (value.kind !== 'USABLE') {
        return Effect.succeed(PriceGroupResolutionSchema.members[2].make({ reason: value.kind }));
      }
      return value.evidence.priceGroupRef.resourceId === assignment.priceGroupRef.resourceId
        ? Effect.succeed(PriceGroupResolutionSchema.members[1].make({ compatibility: value.evidence }))
        : Effect.fail(unavailable('The Price Group Catalog returned mismatched evidence'));
    },
    Rejected: () => Effect.fail(unavailable('The Price Group Catalog rejected the request')),
    Unavailable: () => Effect.fail(unavailable('The Price Group Catalog compatibility decision is unavailable')),
  });

const compatibilityRequest = (
  assignment: CustomerPriceGroupAssignment,
  trustedOperationAt: DateTime.Utc,
): ValidatePriceGroupCompatibilityRequest => {
  const request: ValidatePriceGroupCompatibilityRequest = {
    priceGroupRef: assignment.priceGroupRef,
    requiredContract: { contract: 'commerce.customer-price-group-assignment.v1' },
    trustedOperationAt,
  };
  return Option.match(assignment.compatibility, {
    onNone: () => request,
    onSome: (expectedCurrent) => ({ ...request, expectedCurrent }),
  });
};

const combined = (resolutions: readonly PriceGroupResolution[]): PriceGroupResolution => {
  const [first] = resolutions;
  if (first === undefined) {
    return PriceGroupResolutionSchema.members[0].make({});
  }
  return resolutions.length > 1
    ? PriceGroupResolutionSchema.members[3].make({ currentAssignmentCount: resolutions.length })
    : first;
};

export const runCustomerPriceGroupResolution = Effect.fn('CustomerPriceGroupResolutionRead.run')(function* run(
  input: CustomerPriceGroupResolutionRequest,
  context: ReadRunContext<CustomerPriceGroupResolutionServices, typeof priceGroupCalls, NoAccessQuestions>,
) {
  // 1. Owner snapshot in one READ ONLY transaction.
  const snapshot = yield* context.transaction((services, facts) =>
    Effect.gen(function* snapshotOf() {
      const effectiveAt = yield* services.effectiveAt(input.effectiveAt);
      const assignments = yield* services.resolve(input.profile, effectiveAt);
      return assignments.pipe(
        Option.map((current) => ({
          assignments: current,
          effectiveAt,
          generation: services.generationOf(input.profile, current),
          observedAt: facts.operationAt,
        })),
      );
    }),
  );
  if (Option.isNone(snapshot)) {
    return yield* new ReadHandlerNotFound({
      code: 'read_handler_not_found',
      reason: 'The customer profile does not exist in the trusted Tenant',
    });
  }
  const { assignments, effectiveAt, generation, observedAt } = snapshot.value;
  // 2. Data-dependent fan-out: one catalog call per current assignment, with no transaction open.
  const resolutions = yield* Effect.forEach(
    assignments,
    (assignment) =>
      context
        .call('compatibility', compatibilityRequest(assignment, effectiveAt))
        .pipe(Effect.flatMap((answer) => resolutionOf(assignment, answer))),
    { concurrency: 4 },
  );
  // 3. Currentness: the assignment set the answers were about is still the current one.
  const stillCurrent = yield* context.transaction((services) =>
    services
      .resolve(input.profile, effectiveAt)
      .pipe(
        Effect.map((current) =>
          Option.exists(current, (now) => services.generationOf(input.profile, now) === generation),
        ),
      ),
  );
  if (!stillCurrent) {
    return yield* unavailable('The customer Price Group assignments changed during resolution');
  }
  const result: CustomerPriceGroupResolutionResponse = {
    effectiveAt,
    generation,
    observedAt,
    profile: input.profile,
    resolution: combined(resolutions),
  };
  return readAnswer(result, { resultCount: resolutions.length });
});

export const customerPriceGroupResolutionRead = defineRead(
  {
    accessActor: {
      callers: ['pricing'],
      reason: "Pricing resolves a customer's Price Group for a verified subject during quotation and commitment.",
      subject: 'identity',
    },
    accessDeclaration: {
      key: 'commerce.customer-context.customer-price-group.resolve',
      kind: READ,
      modes: [RUN],
      placement: { group: 'customer-pricing', level: 'extended' },
      risk: 'sensitive',
      selectors: [],
    },
    accessKind: DETAIL,
    calls: priceGroupCalls,
    domainErrorSchema: Schema.Never,
    entrypoint: defineTenantModuleEntrypoint({
      access: READ,
      authorization: { kind: 'protected' },
      entrypointKey: PRICE_GROUP_RESOLUTION,
      moduleKey: CUSTOMER_CONTEXT,
      role: API,
    }),
    evidencePolicy: {
      captureMode: METADATA_ONLY,
      policyKey: 'commerce.customer-context.api.customer-price-group-resolution.evidence.v1',
    },
    inputSchema: CustomerPriceGroupResolutionRequestSchema,
    legalEntityScope: 'required',
    owningModuleKey: CUSTOMER_CONTEXT,
    policies: [],
    readKey: PRICE_GROUP_RESOLUTION,
    resultSchema: CustomerPriceGroupResolutionResponseSchema,
    schemaVersion: SCHEMA_VERSION,
  },
  { run: runCustomerPriceGroupResolution },
  customerPriceGroupResolutionServices,
);

/* ================================================================================================ */
/* (c) pricing current-pricing decision: a data-dependent loop of calls and transactions            */
/* ================================================================================================ */

const OwnerQuestionSchema = Schema.Struct({ line: ProofIdSchema, question: Schema.String });
const OwnerAnswerSchema = Schema.Struct({
  line: ProofIdSchema,
  revision: OwnerReferenceSchema,
  verdict: Schema.String,
});
const ownerOperation = (entrypointKey: string, moduleId: string, path: `/${string}`) =>
  moduleOperation({
    kind: READ,
    path,
    provider: { entrypointKey, moduleId, schemaVersion: SCHEMA_VERSION },
    request: OwnerQuestionSchema,
    response: OwnerAnswerSchema,
  });
const currentPricingCalls = {
  marketFence: declaredCall(
    ownerOperation('commerce.market-catalog.api.pricing-current-market-evidence', MARKET_CATALOG, '/reads/market'),
    'commerce.pricing.requirement.current-pricing-decision-market-final-fence',
  ),
  priceGroup: declaredCall(
    ownerOperation(PRICE_GROUP_RESOLUTION, CUSTOMER_CONTEXT, '/reads/group'),
    'commerce.pricing.requirement.current-pricing-decision-profile-price-group',
  ),
  purchaseContext: declaredCall(
    ownerOperation(
      'commerce.customer-context.api.pricing-purchase-context-verification',
      CUSTOMER_CONTEXT,
      '/reads/ctx',
    ),
    'commerce.pricing.requirement.current-pricing-decision-purchase-context',
  ),
  purposeEquivalence: declaredCall(
    ownerOperation('commerce.catalog.api.pricing-purpose-equivalence', 'commerce.catalog', '/reads/purpose'),
    'commerce.pricing.requirement.current-pricing-decision-purpose-equivalence',
  ),
  quantityBasis: declaredCall(
    ownerOperation('commerce.catalog.api.quantity-basis-compatibility', 'commerce.catalog', '/reads/quantity'),
    'commerce.pricing.requirement.current-pricing-decision-quantity-basis',
  ),
} as const;

interface OwnerNeed {
  readonly owner: 'marketFence' | 'priceGroup' | 'purposeEquivalence' | 'quantityBasis';
  readonly question: typeof OwnerQuestionSchema.Type;
}
interface EvaluationState {
  readonly done: boolean;
  readonly generations: readonly string[];
  readonly needs: readonly OwnerNeed[];
}
interface OwnerAnswer {
  readonly need: OwnerNeed;
  readonly outcome: CallOutcome<typeof OwnerAnswerSchema.Type>;
}
interface CurrentPricingServices {
  /** Reads the owner rows the next round needs, given everything answered so far. */
  readonly advance: (
    state: Option.Option<EvaluationState>,
    answers: readonly OwnerAnswer[],
    operationAt: DateTime.Utc,
  ) => Effect.Effect<EvaluationState, ReadHandlerUnavailable>;
  /** The final fence: every owner generation the decision used is still current. */
  readonly confirm: (generations: readonly string[]) => Effect.Effect<boolean, ReadHandlerUnavailable>;
}

export const runCurrentPricingDecision = Effect.fn('CurrentPricingDecisionRead.run')(function* run(
  input: { readonly quotation: typeof ProofIdSchema.Type },
  context: ReadRunContext<CurrentPricingServices, typeof currentPricingCalls, NoAccessQuestions>,
) {
  const subject = yield* context.call('purchaseContext', { line: input.quotation, question: 'subject' });
  if (Option.isNone(callAnswer(subject))) {
    return yield* unavailable('The purchase context could not be verified');
  }
  let state = yield* context.transaction((services, facts) => services.advance(Option.none(), [], facts.operationAt));
  // Each round: the owner rows decide which owners to ask; their answers decide the next rows.
  for (let round = 0; !state.done && round < 8; round += 1) {
    const answers = yield* Effect.forEach(
      state.needs,
      (need) => context.call(need.owner, need.question).pipe(Effect.map((outcome): OwnerAnswer => ({ need, outcome }))),
      { concurrency: 4 },
    );
    const previous = Option.some(state);
    state = yield* context.transaction((services, facts) => services.advance(previous, answers, facts.operationAt));
  }
  const { done, generations } = state;
  const confirmed = yield* context.transaction((services) => services.confirm(generations));
  if (!done || !confirmed) {
    return yield* unavailable('The pricing decision could not be confirmed against current owner state');
  }
  return readAnswer({ generations }, { resultCount: 1 });
});

/* ================================================================================================ */
/* (d) one transaction, plus extra access questions                                                 */
/* ================================================================================================ */

/** Registrations of the same module (two Actions and a read), as `defineAction`/`defineRead` return them. */
declare const applyCommandAction: AccessQuestionTarget;
declare const assignOwnerAction: AccessQuestionTarget;
declare const recordsRead: AccessQuestionTarget;

const facilityOverviewQuestions = {
  assign: canRun(assignOwnerAction),
  restricted: canSeeFields(recordsRead, 'facility.operations.records.restricted'),
  visibleRows: canList(recordsRead),
  write: canRun(applyCommandAction),
} as const;

const FacilityRecordSchema = Schema.Struct({
  record: ProofIdSchema,
  restrictedNote: Schema.optionalKey(Schema.String),
});
const FacilityOverviewResponseSchema = Schema.Struct({
  canAssign: Schema.Boolean,
  canWrite: Schema.Boolean,
  records: Schema.Array(FacilityRecordSchema),
});
interface FacilityServices {
  readonly load: (
    limit: number,
    rows: ListAccessPredicate,
  ) => Effect.Effect<readonly (typeof FacilityRecordSchema.Type)[], ReadHandlerUnavailable>;
}
declare const facilityServices: ReadServiceFactory<FacilityServices>;

export const facilityOverviewRead = defineRead(
  {
    accessDeclaration: {
      key: 'facility.operations.overview.read',
      kind: READ,
      modes: [RUN],
      placement: { group: 'facility', level: 'basic' },
      risk: 'routine',
      selectors: [],
    },
    accessKind: DETAIL,
    accessQuestions: facilityOverviewQuestions,
    entrypoint: defineTenantModuleEntrypoint({
      access: READ,
      authorization: { kind: 'protected' },
      entrypointKey: 'facility.operations.api.overview',
      moduleKey: 'facility.operations',
      role: API,
    }),
    evidencePolicy: { captureMode: METADATA_ONLY, policyKey: 'facility.operations.api.overview.evidence.v1' },
    inputSchema: Schema.Struct({ limit: Schema.Finite }),
    legalEntityScope: 'required',
    owningModuleKey: 'facility.operations',
    policies: [],
    readKey: 'facility.operations.api.overview',
    resultSchema: FacilityOverviewResponseSchema,
    schemaVersion: SCHEMA_VERSION,
  },
  {
    // Still the one-transaction handler: the answers arrive as data next to the services.
    load: (input, context) =>
      Option.match(Option.flatten(Result.getSuccess(context.access.visibleRows)), {
        onNone: () =>
          Effect.succeed(readAnswer({ canAssign: false, canWrite: false, records: [] }, { resultCount: 0 })),
        onSome: (rows) =>
          context.services.load(input.limit, rows).pipe(
            Effect.map((records) =>
              readAnswer(
                {
                  canAssign: context.access.assign === 'allowed',
                  canWrite: context.access.write === 'allowed',
                  records:
                    context.access.restricted === 'allowed' ? records : records.map(({ record }) => ({ record })),
                },
                { resultCount: records.length },
              ),
            ),
          ),
      }),
  },
  facilityServices,
);

/* ================================================================================================ */
/* (e) the same neutral capabilities under an Action and under a worker delivery                    */
/* ================================================================================================ */

const ReservationSchema = Schema.Struct({ reservation: ProofIdSchema });
const recoverReservationOperation = moduleOperation({
  kind: READ,
  path: '/reads/market-retirement-reservation-recovery',
  provider: {
    entrypointKey: 'commerce.customer-context.api.market-retirement-reservation-recovery',
    moduleId: CUSTOMER_CONTEXT,
    schemaVersion: SCHEMA_VERSION,
  },
  request: Schema.Struct({ idempotencyKey: IdempotencyKeySchema }),
  response: Schema.Union([
    Schema.Struct({ reservation: ProofIdSchema, state: Schema.Literal('RESERVED') }),
    Schema.Struct({ state: Schema.Literal('ABSENT') }),
  ]),
});
const reserveRetirementOperation = moduleOperation({
  kind: 'write',
  path: '/actions/reserve-market-retirement',
  provider: {
    entrypointKey: 'commerce.customer-context.reserve-market-retirement',
    moduleId: CUSTOMER_CONTEXT,
    schemaVersion: SCHEMA_VERSION,
  },
  request: Schema.Struct({ market: ProofIdSchema }),
  response: ReservationSchema,
});
const retirementCalls = {
  commitState: declaredCall(
    coreOperations.actionCommitState,
    'commerce.market-catalog.requirement.retire-commit-state',
  ),
  recover: declaredCall(recoverReservationOperation, 'commerce.market-catalog.requirement.retirement-recover'),
  reserve: declaredWriteCall(
    reserveRetirementOperation,
    'commerce.market-catalog.requirement.retirement-reserve',
    recoverReservationOperation,
  ),
} as const satisfies DeclaredCalls;

type Market = typeof ProofIdSchema.Type;
interface RetirementServices {
  readonly retire: (market: Market, reservation: Market) => Effect.Effect<void, ReadHandlerUnavailable>;
}
type RetirementCapabilities = ExecutionCapabilities<RetirementServices, typeof retirementCalls>;

/** A write call settled by its typed outcome; an indeterminate one is recovered by the same key first. */
const settledReservation = (
  context: RetirementCapabilities,
  outcome: WriteCallOutcome<typeof ReservationSchema.Type>,
): Effect.Effect<Option.Option<Market>> =>
  Match.valueTags(outcome, {
    Committed: ({ value }) => Effect.succeed(Option.some(value.reservation)),
    CommittedRejection: () => Effect.succeed(Option.none()),
    DefinitelyUncommitted: () => Effect.succeed(Option.none()),
    Indeterminate: ({ idempotencyKey }) =>
      context
        .call('recover', { idempotencyKey })
        .pipe(
          Effect.map((recovered) =>
            Option.flatMap(callAnswer(recovered), (value) =>
              value.state === 'RESERVED' ? Option.some(value.reservation) : Option.none(),
            ),
          ),
        ),
  });

const retire = (context: RetirementCapabilities, market: Market, idempotencyKey: string) =>
  context.call('reserve', { market }, { idempotencyKey: IdempotencyKeySchema.make(idempotencyKey) }).pipe(
    Effect.flatMap((outcome) => settledReservation(context, outcome)),
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.succeed(false),
        onSome: (reservation) =>
          context.transaction((services) => services.retire(market, reservation)).pipe(Effect.as(true)),
      }),
    ),
  );

/** Action sketch: the identity is the admitted invocation; the transaction is the Action's commit. */
export const retireMarketActionSketch = (
  payload: { readonly market: Market },
  context: RetirementCapabilities,
): Effect.Effect<boolean, ReadHandlerUnavailable | TransactionAborted> =>
  Match.valueTags(context.execution.identity, {
    ActionInvocation: ({ actionInvocationId }) => retire(context, payload.market, `${actionInvocationId}:reserve`),
    Request: () => Effect.succeed(false),
    WorkerDelivery: () => Effect.succeed(false),
  });

/** Worker sketch: the identity is the attested delivery; the same calls, keys derived from the delivery. */
export const retirementWorkerSketch = (
  message: { readonly market: Market },
  context: RetirementCapabilities,
): Effect.Effect<boolean, ReadHandlerUnavailable | TransactionAborted> =>
  Match.valueTags(context.execution.identity, {
    ActionInvocation: () => Effect.succeed(false),
    Request: () => Effect.succeed(false),
    WorkerDelivery: ({ deliveryId }) => retire(context, message.market, `${deliveryId}:reserve`),
  });

/* A read call never fails: its outcome is data in the success channel. */
export const readCallNeverFails = (
  context: ReadRunContext<unknown, typeof verifyMarketEligibilityCalls, NoAccessQuestions>,
  subject: typeof RestrictionSubjectSchema.Type,
): Effect.Effect<CallOutcome<OperationOutput<typeof marketSubjectRestrictionsCurrentOperation>>> =>
  context.call('subjectRestrictions', { subject });
