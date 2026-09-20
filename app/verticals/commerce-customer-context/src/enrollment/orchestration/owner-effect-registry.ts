import { ReadPrincipalBindingPayloadSchema } from '@app/core-runtime/auth/external-identity-contracts';
import { PartyMatchRequestSchema } from '@app/party-registry/api';
import { ExternalIdentityClient } from '@app/shared-contracts/server/external-identity-client';
import type {
  ExternalIdentityClientOptions,
  ExternalIdentityClientPort,
  ReadPrincipalBindingRequest,
} from '@app/shared-contracts/server/external-identity-client';
import { Context, DateTime, Effect, Layer, Option, Schema } from 'effect';

import { CommercePortalAuthAccountLookupService } from '../../../api/portal-auth/provider/account-lookup-service.ts';
import type { CommercePortalAuthAccountLookup } from '../../../api/portal-auth/provider/account-lookup-service.ts';
import {
  CommerceCoreIdentityClientConfig,
  commerceCoreIdentityClientOptions,
} from '../../../api/portal-auth/provider/core-identity-client-config.ts';
import { EnrollmentDigestSchema } from '../../../shared/enrollment-contracts.ts';
import type {
  EnrollmentAttemptSnapshot,
  EnrollmentOwnerOperationSnapshot,
  EnrollmentResourceIdSchema,
} from '../../../shared/enrollment-contracts.ts';
import { RetailCustomerProfileRefSchema } from '../../../shared/resources/retail-customer-profile.ts';
import { attemptRejected, attemptUnavailable } from '../attempts/errors.ts';
import type { CommerceEnrollmentAttemptError } from '../attempts/errors.ts';
import {
  ACTIVATE_PRINCIPAL_BINDING_TRANSITION_KEY,
  CORE_IDENTITY_OWNER_MODULE_KEY,
  RESERVE_PRINCIPAL_BINDING_TRANSITION_KEY,
  existingAccountCoreIdentityActivateRequest,
  existingAccountCoreIdentityReadByBindingRequest,
  existingAccountCoreIdentityReserveRequest,
  existingAccountRequestDigest,
} from '../journeys/existing-account.ts';
import type { JourneyTransitionSpec } from '../journeys/journey-contracts.ts';
import {
  retailPartyCandidateOwnerEffect,
  retailPartyCandidateOwnerExecutors,
} from '../journeys/retail-self-enrollment-party-owner.ts';
import type { RetailPartyCandidateOwnerInput } from '../journeys/retail-self-enrollment-party-owner.ts';
import type { RetailSelfEnrollmentPreparationSubject } from '../journeys/retail-self-enrollment-preparation.ts';
import {
  CommerceActionCommitResolutionFailed,
  retailCustomerProfileActionExecutor,
  retailCustomerProfileOwnerEffect,
  retailPortalBindingActionExecutor,
  retailPortalBindingOwnerEffect,
} from '../journeys/retail-self-enrollment-profile-owners.ts';
import {
  BIND_RETAIL_PORTAL_PROFILE_TRANSITION_KEY,
  COMMERCE_CUSTOMER_CONTEXT_OWNER_MODULE_KEY,
  ENSURE_RETAIL_CUSTOMER_PROFILE_TRANSITION_KEY,
  PARTY_CANDIDATE_SUBMISSION_TRANSITION_KEY,
  PARTY_REGISTRY_OWNER_MODULE_KEY,
  retailSelfEnrollmentEvidenceReference,
  retailSelfEnrollmentRequestDigest,
} from '../journeys/retail-self-enrollment-contracts.ts';
import type { RetailSelfEnrollmentStepIntent } from '../journeys/retail-self-enrollment-contracts.ts';
import { decodeOwnerResolution } from './owner-effect-codec.ts';
import { providerObservationFor } from './owner-transition-composition.ts';
import { commerceEnrollmentCoreIdentityOwnerEffectFor } from './owner-transition-driver.ts';
import type {
  CommerceEnrollmentCoreIdentityOwnerEffectOptions,
  CommerceEnrollmentOwnerEffect,
} from './owner-transition-driver.ts';
import { PORTAL_ACCOUNT_CREATION_TRANSITION_KEY, PORTAL_AUTH_OWNER_MODULE_KEY } from './prepared-owner-authority.ts';
import { commerceEnrollmentPortalAuthOwnerReconciliationForLookup } from './provider-owner-effect.ts';

