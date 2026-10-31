import type { ActionServicePreparationContext, OperationalScope } from '@app/core-runtime';
import { Clock, DateTime, Effect, Option, Schema } from 'effect';

import { ConsentSelfServicePayloadSchema } from '../../shared/actions/consent-self-service.ts';
import type { ConsentSelfServicePayload } from '../../shared/actions/consent-self-service.ts';
import { ConsentDecisionSchema } from '../../shared/domain/privacy-consent-decision.ts';
import type { ConsentCurrentResolution } from '../../shared/domain/privacy-consent-decision.ts';
import { ConsentScopeSchema } from '../../shared/domain/privacy-consent-scope.ts';
import {
  ConsentSelfServiceAuthorizationError,
  resolveAndAuthorizeConsentSelfService,
} from '../../shared/domain/privacy-consent-self-service.ts';
import type {
  ConsentSelfServiceAuthorityPorts,
  TrustedConsentSelfServiceAuthorityFact,
} from '../../shared/domain/privacy-consent-self-service.ts';
import {
  PrivacySubjectRecordSchema,
  isPrivacyInstantAtOrBefore,
  isPrivacyInstantBefore,
} from '../../shared/domain/privacy-subject.ts';
import type { PrivacySubjectOwnerEvidence, PrivacySubjectRecord } from '../../shared/domain/privacy-subject.ts';
import { ProcessingPurposeSchema } from '../../shared/domain/processing-purpose.ts';
import type { ProcessingPurpose } from '../../shared/domain/processing-purpose.ts';
import { ConsentSelfServiceAuthority } from '../actions/consent-self-service-authority.ts';
import type { ConsentSelfServiceServices } from '../actions/consent-self-service-authority.ts';
import { PrivacyActionRejected } from '../actions/privacy-action-rejected.ts';
import { requirePrivacyActionScope } from '../actions/privacy-operation-action-support.ts';
import type { PrivacyActionScopeRequired } from '../actions/privacy-action-scope-required.ts';
import { PrivacyOperationPersistenceError } from '../persistence/privacy-operation-repository.ts';
import type { PrivacyOperationRepositoryService } from '../persistence/privacy-operation-repository.ts';
import type { ProcessingPurposeRepositoryService } from '../persistence/processing-purpose-repository.ts';
import { privacySubjectPreparationScopeMatches } from '../persistence/privacy-subject-preparation.ts';

type PreparationContext = Pick<ActionServicePreparationContext, 'actionInvocationId' | 'compositionRevision' | 'scope'>;
type PreparationFailure = PrivacyActionRejected | PrivacyOperationPersistenceError;
type SubjectReaders = Pick<PrivacyOperationRepositoryService, 'listSubjects' | 'readCurrentConsent'>;

export interface ConsentSelfServiceSnapshot {
  readonly consent: ConsentCurrentResolution;
  readonly purpose: Option.Option<ProcessingPurpose>;
  readonly subjects: readonly PrivacySubjectRecord[];
}

export interface PreparedConsentAuthorityObservation {
  readonly context: PreparationContext;
  readonly deadline: number;
  readonly fact: TrustedConsentSelfServiceAuthorityFact;
  readonly partyEvidence: readonly PrivacySubjectOwnerEvidence[];
  readonly payload: ConsentSelfServicePayload;
  readonly snapshot: ConsentSelfServiceSnapshot;
}
const maximumPreparationLifetimeMilliseconds = 30_000;

const cloneSnapshot = (snapshot: ConsentSelfServiceSnapshot): ConsentSelfServiceSnapshot => ({
  consent: structuredClone(snapshot.consent),
  purpose: snapshot.purpose.pipe(Option.map((purpose) => structuredClone(purpose))),
  subjects: structuredClone(snapshot.subjects),
});

export const consentSelfServicePreparationScopeMatches = (
  prepared: PreparedConsentAuthorityObservation,
  scope: OperationalScope,
  compositionRevision: string,
): boolean =>
  compositionRevision === prepared.context.compositionRevision &&
  privacySubjectPreparationScopeMatches(prepared.context.scope, scope);

export const mapSelfServiceAuthorizationError = (error: ConsentSelfServiceAuthorizationError): PreparationFailure =>
  error.code === 'AUTHORITY_UNAVAILABLE'
    ? new PrivacyOperationPersistenceError({
        code: 'privacy_operation_persistence_unavailable',
        reason: error.reason,
      })
    : new PrivacyActionRejected({ code: 'privacy_action_rejected', reason: error.reason });

const unavailable = () =>
  new ConsentSelfServiceAuthorizationError({
    code: 'AUTHORITY_UNAVAILABLE',
    reason: 'Prepared Consent authority is unavailable or outside its actual validity interval',
  });
