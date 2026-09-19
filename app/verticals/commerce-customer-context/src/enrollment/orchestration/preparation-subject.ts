import type { AuthBindingIdSchema, BindingRevisionSchema } from '@app/core-runtime/auth/external-identity-contracts';
import { ReadPrincipalBindingPayloadSchema } from '@app/core-runtime/auth/external-identity-contracts';
import { ExternalIdentityClient } from '@app/shared-contracts/server/external-identity-client';
import type {
  ExternalIdentityClientError,
  ExternalIdentityClientOptions,
  ExternalIdentityClientPort,
} from '@app/shared-contracts/server/external-identity-client';
import { Context, Effect, Layer, Option, Schema } from 'effect';

import {
  CommerceCoreIdentityClientConfig,
  commerceCoreIdentityClientOptions,
} from '../../../api/portal-auth/provider/core-identity-client-config.ts';
import { SellingLegalEntityRefSchema } from '../../../shared/domain/profile-contracts.ts';
import {
  EnrollmentModuleKeySchema,
  EnrollmentTransitionKeySchema,
  isEnrollmentAttemptTerminal,
} from '../../../shared/enrollment-contracts.ts';
import type { EnrollmentAttemptSnapshot, ReadEnrollmentAttemptInput } from '../../../shared/enrollment-contracts.ts';
import { RetailPortalPrincipalRefSchema } from '../../../shared/resources/retail-portal-profile-binding.ts';
import { CommerceEnrollmentAttemptRejected, CommerceEnrollmentAttemptUnavailable } from '../attempts/errors.ts';
import type { CommerceEnrollmentAttemptError } from '../attempts/errors.ts';
import { makeExistingAccountCoreIdentityReserveRequest } from '../journeys/existing-account.ts';
import {
  PARTY_CANDIDATE_SUBMISSION_TRANSITION_KEY,
  PARTY_REGISTRY_OWNER_MODULE_KEY,
  retailPartyCandidateDigest,
  retailPartyRefFor,
  retailSelfEnrollmentEvidenceReference,
} from '../journeys/retail-self-enrollment-contracts.ts';
import type { RetailSelfEnrollmentPreparationSubject } from '../journeys/retail-self-enrollment-preparation.ts';
import type { CommerceEnrollmentOwnerAttemptStore } from './owner-transition-driver.ts';
import {
  CommerceEnrollmentOwnerTransactionRunner,
  commerceEnrollmentOwnerAttemptStoreForRun,
} from './owner-transition-production.ts';

/**
 * The journey subject for one durable Enrollment Attempt.
 *
 * Every field is recovered from state that already survives a crash, so a re-run after an
 * INDETERMINATE outcome reconciles onto the refs the first run established instead of creating a
 * second Party or a second Principal:
 *
 *   - `sellingLegalEntityRef` is the Attempt's own immutable `targetLegalEntityId`;
 *   - `partyCandidateDigest` is derived from the Attempt's immutable identity digest, so it is
 *     byte-identical on every run and is never a value a caller could choose;
 *   - `partyRef` is the `resultReference` the Party Registry owner transition durably recorded —
 *     the journey never re-derives a Party from an email or a Guest order;
 *   - `principalRef` is the Principal of the Core Principal Auth Binding retained for this
 *     Attempt's exact provider subject. Core's exact-subject storage invariant makes that read the
 *     idempotent answer: a re-run finds the binding the first run reserved rather than reserving a
 *     second one, and the reserve/activate keys are derived from the Attempt identity so even a
 *     request lost in flight converges on the same binding.
 */

const PRINCIPAL_MODULE_ID = 'core.identity';
const LEGAL_ENTITY_RESOURCE_TYPE = 'core.identity.legal-entity';
const PRINCIPAL_RESOURCE_TYPE = 'core.identity.principal';

/** Namespaces the derived references below so two purposes can never collide on one Attempt. */
const CORE_BINDING_AUTHENTICATION_REF_PURPOSE = 'commerce.portal-enrollment.core-binding.authentication-ref';
const CORE_BINDING_RESERVE_PURPOSE = 'commerce.portal-enrollment.core-binding.reserve';
const CORE_BINDING_ACTIVATE_PURPOSE = 'commerce.portal-enrollment.core-binding.activate';
const PARTY_CANDIDATE_DIGEST_PURPOSE = 'commerce.portal-enrollment.party-candidate';