/**
 * The owner effects a deployment may run for one Enrollment Attempt, keyed by the exact
 * `ownerModuleKey/transitionKey` pair the journey declared.
 *
 * Everything an entry reads comes from state that already survives a crash — the durable Attempt
 * row, the durable owner journal, and the journey subject resolved from both — so a re-run rebuilds
 * byte-identical effects and identical request digests, and the durable claim replays.
 *
 * A pair no entry declares is a miss, never a wildcard.
 */

type EnrollmentDigest = typeof EnrollmentDigestSchema.Type;
type EnrollmentResourceId = typeof EnrollmentResourceIdSchema.Type;

/** What this deployment is allowed to do for one transition of one Attempt. */
export interface CommerceEnrollmentRegisteredOwnerEffect {
  /**
   * `none` when a continuation may not dispatch the transition. The portal account-creation
   * transition is dispatched exactly once by the enrollment start route — the only caller that ever
   * holds the credential.
   */
  readonly dispatch: Option.Option<{
    readonly effect: CommerceEnrollmentOwnerEffect['dispatch'];
    /** The digest an equivalent retry of this transition must reproduce exactly. */
    readonly requestDigest: EnrollmentDigest;
  }>;
  readonly reconcile: CommerceEnrollmentOwnerEffect['reconcile'];
}

/** Everything the registry reads about one Attempt, all of it durable. */
export interface CommerceEnrollmentOwnerEffectContext {
  readonly attempt: EnrollmentAttemptSnapshot;
  /** The durable owner journal of this Attempt: one entry per transition ever claimed. */
  readonly operations: readonly EnrollmentOwnerOperationSnapshot[];
  readonly requestCorrelation: string;
  readonly subject: RetailSelfEnrollmentPreparationSubject;
}

export interface CommerceEnrollmentOwnerEffectRegistryService {
  /**
   * The owner effect for one declared transition, or `none` when this deployment registers none —
   * either because no entry declares the pair, or because the Attempt does not yet carry the exact
   * durable facts the entry needs.
   */
  readonly resolve: (
    transition: JourneyTransitionSpec,
    context: CommerceEnrollmentOwnerEffectContext,
  ) => Effect.Effect<Option.Option<CommerceEnrollmentRegisteredOwnerEffect>, CommerceEnrollmentAttemptError>;
}

export class CommerceEnrollmentOwnerEffectRegistry extends Context.Service<
  CommerceEnrollmentOwnerEffectRegistry,
  CommerceEnrollmentOwnerEffectRegistryService
>()(
  '@app/commerce-customer-context/enrollment/orchestration/owner-effect-registry/CommerceEnrollmentOwnerEffectRegistry',
) {}

const CORE_BINDING_AUTHENTICATION_REF_PURPOSE = 'commerce.portal-enrollment.core-binding.authentication-ref';
const CORE_BINDING_RECONCILIATION_PURPOSE = 'commerce.portal-enrollment.core-binding.reconciliation';
const PARTY_CANDIDATE_EVIDENCE_PURPOSE = 'commerce.portal-enrollment.party-candidate.evidence';
const RETAIL_PORTAL_BINDING_REASON = 'Retail self-enrollment established the portal profile binding';

type RegistryEntry = CommerceEnrollmentOwnerEffectRegistryService['resolve'];

const registryKey = (ownerModuleKey: string, transitionKey: string): string => `${ownerModuleKey}/${transitionKey}`;

const none: Option.Option<CommerceEnrollmentRegisteredOwnerEffect> = Option.none();

const registered = (
  effect: CommerceEnrollmentOwnerEffect,
  requestDigest: EnrollmentDigest,
): Option.Option<CommerceEnrollmentRegisteredOwnerEffect> =>
  Option.some({
    dispatch: Option.some({ effect: effect.dispatch, requestDigest }),
    reconcile: effect.reconcile,
  });