const conflict = () =>
  new ConsentSelfServiceAuthorizationError({
    code: 'AUTHORITY_CONFLICT',
    reason: 'Prepared Consent authority does not match the exact invocation, payload and owner state',
  });

/** Only selected owner facts leave the short snapshot transaction, never its repository. */
export const loadConsentSelfServiceSnapshot = Effect.fn('ConsentSelfServicePreparation.snapshot')(function* snapshot(
  payload: ConsentSelfServicePayload,
  context: PreparationContext,
  repositories: {
    readonly operations: SubjectReaders;
    readonly purposes: Pick<ProcessingPurposeRepositoryService, 'get'>;
  },
): Effect.fn.Return<ConsentSelfServiceSnapshot, PrivacyOperationPersistenceError | PrivacyActionScopeRequired> {
  const scope = yield* requirePrivacyActionScope(context.scope);
  const { operations, purposes } = repositories;
  const result = yield* Effect.all(
    {
      consent: operations.readCurrentConsent(scope.tenantId, scope.legalEntityId, payload.scope.scopeRef),
      purpose: purposes.get(scope.tenantId, scope.legalEntityId, payload.scope.processingPurposeRef.resourceId).pipe(
        Effect.mapError(
          (error) =>
            new PrivacyOperationPersistenceError({
              code: 'privacy_operation_persistence_unavailable',
              reason: error.reason,
            }),
        ),
      ),
      subjects: operations.listSubjects(scope.tenantId, scope.legalEntityId),
    },
    { concurrency: 1 },
  );
  return {
    ...result,
    subjects: result.subjects.filter(
      (record) => record.subjectRef.resourceId === payload.scope.privacySubjectRef.resourceId,
    ),
  };
});

const snapshotSubjects = (
  payload: ConsentSelfServicePayload,
  context: PreparationContext,
  snapshot: ConsentSelfServiceSnapshot,
): SubjectReaders => ({
  listSubjects: (tenantId, legalEntityId) =>
    tenantId === context.scope.tenantId && legalEntityId === context.scope.legalEntityId
      ? Effect.succeed(structuredClone(snapshot.subjects))
      : Effect.fail(
          new PrivacyOperationPersistenceError({ code: 'privacy_operation_conflict', reason: conflict().reason }),
        ),
  readCurrentConsent: (tenantId, legalEntityId, scopeRef) =>
    tenantId === context.scope.tenantId &&
    legalEntityId === context.scope.legalEntityId &&
    scopeRef === payload.scope.scopeRef
      ? Effect.succeed(structuredClone(snapshot.consent))
      : Effect.fail(
          new PrivacyOperationPersistenceError({ code: 'privacy_operation_conflict', reason: conflict().reason }),
        ),
});

const checkPartyValidity = Effect.fn('ConsentSelfServicePreparation.checkPartyValidity')(function* checkValidity(
  prepared: PreparedConsentAuthorityObservation,
): Effect.fn.Return<void, ConsentSelfServiceAuthorizationError> {
  const currentTime = yield* Clock.currentTimeMillis;
  if (currentTime >= prepared.deadline || currentTime < prepared.deadline - maximumPreparationLifetimeMilliseconds) {
    return yield* unavailable();
  }
  const now = DateTime.formatIso(yield* DateTime.now);
  for (const evidence of prepared.partyEvidence) {
    if (
      !isPrivacyInstantAtOrBefore(evidence.observedAt, now) ||
      evidence.typeAssertions.some(
        (assertion) =>
          !isPrivacyInstantAtOrBefore(assertion.validFrom, now) ||
          (assertion.validTo !== null && !isPrivacyInstantBefore(now, assertion.validTo)),
      )
    ) {
      return yield* unavailable();
    }
  }
  if (
    prepared.fact.kind === 'CURRENT_PROFILE_BINDING' &&
    (!isPrivacyInstantAtOrBefore(prepared.fact.bindingFreshness.observedAt, now) ||
      !isPrivacyInstantAtOrBefore(prepared.fact.permissionFreshness.observedAt, now))
  ) {
    return yield* unavailable();
  }
  return yield* Effect.void;
});