export interface CommerceEnrollmentPreparationSubjectResolverService {
  /**
   * The subject for this Attempt, or a typed Attempt failure. A retryable failure means the subject
   * is not knowable yet (the account transition has not committed, or Core is unreachable); a
   * non-retryable one means this Attempt can never carry a Retail journey subject.
   */
  readonly resolve: (
    input: ReadEnrollmentAttemptInput,
  ) => Effect.Effect<RetailSelfEnrollmentPreparationSubject, CommerceEnrollmentAttemptError>;
}

export class CommerceEnrollmentPreparationSubjectResolver extends Context.Service<
  CommerceEnrollmentPreparationSubjectResolver,
  CommerceEnrollmentPreparationSubjectResolverService
>()(
  '@app/commerce-customer-context/enrollment/orchestration/preparation-subject/CommerceEnrollmentPreparationSubjectResolver',
) {}

const preserveCause = <Value extends object>(error: Value, cause: unknown): Value =>
  Object.defineProperty(error, 'cause', { configurable: false, enumerable: false, value: cause });

const unavailable = (
  attempt: EnrollmentAttemptSnapshot,
  reason: string,
  cause?: unknown,
): CommerceEnrollmentAttemptError => {
  const error = new CommerceEnrollmentAttemptUnavailable({
    attemptId: attempt.portalEnrollmentAttemptId,
    code: 'attempt_unavailable',
    reason: reason.slice(0, 500),
    retryable: true,
  });
  return cause === undefined ? error : preserveCause(error, cause);
};

const rejected = (
  attempt: EnrollmentAttemptSnapshot,
  reason: string,
  cause?: unknown,
): CommerceEnrollmentAttemptError => {
  const error = new CommerceEnrollmentAttemptRejected({
    attemptId: attempt.portalEnrollmentAttemptId,
    code: 'attempt_invalid',
    reason: reason.slice(0, 500),
    retryable: false,
  });
  return cause === undefined ? error : preserveCause(error, cause);
};

/**
 * A Core transport failure is retryable unless Core itself refused the request. A 4xx that is not a
 * throttle is a decision about this subject, so treating it as retryable would loop forever.
 */
const CoreStatusCarrierSchema = Schema.Struct({ status: Schema.Finite });
const isCoreDecision = (cause: ExternalIdentityClientError): boolean => {
  if (!Schema.is(CoreStatusCarrierSchema)(cause)) {
    return false;
  }
  const { status } = cause;
  return status >= 400 && status < 500 && status !== 429;
};

const coreFailure =
  (attempt: EnrollmentAttemptSnapshot, reason: string) =>
  (cause: ExternalIdentityClientError): CommerceEnrollmentAttemptError =>
    isCoreDecision(cause) ? rejected(attempt, reason, cause) : unavailable(attempt, reason, cause);

/** Deterministic, non-secret reference derived from the Attempt's own durable identity. */
const attemptReference = (purpose: string, attempt: EnrollmentAttemptSnapshot): string =>
  retailSelfEnrollmentEvidenceReference([purpose, attempt.tenantId, attempt.portalEnrollmentAttemptId]);

const sellingLegalEntityRefFor = (
  attempt: EnrollmentAttemptSnapshot,
): Effect.Effect<RetailSelfEnrollmentPreparationSubject['sellingLegalEntityRef'], CommerceEnrollmentAttemptError> => {
  const { targetLegalEntityId } = attempt;
  if (targetLegalEntityId === undefined) {
    return Effect.fail(rejected(attempt, 'The Enrollment Attempt names no selling Legal Entity to enroll into'));
  }
  return Schema.decodeEffect(SellingLegalEntityRefSchema)({
    moduleId: PRINCIPAL_MODULE_ID,
    resourceId: targetLegalEntityId,
    resourceType: LEGAL_ENTITY_RESOURCE_TYPE,
    tenantId: attempt.tenantId,
  }).pipe(
    Effect.mapError((cause) =>
      rejected(attempt, 'The Attempt selling Legal Entity is not a usable Commerce reference', cause),
    ),
  );
};