/** Every entry reports an unusable derivation the same way: a non-retryable Attempt rejection. */
const rejectFor =
  (context: CommerceEnrollmentOwnerEffectContext, reason: string) =>
  (cause: unknown): CommerceEnrollmentAttemptError =>
    attemptRejected(reason, context.attempt.portalEnrollmentAttemptId, cause);

/** The exact result reference a prior transition durably recorded, or `none` while it has not. */
const succeededResultReference = (
  context: CommerceEnrollmentOwnerEffectContext,
  ownerModuleKey: string,
  transitionKey: string,
): Option.Option<EnrollmentResourceId> =>
  Option.fromNullishOr(
    context.operations.find(
      (operation) => operation.ownerModuleKey === ownerModuleKey && operation.transitionKey === transitionKey,
    ),
  ).pipe(
    Option.flatMap((operation) =>
      operation.status === 'SUCCEEDED' ? Option.fromNullishOr(operation.resultReference) : Option.none(),
    ),
  );

const retailDigestFor = (
  intent: RetailSelfEnrollmentStepIntent,
  transition: JourneyTransitionSpec,
  context: CommerceEnrollmentOwnerEffectContext,
): Effect.Effect<EnrollmentDigest, CommerceEnrollmentAttemptError> =>
  Schema.decodeEffect(EnrollmentDigestSchema)(
    retailSelfEnrollmentRequestDigest({
      intent,
      ownerModuleKey: transition.ownerModuleKey,
      portalEnrollmentAttemptId: context.attempt.portalEnrollmentAttemptId,
      transitionKey: transition.transitionKey,
    }),
  ).pipe(Effect.mapError(rejectFor(context, 'The Retail self-enrollment request digest is not representable')));

/**
 * The exact provider subject Commerce already observed is the candidate's subject key and the
 * deterministic Attempt evidence reference is its only evidence, so the candidate — and therefore
 * the exact-claim a re-run matches on — is byte-identical on every run.
 */
const partyCandidateFor = Effect.fn('CommerceEnrollmentOwnerEffectRegistry.partyCandidate')(
  function* partyCandidateForEffect(
    context: CommerceEnrollmentOwnerEffectContext,
  ): Effect.fn.Return<RetailPartyCandidateOwnerInput['candidate'], CommerceEnrollmentAttemptError> {
    const { attempt } = context;
    const { accountSubject } = attempt;
    if (accountSubject === undefined) {
      return yield* attemptUnavailable(
        'The Enrollment Attempt has not recorded a provider account subject to submit a Party candidate for',
        attempt.portalEnrollmentAttemptId,
      );
    }
    const evidenceRef = retailSelfEnrollmentEvidenceReference([
      PARTY_CANDIDATE_EVIDENCE_PURPOSE,
      attempt.tenantId,
      attempt.portalEnrollmentAttemptId,
    ]);
    const request = yield* Schema.decodeEffect(PartyMatchRequestSchema)({
      candidate: {
        evidenceRefs: [evidenceRef],
        officialIdentifiers: [],
        partyType: 'PERSON',
        provenance: {
          method: 'commerce.portal-enrollment.self-enrollment',
          source: 'commerce.customer-context',
        },
        subjectEvidence: [
          {
            basis: 'DIRECT_INTERACTION',
            evidenceRef,
            kind: 'ACTOR_ATTESTATION',
            observedSubject: 'PERSON',
            statement: 'The enrolling person authenticated as this exact Commerce Portal Account subject',
            subjectKey: accountSubject.providerSubjectId,
          },
        ],
        validFrom: DateTime.formatIso(attempt.createdAt),
      },
    }).pipe(
      Effect.mapError(
        rejectFor(context, 'The Attempt does not describe a Party candidate the Party Registry vocabulary can carry'),
      ),
    );
    return request.candidate;
  },
);