/** Closed exact-selector ports expose only this invocation's plain observed fact, never live HTTP. */
export const preparedConsentSelfServicePorts = (
  prepared: PreparedConsentAuthorityObservation,
): ConsentSelfServiceAuthorityPorts => {
  const sameRequest = (request: ConsentSelfServicePayload) =>
    Schema.toEquivalence(ConsentSelfServicePayloadSchema)(request, prepared.payload);
  const samePrincipal = (principal: { readonly principalId: string; readonly tenantId: string }) =>
    principal.principalId === prepared.context.scope.principalId &&
    principal.tenantId === prepared.context.scope.tenantId;
  return {
    resolveCurrentRetailPortalProfileBinding: Effect.fn('ConsentSelfServicePreparation.profile')(
      function* profile(input) {
        if (
          prepared.fact.kind !== 'CURRENT_PROFILE_BINDING' ||
          !samePrincipal(input.principalRef) ||
          !sameRequest(input.request) ||
          prepared.payload.path.kind !== 'CURRENT_PROFILE_BINDING' ||
          input.profileRef !== prepared.payload.path.profileRef
        ) {
          return yield* conflict();
        }
        yield* checkPartyValidity(prepared);
        return prepared.fact;
      },
    ),
    resolveSupportAuthority: Effect.fn('ConsentSelfServicePreparation.support')(function* support(input) {
      if (
        prepared.fact.kind !== 'SUPPORT_ASSISTED' ||
        !samePrincipal(input.principalRef) ||
        !sameRequest(input.request)
      ) {
        return yield* conflict();
      }
      yield* checkPartyValidity(prepared);
      return prepared.fact;
    }),
    verifyOperationCredential: Effect.fn('ConsentSelfServicePreparation.operation')(function* operation(input) {
      if (
        prepared.fact.kind !== 'OPERATION_SCOPED' ||
        !sameRequest(input.request) ||
        input.credentialRef !== prepared.fact.proofRef
      ) {
        return yield* conflict();
      }
      yield* checkPartyValidity(prepared);
      return prepared.fact;
    }),
  };
};

export const checkPreparedConsentAuthorityObservation = Effect.fn('ConsentSelfServicePreparation.checkAuthority')(
  function* checkAuthority(prepared: PreparedConsentAuthorityObservation): Effect.fn.Return<void, PreparationFailure> {
    const now = DateTime.formatIso(yield* DateTime.now);
    if (
      prepared.fact.kind === 'OPERATION_SCOPED' &&
      (!isPrivacyInstantAtOrBefore(prepared.fact.verifiedAt, now) ||
        !isPrivacyInstantBefore(now, prepared.fact.expiresAt))
    ) {
      return yield* new PrivacyActionRejected({
        code: 'privacy_action_rejected',
        reason: 'Consent self-service authorization denied: OPERATION_CONTEXT_EXPIRED',
      });
    }
    const authorization = yield* resolveAndAuthorizeConsentSelfService({
      now,
      ports: preparedConsentSelfServicePorts(prepared),
      principalRef: { principalId: prepared.context.scope.principalId, tenantId: prepared.context.scope.tenantId },
      request: prepared.payload,
    }).pipe(Effect.mapError(mapSelfServiceAuthorizationError));
    if (!authorization.allowed) {
      return yield* new PrivacyActionRejected({
        code: 'privacy_action_rejected',
        reason: `Consent self-service authorization denied: ${authorization.outcome}`,
      });
    }
    return yield* Effect.void;
  },
);

export const observeConsentSelfServicePreparation = Effect.fn('ConsentSelfServicePreparation.observe')(
  function* observe(input: {
    readonly context: PreparationContext;
    readonly deadline: number;
    readonly payload: ConsentSelfServicePayload;
    readonly snapshot: ConsentSelfServiceSnapshot;
  }): Effect.fn.Return<PreparedConsentAuthorityObservation, PreparationFailure, ConsentSelfServiceAuthority> {
    const { context, deadline } = input;
    const payload = structuredClone(input.payload);
    const snapshot = cloneSnapshot(input.snapshot);
    if (payload.scope.privacySubjectRef.tenantId !== context.scope.tenantId) {
      return yield* mapSelfServiceAuthorizationError(conflict());
    }
    const authority = yield* ConsentSelfServiceAuthority;
    const partyEvidence: PrivacySubjectOwnerEvidence[] = [];
    const ports =
      authority.forScope?.({
        compositionRevision: context.compositionRevision,
        observePartyEvidence: (evidence) => {
          partyEvidence.push(structuredClone(evidence));
        },
        scope: context.scope,
        subjects: snapshotSubjects(payload, context, snapshot),
      }) ?? authority.ports;
    const now = DateTime.formatIso(yield* DateTime.now);
    const principalRef = { principalId: context.scope.principalId, tenantId: context.scope.tenantId };
    let fact: TrustedConsentSelfServiceAuthorityFact;
    if (payload.path.kind === 'CURRENT_PROFILE_BINDING') {
      fact = yield* ports
        .resolveCurrentRetailPortalProfileBinding({
          principalRef,
          profileRef: payload.path.profileRef,
          request: structuredClone(payload),
        })
        .pipe(Effect.mapError(mapSelfServiceAuthorizationError));
    } else if (payload.path.kind === 'OPERATION_SCOPED') {
      fact = yield* ports
        .verifyOperationCredential({
          credentialRef: payload.path.credentialRef,
          now,
          request: structuredClone(payload),
        })
        .pipe(Effect.mapError(mapSelfServiceAuthorizationError));
    } else {
      fact = yield* ports
        .resolveSupportAuthority({ principalRef, request: structuredClone(payload) })
        .pipe(Effect.mapError(mapSelfServiceAuthorizationError));
    }
    const prepared = {
      context,
      deadline,
      fact: structuredClone(fact),
      partyEvidence: [...partyEvidence],
      payload,
      snapshot,
    };
    yield* checkPreparedConsentAuthorityObservation(prepared);
    return prepared;
  },
);