const partyTransitionIdentity = Effect.all(
  {
    ownerModuleKey: Schema.decodeEffect(EnrollmentModuleKeySchema)(PARTY_REGISTRY_OWNER_MODULE_KEY),
    transitionKey: Schema.decodeEffect(EnrollmentTransitionKeySchema)(PARTY_CANDIDATE_SUBMISSION_TRANSITION_KEY),
    // Two independent in-memory decodes of journey-owned constants.
  },
  { concurrency: 2 },
).pipe(Effect.orDie);

/**
 * The Party the durable owner journal already names. An absent or unsuccessful transition is
 * `none` rather than a failure: the journey is simply not past its Party step yet, and the
 * preparation port answers `not_applicable` for the steps that need an exact Party.
 */
const partyRefFor = Effect.fn('CommerceEnrollmentPreparationSubjectResolver.partyRef')(
  function* partyRefForEffect(
    store: CommerceEnrollmentOwnerAttemptStore,
    attempt: EnrollmentAttemptSnapshot,
  ): Effect.fn.Return<RetailSelfEnrollmentPreparationSubject['partyRef'], CommerceEnrollmentAttemptError> {
    const identity = yield* partyTransitionIdentity;
    const operation = yield* store
      .readOwnerOperation({
        ownerModuleKey: identity.ownerModuleKey,
        portalEnrollmentAttemptId: attempt.portalEnrollmentAttemptId,
        tenantId: attempt.tenantId,
        transitionKey: identity.transitionKey,
      })
      .pipe(
        Effect.asSome,
        Effect.catchTag('CommerceEnrollmentAttemptNotFound', () => Effect.succeedNone),
      );
    if (Option.isNone(operation)) {
      return Option.none();
    }
    const { resultReference, status } = operation.value;
    if (status !== 'SUCCEEDED' || resultReference === undefined) {
      return Option.none();
    }
    return Option.some(retailPartyRefFor(attempt.tenantId, resultReference));
  },
);

interface CoreBindingIdentity {
  readonly authBindingId: typeof AuthBindingIdSchema.Type;
  readonly bindingRevision: typeof BindingRevisionSchema.Type;
  readonly bindingStatus: 'active' | 'disabled' | 'pending' | 'revoked';
  readonly principalId: string;
}

interface CoreCall {
  readonly attempt: EnrollmentAttemptSnapshot;
  readonly authenticationRef: string;
  readonly client: ExternalIdentityClientPort;
  readonly options: ExternalIdentityClientOptions;
}

/**
 * Activate the binding this Attempt reserved. The idempotency key is derived from the Attempt, so
 * an activation whose response was lost is replayed by Core rather than repeated.
 */
const activateBinding = Effect.fn('CommerceEnrollmentPreparationSubjectResolver.activateBinding')(
  function* activateBindingEffect(
    call: CoreCall,
    binding: CoreBindingIdentity,
  ): Effect.fn.Return<string, CommerceEnrollmentAttemptError> {
    const result = yield* call.client
      .activatePrincipalBinding(
        {
          activation: { authBindingId: binding.authBindingId, expectedRevision: binding.bindingRevision },
          authenticationRef: call.authenticationRef,
        },
        {
          ...call.options,
          idempotencyKey: attemptReference(CORE_BINDING_ACTIVATE_PURPOSE, call.attempt),
        },
      )
      .pipe(
        Effect.mapError(
          coreFailure(call.attempt, 'The Core Principal Auth Binding for this Attempt could not be activated'),
        ),
      );
    return result.principalId;
  },
);

const principalFromBinding = (call: CoreCall, binding: CoreBindingIdentity): Effect.Effect<string, CommerceEnrollmentAttemptError> => {
  if (binding.bindingStatus === 'active') {
    return Effect.succeed(binding.principalId);
  }
  if (binding.bindingStatus === 'pending') {
    return activateBinding(call, binding);
  }
  // A disabled or revoked binding is a Core decision about this subject; enrolling over it would
  // resurrect an identity an operator deliberately withdrew.
  return Effect.fail(
    rejected(call.attempt, 'The retained Core Principal Auth Binding for this Attempt subject is not current'),
  );
};