const partyEntry: RegistryEntry = Effect.fn('CommerceEnrollmentOwnerEffectRegistry.party')(function* partyEntryEffect(
  transition: JourneyTransitionSpec,
  context: CommerceEnrollmentOwnerEffectContext,
): Effect.fn.Return<Option.Option<CommerceEnrollmentRegisteredOwnerEffect>, CommerceEnrollmentAttemptError> {
  // Two independent in-memory derivations from the same durable Attempt; neither reaches a shared
  // downstream resource.
  const { candidate, requestDigest } = yield* Effect.all(
    {
      candidate: partyCandidateFor(context),
      requestDigest: retailDigestFor(
        {
          partyCandidateDigest: context.subject.partyCandidateDigest,
          sellingLegalEntityRef: context.subject.sellingLegalEntityRef,
          step: 'PARTY_CANDIDATE',
        },
        transition,
        context,
      ),
    },
    { concurrency: 2 },
  );
  return registered(
    retailPartyCandidateOwnerEffect(
      { candidate, requestCorrelation: context.requestCorrelation, tenantId: context.attempt.tenantId },
      retailPartyCandidateOwnerExecutors,
    ),
    requestDigest,
  );
});

/**
 * The governed Action runtime resolves whether one invocation committed, but it republishes no
 * Action result, and an owner verdict about a profile or a binding is a reading of that exact
 * result. Answering "unavailable" keeps the transition indeterminate, and therefore retryable.
 */
const actionResultNotRepublished = (): Effect.Effect<never, CommerceActionCommitResolutionFailed> =>
  Effect.fail(
    new CommerceActionCommitResolutionFailed({
      code: 'commit_resolution_unavailable',
      reason: 'The governed Action runtime republishes no Action result to reconcile this transition against',
    }),
  );

const ensureProfileEntry: RegistryEntry = Effect.fn('CommerceEnrollmentOwnerEffectRegistry.ensureProfile')(
  function* ensureProfileEntryEffect(
    transition: JourneyTransitionSpec,
    context: CommerceEnrollmentOwnerEffectContext,
  ): Effect.fn.Return<Option.Option<CommerceEnrollmentRegisteredOwnerEffect>, CommerceEnrollmentAttemptError> {
    const { partyRef } = context.subject;
    if (Option.isNone(partyRef)) {
      return none;
    }
    const requestDigest = yield* retailDigestFor(
      {
        partyRef: partyRef.value,
        sellingLegalEntityRef: context.subject.sellingLegalEntityRef,
        step: 'RETAIL_CUSTOMER_PROFILE',
      },
      transition,
      context,
    );
    return registered(
      retailCustomerProfileOwnerEffect(
        {
          effectiveAt: context.attempt.createdAt,
          partyRef: partyRef.value,
          requestCorrelation: context.requestCorrelation,
          sellingLegalEntityRef: context.subject.sellingLegalEntityRef,
        },
        { commitResolution: actionResultNotRepublished, ensureProfile: retailCustomerProfileActionExecutor },
      ),
      requestDigest,
    );
  },
);

const bindProfileEntry: RegistryEntry = Effect.fn('CommerceEnrollmentOwnerEffectRegistry.bindProfile')(
  function* bindProfileEntryEffect(
    transition: JourneyTransitionSpec,
    context: CommerceEnrollmentOwnerEffectContext,
  ): Effect.fn.Return<Option.Option<CommerceEnrollmentRegisteredOwnerEffect>, CommerceEnrollmentAttemptError> {
    const { partyRef } = context.subject;
    // The binding attaches to the profile the ensure transition durably recorded; it never names a
    // profile the owner journal has not already proven.
    const profileResourceId = succeededResultReference(
      context,
      COMMERCE_CUSTOMER_CONTEXT_OWNER_MODULE_KEY,
      ENSURE_RETAIL_CUSTOMER_PROFILE_TRANSITION_KEY,
    );
    if (Option.isNone(partyRef) || Option.isNone(profileResourceId)) {
      return none;
    }
    const profileRef = yield* Schema.decodeEffect(RetailCustomerProfileRefSchema)({
      moduleId: 'commerce.customer-context',
      resourceId: String(profileResourceId.value),
      resourceType: 'commerce.customer-context.retail-customer-profile',
      tenantId: context.attempt.tenantId,
    }).pipe(
      Effect.mapError(rejectFor(context, 'The ensured Retail Customer Profile is not a usable Commerce reference')),
    );
    const requestDigest = yield* retailDigestFor(
      {
        partyRef: partyRef.value,
        principalRef: context.subject.principalRef,
        sellingLegalEntityRef: context.subject.sellingLegalEntityRef,
        step: 'RETAIL_PORTAL_BINDING',
      },
      transition,
      context,
    );
    return registered(
      retailPortalBindingOwnerEffect(
        {
          effectiveAt: context.attempt.createdAt,
          enrollmentEvidenceRef: String(context.attempt.portalEnrollmentAttemptId),
          principalRef: context.subject.principalRef,
          profileRef,
          reason: RETAIL_PORTAL_BINDING_REASON,
          requestCorrelation: context.requestCorrelation,
          sellingLegalEntityRef: context.subject.sellingLegalEntityRef,
        },
        { bindProfile: retailPortalBindingActionExecutor, commitResolution: actionResultNotRepublished },
      ),
      requestDigest,
    );
  },
);