const sameConsentResolution = (left: ConsentCurrentResolution, right: ConsentCurrentResolution): boolean => {
  if (left.outcome === 'CURRENT' && right.outcome === 'CURRENT') {
    return Schema.toEquivalence(ConsentDecisionSchema)(left.decision, right.decision);
  }
  if (left.outcome === 'CONFLICT' && right.outcome === 'CONFLICT') {
    return (
      left.reason === right.reason &&
      Schema.toEquivalence(Schema.Array(ConsentDecisionSchema))(left.decisions, right.decisions)
    );
  }
  return left.outcome === 'ABSENT' && right.outcome === 'ABSENT';
};

export const validateConsentSelfServiceSnapshot = (
  prepared: PreparedConsentAuthorityObservation,
  current: ConsentSelfServiceSnapshot,
): Effect.Effect<void, PreparationFailure> => {
  const samePurpose =
    Option.isSome(prepared.snapshot.purpose) && Option.isSome(current.purpose)
      ? Schema.toEquivalence(ProcessingPurposeSchema)(prepared.snapshot.purpose.value, current.purpose.value)
      : Option.isNone(prepared.snapshot.purpose) && Option.isNone(current.purpose);
  return samePurpose &&
    sameConsentResolution(prepared.snapshot.consent, current.consent) &&
    Schema.toEquivalence(Schema.Array(PrivacySubjectRecordSchema))(prepared.snapshot.subjects, current.subjects)
    ? Effect.void
    : Effect.fail(mapSelfServiceAuthorizationError(conflict()));
};

/** Local reload and validity fences surround the original atomic write, including any uniqueness wait. */
export const preparedConsentSelfServiceServices = (
  prepared: PreparedConsentAuthorityObservation,
  repositories: {
    readonly operations: SubjectReaders & Pick<PrivacyOperationRepositoryService, 'recordConsentDecision'>;
    readonly purposes: Pick<ProcessingPurposeRepositoryService, 'get'>;
  },
): ConsentSelfServiceServices => ({
  authority: { ports: preparedConsentSelfServicePorts(prepared) },
  consentDecision: {
    get: repositories.purposes.get,
    recordConsentDecision: Effect.fn('ConsentSelfServicePreparation.record')(
      function* record(tenantId, legalEntityId, invocationId, decision) {
        if (
          tenantId !== prepared.context.scope.tenantId ||
          legalEntityId !== prepared.context.scope.legalEntityId ||
          invocationId !== prepared.context.actionInvocationId ||
          decision.decisionId !== `consent-self-service:${prepared.payload.path.requestRef}` ||
          decision.decision !== prepared.payload.decision ||
          !Schema.toEquivalence(ConsentScopeSchema)(decision.scope, prepared.payload.scope) ||
          !Schema.toEquivalence(Schema.Array(Schema.String))(
            decision.noticeEvidenceRefs,
            prepared.payload.noticeEvidenceRefs,
          ) ||
          decision.actorEvidence?.actor.principalId !== prepared.context.scope.principalId ||
          decision.actorEvidence.actor.tenantId !== prepared.context.scope.tenantId ||
          decision.actorEvidence.authMethod !== prepared.context.scope.authMethod
        ) {
          return yield* mapSelfServiceAuthorizationError(conflict());
        }
        const current = yield* loadConsentSelfServiceSnapshot(prepared.payload, prepared.context, repositories).pipe(
          Effect.catchTag('PrivacyActionScopeRequired', () =>
            Effect.fail(mapSelfServiceAuthorizationError(conflict())),
          ),
        );
        yield* validateConsentSelfServiceSnapshot(prepared, current);
        yield* checkPreparedConsentAuthorityObservation(prepared);
        const result = yield* repositories.operations.recordConsentDecision(
          tenantId,
          legalEntityId,
          invocationId,
          decision,
        );
        yield* checkPreparedConsentAuthorityObservation(prepared);
        return result;
      },
    ),
  },
});