const reserveBinding = Effect.fn('CommerceEnrollmentPreparationSubjectResolver.reserveBinding')(
  function* reserveBindingEffect(
    call: CoreCall,
    accountSubject: NonNullable<EnrollmentAttemptSnapshot['accountSubject']>,
  ): Effect.fn.Return<string, CommerceEnrollmentAttemptError> {
    // The reserve payload is journey-neutral: it names only the exact provider subject and the
    // opaque owner evidence, so the Existing-account builder is the one place that decoding lives.
    const payload = yield* makeExistingAccountCoreIdentityReserveRequest({
      accountSubject,
      authenticationRef: call.authenticationRef,
    }).pipe(
      Effect.mapError((cause) =>
        rejected(call.attempt, 'The Attempt provider subject could not be represented for Core identity', cause),
      ),
    );
    const result = yield* call.client
      .reservePrincipalBinding(payload, {
        ...call.options,
        idempotencyKey: attemptReference(CORE_BINDING_RESERVE_PURPOSE, call.attempt),
      })
      .pipe(
        Effect.mapError(
          coreFailure(call.attempt, 'The Core Principal Auth Binding for this Attempt could not be reserved'),
        ),
      );
    return yield* principalFromBinding(call, {
      authBindingId: result.authBindingId,
      bindingRevision: result.bindingRevision,
      bindingStatus: result.bindingStatus,
      principalId: result.principalId,
    });
  },
);

const principalIdFor = Effect.fn('CommerceEnrollmentPreparationSubjectResolver.principalId')(
  function* principalIdForEffect(call: CoreCall): Effect.fn.Return<string, CommerceEnrollmentAttemptError> {
    const { accountSubject } = call.attempt;
    if (accountSubject === undefined) {
      // The provider account transition has not committed a subject yet, so there is nothing to
      // bind. This is the ordinary state of a just-started Attempt, not a broken one.
      return yield* unavailable(
        call.attempt,
        'The Enrollment Attempt has not recorded a provider account subject to bind a Principal to',
      );
    }
    const payload = yield* Schema.decodeEffect(ReadPrincipalBindingPayloadSchema)({
      authenticationNamespaceId: accountSubject.authenticationNamespaceId,
      lookup: 'subject' as const,
      providerSubjectId: accountSubject.providerSubjectId,
      subjectType: accountSubject.subjectType,
    }).pipe(
      Effect.mapError((cause) =>
        rejected(call.attempt, 'The Attempt provider subject could not be encoded for the Core read', cause),
      ),
    );
    const read = yield* call.client
      .readPrincipalBinding(payload, call.options)
      .pipe(
        Effect.mapError(
          coreFailure(call.attempt, 'The Core Principal Auth Binding for this Attempt subject could not be read'),
        ),
      );
    return read.outcome === 'NOT_FOUND'
      ? yield* reserveBinding(call, accountSubject)
      : yield* principalFromBinding(call, {
          authBindingId: read.authBindingId,
          bindingRevision: read.bindingRevision,
          bindingStatus: read.bindingStatus,
          principalId: read.principalId,
        });
  },
);

const principalRefFor = Effect.fn('CommerceEnrollmentPreparationSubjectResolver.principalRef')(
  function* principalRefForEffect(
    call: CoreCall,
  ): Effect.fn.Return<RetailSelfEnrollmentPreparationSubject['principalRef'], CommerceEnrollmentAttemptError> {
    const principalId = yield* principalIdFor(call);
    return yield* Schema.decodeEffect(RetailPortalPrincipalRefSchema)({
      moduleId: PRINCIPAL_MODULE_ID,
      resourceId: principalId,
      resourceType: PRINCIPAL_RESOURCE_TYPE,
      tenantId: call.attempt.tenantId,
    }).pipe(
      Effect.mapError((cause) =>
        rejected(call.attempt, 'The established Core Principal is not a usable Retail Portal reference', cause),
      ),
    );
  },
);