/** Reconcile-only: the credential-carrying dispatch belongs to the enrollment start route alone. */
const portalAccountEntry =
  (accountLookup: CommercePortalAuthAccountLookup): RegistryEntry =>
  (_transition, context) =>
    Effect.succeedSome({
      dispatch: Option.none(),
      reconcile: commerceEnrollmentPortalAuthOwnerReconciliationForLookup(() =>
        providerObservationFor(context.attempt, accountLookup),
      ).reconcile,
    });

interface CoreIdentitySeam {
  readonly client: ExternalIdentityClientPort;
  readonly clientOptions: (context: CommerceEnrollmentOwnerEffectContext) => ExternalIdentityClientOptions;
}

const coreAuthenticationRef = (context: CommerceEnrollmentOwnerEffectContext): string =>
  retailSelfEnrollmentEvidenceReference([
    CORE_BINDING_AUTHENTICATION_REF_PURPOSE,
    context.attempt.tenantId,
    context.attempt.portalEnrollmentAttemptId,
  ]);

const coreIdentityDigest = (
  context: CommerceEnrollmentOwnerEffectContext,
  transition: JourneyTransitionSpec,
  accountSubject: NonNullable<EnrollmentAttemptSnapshot['accountSubject']>,
): Effect.Effect<EnrollmentDigest, CommerceEnrollmentAttemptError> =>
  existingAccountRequestDigest({
    journey: 'EXISTING_ACCOUNT',
    ownerModuleKey: transition.ownerModuleKey,
    portalEnrollmentAttemptId: context.attempt.portalEnrollmentAttemptId,
    subject: { accountSubject, targetTenantId: context.attempt.tenantId },
    transitionKey: transition.transitionKey,
  }).pipe(
    Effect.mapError(
      rejectFor(context, 'The Core identity request digest could not be derived for this Attempt subject'),
    ),
  );

/**
 * Both Core identity transitions reconcile through one exact Core read, so a lost reserve or
 * activate response is resolved by reading Core rather than by reserving or activating a second
 * time. What counts as proof differs per transition, so each entry supplies its own predicate.
 */
const coreIdentityEffect = (
  seam: CoreIdentitySeam,
  context: CommerceEnrollmentOwnerEffectContext,
  transition: JourneyTransitionSpec,
  makeDispatchRequest: Parameters<typeof commerceEnrollmentCoreIdentityOwnerEffectFor>[0]['makeDispatchRequest'],
  readRequest: ReadPrincipalBindingRequest,
  readResultIsOriginal?: Parameters<typeof commerceEnrollmentCoreIdentityOwnerEffectFor>[0]['readResultIsOriginal'],
): CommerceEnrollmentOwnerEffect => {
  const base: CommerceEnrollmentCoreIdentityOwnerEffectOptions = {
    client: seam.client,
    clientOptions: () => seam.clientOptions(context),
    interpretReadResult: (input, result) =>
      decodeOwnerResolution(
        {
          actorPrincipalId: input.actorPrincipalId,
          outcomeCode: result.bindingStatus === 'active' ? 'core_binding_activated' : 'core_binding_reserved',
          reconciliationRef: retailSelfEnrollmentEvidenceReference([
            CORE_BINDING_RECONCILIATION_PURPOSE,
            context.attempt.tenantId,
            context.attempt.portalEnrollmentAttemptId,
            transition.transitionKey,
          ]),
          resultReference: result.authBindingId,
          status: 'SUCCEEDED',
        },
        'core_identity_unavailable',
        'The Core identity reconciliation result is not representable',
      ),
    makeDispatchRequest,
    makeReconciliationRequest: () => readRequest,
  };
  return commerceEnrollmentCoreIdentityOwnerEffectFor(
    readResultIsOriginal === undefined ? base : { ...base, readResultIsOriginal },
  );
};

/**
 * Activation's proof is the binding's own activation provenance, not an invocation id: Core
 * populates the read result's `originalInvocationId` from the *reservation* that created the
 * binding and publishes no reference for the activation that followed, so comparing it against the
 * activation's invocation reports every lost activation response as unavailable and leaves the
 * Attempt stuck. The exact reserved binding, in the namespace the Attempt's subject names, standing
 * `active` is that activation having committed — whichever invocation carried it.
 */
const activationCommittedFor =
  (
    authBindingId: EnrollmentResourceId,
    accountSubject: NonNullable<EnrollmentAttemptSnapshot['accountSubject']>,
  ): NonNullable<Parameters<typeof commerceEnrollmentCoreIdentityOwnerEffectFor>[0]['readResultIsOriginal']> =>
  (_input, result) =>
    result.bindingStatus === 'active' &&
    result.authBindingId === String(authBindingId) &&
    String(result.authenticationNamespaceId) === String(accountSubject.authenticationNamespaceId);

const coreReserveEntry = (seam: CoreIdentitySeam): RegistryEntry =>
  Effect.fn('CommerceEnrollmentOwnerEffectRegistry.coreReserve')(function* coreReserveEntryEffect(
    transition: JourneyTransitionSpec,
    context: CommerceEnrollmentOwnerEffectContext,
  ): Effect.fn.Return<Option.Option<CommerceEnrollmentRegisteredOwnerEffect>, CommerceEnrollmentAttemptError> {
    const { accountSubject } = context.attempt;
    if (accountSubject === undefined) {
      return none;
    }
    const authenticationRef = coreAuthenticationRef(context);
    const { readRequest, request, requestDigest } = yield* Effect.all(
      {
        // Reserve has no binding identifier of its own yet, so its reconciliation is the exact
        // subject read Core's exact-subject storage invariant makes unambiguous.
        readRequest: Schema.decodeEffect(ReadPrincipalBindingPayloadSchema)({
          authenticationNamespaceId: accountSubject.authenticationNamespaceId,
          lookup: 'subject',
          providerSubjectId: accountSubject.providerSubjectId,
          subjectType: accountSubject.subjectType,
        }).pipe(
          Effect.mapError(
            rejectFor(context, 'The Attempt provider subject could not be encoded for the Core reconciliation read'),
          ),
        ),
        request: existingAccountCoreIdentityReserveRequest({ accountSubject, authenticationRef }).pipe(
          Effect.mapError(
            rejectFor(
              context,
              'The Core Principal Auth Binding reservation could not be built for this Attempt subject',
            ),
          ),
        ),
        requestDigest: coreIdentityDigest(context, transition, accountSubject),
      },
      { concurrency: 3 },
    );
    return registered(
      coreIdentityEffect(seam, context, transition, () => ({ operation: 'reserve', payload: request }), readRequest),
      requestDigest,
    );
  });