/**
 * The candidate facts are the Attempt's own immutable intent, never the caller's request body: the
 * digest is therefore reproduced exactly by every retry, and a caller cannot submit a candidate of
 * its own choosing by replaying a start request with different facts.
 */
const partyCandidateDigestFor = (attempt: EnrollmentAttemptSnapshot): string =>
  retailPartyCandidateDigest([
    PARTY_CANDIDATE_DIGEST_PURPOSE,
    attempt.journey,
    attempt.tenantId,
    attempt.portalEnrollmentAttemptId,
    attempt.intentKey,
    attempt.intentDigest,
  ]);

const resolveSubject = Effect.fn('CommerceEnrollmentPreparationSubjectResolver.resolve')(
  function* resolveSubjectEffect(
    store: CommerceEnrollmentOwnerAttemptStore,
    client: ExternalIdentityClientPort,
    clientOptions: (attempt: EnrollmentAttemptSnapshot) => ExternalIdentityClientOptions,
    input: ReadEnrollmentAttemptInput,
  ): Effect.fn.Return<RetailSelfEnrollmentPreparationSubject, CommerceEnrollmentAttemptError> {
    const attempt = yield* store.read(input);
    if (isEnrollmentAttemptTerminal(attempt.state)) {
      return yield* rejected(attempt, 'A terminal Enrollment Attempt has no journey subject to prepare');
    }
    const sellingLegalEntityRef = yield* sellingLegalEntityRefFor(attempt);
    const call: CoreCall = {
      attempt,
      authenticationRef: attemptReference(CORE_BINDING_AUTHENTICATION_REF_PURPOSE, attempt),
      client,
      options: clientOptions(attempt),
    };
    const { partyRef, principalRef } = yield* Effect.all(
      {
        // One durable owner read and one Core identity read; neither depends on the other.
        partyRef: partyRefFor(store, attempt),
        principalRef: principalRefFor(call),
      },
      { concurrency: 2 },
    );
    return {
      partyCandidateDigest: partyCandidateDigestFor(attempt),
      partyRef,
      portalEnrollmentAttemptId: attempt.portalEnrollmentAttemptId,
      principalRef,
      sellingLegalEntityRef,
    };
  },
);

/**
 * Build a resolver over the exact seams it reads. The Attempt store is a per-Tenant seam rather
 * than an ambient service because each resolution opens its own Attempt transaction, exactly as the
 * installed owner preparation port does: no owner read happens inside a governed Action
 * transaction.
 */
export const commerceEnrollmentPreparationSubjectResolverForPorts = (
  store: CommerceEnrollmentOwnerAttemptStore,
  client: ExternalIdentityClientPort,
  clientOptions: (attempt: EnrollmentAttemptSnapshot) => ExternalIdentityClientOptions,
): CommerceEnrollmentPreparationSubjectResolverService =>
  Object.freeze({
    resolve: (input: ReadEnrollmentAttemptInput) => resolveSubject(store, client, clientOptions, input),
  });

export const CommerceEnrollmentPreparationSubjectResolverLive = Layer.effect(
  CommerceEnrollmentPreparationSubjectResolver,
  Effect.gen(function* makePreparationSubjectResolver() {
    const runner = yield* CommerceEnrollmentOwnerTransactionRunner;
    const client = yield* ExternalIdentityClient;
    const configuration = yield* CommerceCoreIdentityClientConfig;
    /** One correlation per Attempt, so every Core call this resolver makes is traceable to it. */
    const clientOptions = (attempt: EnrollmentAttemptSnapshot): ExternalIdentityClientOptions =>
      commerceCoreIdentityClientOptions(
        configuration,
        `commerce-enrollment-subject:${attempt.portalEnrollmentAttemptId}`,
      );
    return {
      resolve: (input: ReadEnrollmentAttemptInput) =>
        commerceEnrollmentPreparationSubjectResolverForPorts(
          commerceEnrollmentOwnerAttemptStoreForRun({ tenantId: input.tenantId }, runner.run),
          client,
          clientOptions,
        ).resolve(input),
    };
  }),
);