const coreActivateEntry = (seam: CoreIdentitySeam): RegistryEntry =>
  Effect.fn('CommerceEnrollmentOwnerEffectRegistry.coreActivate')(function* coreActivateEntryEffect(
    transition: JourneyTransitionSpec,
    context: CommerceEnrollmentOwnerEffectContext,
  ): Effect.fn.Return<Option.Option<CommerceEnrollmentRegisteredOwnerEffect>, CommerceEnrollmentAttemptError> {
    const { accountSubject } = context.attempt;
    const reserved = succeededResultReference(
      context,
      CORE_IDENTITY_OWNER_MODULE_KEY,
      RESERVE_PRINCIPAL_BINDING_TRANSITION_KEY,
    );
    if (accountSubject === undefined || Option.isNone(reserved)) {
      return none;
    }
    const readRequest = yield* existingAccountCoreIdentityReadByBindingRequest(reserved.value).pipe(
      Effect.mapError(rejectFor(context, 'The reserved Core Principal Auth Binding reference is unusable')),
    );
    // Activation is a compare-and-set on the binding revision and only Core knows it. This read is
    // an owner read outside every Attempt transaction, exactly as the dispatch that follows it is.
    const binding = yield* seam.client
      .readPrincipalBinding(readRequest, seam.clientOptions(context))
      .pipe(
        Effect.mapError((cause) =>
          attemptUnavailable(
            'The reserved Core Principal Auth Binding could not be read before activation',
            context.attempt.portalEnrollmentAttemptId,
            cause,
          ),
        ),
      );
    if (binding.outcome !== 'FOUND') {
      return none;
    }
    const { request, requestDigest } = yield* Effect.all(
      {
        request: existingAccountCoreIdentityActivateRequest({
          authBindingId: reserved.value,
          authenticationRef: coreAuthenticationRef(context),
          expectedRevision: binding.bindingRevision,
        }).pipe(
          Effect.mapError(
            rejectFor(context, 'The Core Principal Auth Binding activation could not be built for this Attempt'),
          ),
        ),
        requestDigest: coreIdentityDigest(context, transition, accountSubject),
      },
      { concurrency: 2 },
    );
    return registered(
      coreIdentityEffect(
        seam,
        context,
        transition,
        () => ({ operation: 'activate', payload: request }),
        readRequest,
        activationCommittedFor(reserved.value, accountSubject),
      ),
      requestDigest,
    );
  });

export const CommerceEnrollmentOwnerEffectRegistryLive = Layer.effect(
  CommerceEnrollmentOwnerEffectRegistry,
  Effect.gen(function* makeCommerceEnrollmentOwnerEffectRegistry() {
    const accountLookup = yield* CommercePortalAuthAccountLookupService;
    const client = yield* ExternalIdentityClient;
    const configuration = yield* CommerceCoreIdentityClientConfig;
    const core: CoreIdentitySeam = {
      client,
      clientOptions: (context) =>
        commerceCoreIdentityClientOptions(
          configuration,
          `commerce-enrollment-continuation:${context.attempt.portalEnrollmentAttemptId}`,
        ),
    };
    const entries: ReadonlyMap<string, RegistryEntry> = new Map([
      [
        registryKey(PORTAL_AUTH_OWNER_MODULE_KEY, PORTAL_ACCOUNT_CREATION_TRANSITION_KEY),
        portalAccountEntry(accountLookup),
      ],
      [registryKey(PARTY_REGISTRY_OWNER_MODULE_KEY, PARTY_CANDIDATE_SUBMISSION_TRANSITION_KEY), partyEntry],
      [
        registryKey(COMMERCE_CUSTOMER_CONTEXT_OWNER_MODULE_KEY, ENSURE_RETAIL_CUSTOMER_PROFILE_TRANSITION_KEY),
        ensureProfileEntry,
      ],
      [
        registryKey(COMMERCE_CUSTOMER_CONTEXT_OWNER_MODULE_KEY, BIND_RETAIL_PORTAL_PROFILE_TRANSITION_KEY),
        bindProfileEntry,
      ],
      [registryKey(CORE_IDENTITY_OWNER_MODULE_KEY, RESERVE_PRINCIPAL_BINDING_TRANSITION_KEY), coreReserveEntry(core)],
      [registryKey(CORE_IDENTITY_OWNER_MODULE_KEY, ACTIVATE_PRINCIPAL_BINDING_TRANSITION_KEY), coreActivateEntry(core)],
    ]);
    return {
      resolve: (transition, context) => {
        const entry = entries.get(registryKey(transition.ownerModuleKey, transition.transitionKey));
        return entry === undefined ? Effect.succeed(none) : entry(transition, context);
      },
    };
  }),
);
