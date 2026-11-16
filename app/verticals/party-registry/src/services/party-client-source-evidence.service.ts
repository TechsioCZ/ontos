import { readScopedAdmittedWorkload } from '@app/core-runtime/access/enforcement';
import type { OperationalScope, ScopedTransactionExecutor, TrustedPrincipalContext } from '@app/core-runtime';
import { readVerifiedGatewayWorkload } from '@app/core-runtime/auth/system-principal-context-provenance';
import { checkPartyClientSourcePrivacy } from './party-client-source-privacy.service.ts';
import { and, eq, isNotNull, ne, or, sql } from 'drizzle-orm';
import { Config, Context, DateTime, Effect, Option, Schema } from 'effect';

import {
  PartyClientSourceIdentitySchema,
  PartySubjectEvidenceListSchema,
  PartyEvidenceInsufficient,
  PartyPersistenceUnavailable,
} from '../../shared/domain/identity-contracts.ts';
import type {
  PartyClientSourceAssertion,
  PartyPersistenceUnavailableError,
  PartySubjectEvidence,
} from '../../shared/domain/identity-contracts.ts';
import { partyMatchDecisions } from '../db/schema.ts';
import type { PartyTransaction } from '../db/types.ts';

const binding = Schema.Struct({
  ...PartyClientSourceIdentitySchema.fields,
  authMethod: Schema.Literals(['api_key', 'system']),
  principalId: Schema.String.check(Schema.isUUID()),
  tenantId: Schema.String.check(Schema.isUUID()),
});
const configuredSources = Config.schema(
  Schema.fromJsonString(Schema.Array(binding).check(Schema.isMaxLength(1024))),
  'ONTOS_PARTY_CLIENT_SOURCE_BINDINGS',
).pipe(Config.withDefault([]));

export interface PartyClientSourceScope {
  readonly authMethod: TrustedPrincipalContext['authMethod'];
  readonly principalId: string;
  readonly tenantId: string;
  readonly legalEntityId?: string;
}

export type PartyClientSourceReference = Pick<PartyClientSourceAssertion, 'source' | 'recordId' | 'occurrenceId'>;

export type PartySourceCreateTarget =
  | { readonly kind: 'PARTY'; readonly partyId: string }
  | { readonly kind: 'DUPLICATE_CANDIDATE'; readonly caseId: string };

export type SourceIntent =
  | { readonly operation: 'CREATE' | 'MATCH'; readonly target?: PartySourceCreateTarget }
  | { readonly operation: 'RECOVER_CREATE'; readonly target: PartySourceCreateTarget }
  | {
      readonly operation:
        | 'UPDATE'
        | 'CORRECTION'
        | 'ONBOARD_COUNTERPARTY_CUSTOMER'
        | 'ADD_CONTACT_POINT'
        | 'UPDATE_CONTACT_POINT'
        | 'END_CONTACT_POINT';
      readonly partyId: string;
    }
  | {
      readonly operation:
        | 'REVIEW'
        | 'EVIDENCE_READ'
        | 'MATCH_PREVIEW'
        | 'PROFILE_EXPORT'
        | 'ORGANIZATION_BUSINESS_NAME_EXPORT';
      readonly target?: PartySourceCreateTarget;
    };

/** Test/host seam for the governed current Privacy check; production uses the public Privacy capability. */
export class PartyClientSourcePrivacy extends Context.Service<
  PartyClientSourcePrivacy,
  {
    readonly checkImport: (input: {
      readonly assertion: PartyClientSourceReference;
      readonly scope: PartyClientSourceScope;
      readonly intent: SourceIntent;
    }) => Effect.Effect<'ALLOWED' | 'DENIED' | 'ORGANIZATION_BUSINESS_ALLOWED', PartyPersistenceUnavailableError>;
  }
>()('@app/party-registry/services/party-client-source-evidence.service/PartyClientSourcePrivacy') {}

export const clientSourceAssertion = (evidence: readonly PartySubjectEvidence[] | undefined) =>
  evidence?.find((item): item is PartyClientSourceAssertion => item.kind === 'CLIENT_SOURCE_ASSERTION');

const evidenceDenied = (reason: string) =>
  new PartyEvidenceInsufficient({ code: 'party_evidence_insufficient', reason });
const unavailable = (cause?: unknown) =>
  Object.assign(
    new PartyPersistenceUnavailable({
      code: 'party_persistence_unavailable',
      reason: 'Party client-source authority or correlation is unavailable',
    }),
    { cause },
  );

/** Source enrollment is a native fact check, not a Privacy allowance or a business permission. */
export const requirePartyClientSourceEnrollment = Effect.fn('PartyClientSourceEvidence.requireEnrollment')(
  function* requireEnrollment(
    assertion: Pick<PartyClientSourceReference, 'source'>,
    scope: PartyClientSourceScope,
    reviewing = false,
  ) {
    const { issuer, namespace, recordType, routeRef } = assertion.source;
    const bindings = yield* configuredSources.pipe(Effect.mapError(unavailable));
    const match = bindings.some(
      (grant) =>
        ((reviewing && (scope.authMethod === 'session' || scope.authMethod === 'support_impersonation')) ||
          (grant.authMethod === scope.authMethod && grant.principalId === scope.principalId)) &&
        grant.tenantId === scope.tenantId &&
        grant.issuer === issuer &&
        grant.namespace === namespace &&
        grant.recordType === recordType &&
        grant.routeRef === routeRef,
    );
    if (!match) {
      return yield* evidenceDenied('client_source_not_authorized');
    }
  },
);

export const authorizePartyClientSourceReferenceWithProjection = Effect.fn(
  'PartyClientSourceEvidence.authorizeReferenceWithProjection',
)(function* authorizeReference(
  assertion: PartyClientSourceReference,
  scope: PartyClientSourceScope,
  intent: SourceIntent,
) {
  yield* requirePartyClientSourceEnrollment(
    assertion,
    scope,
    intent.operation === 'REVIEW' ||
      intent.operation === 'EVIDENCE_READ' ||
      intent.operation === 'PROFILE_EXPORT' ||
      intent.operation === 'ORGANIZATION_BUSINESS_NAME_EXPORT',
  );
  const privacy = yield* Effect.serviceOption(PartyClientSourcePrivacy);
  const outcome = yield* Option.isSome(privacy)
    ? privacy.value.checkImport({ assertion, scope, intent })
    : checkPartyClientSourcePrivacy({ assertion, scope, intent });
  if (outcome !== 'ALLOWED' && outcome !== 'ORGANIZATION_BUSINESS_ALLOWED') {
    return yield* evidenceDenied('client_source_privacy_denied');
  }
  return outcome === 'ORGANIZATION_BUSINESS_ALLOWED';
});
export const authorizePartyClientSourceReference = (
  assertion: PartyClientSourceReference,
  scope: PartyClientSourceScope,
  intent: SourceIntent,
) => authorizePartyClientSourceReferenceWithProjection(assertion, scope, intent).pipe(Effect.asVoid);

/** Core binds the actual chosen machine branch to this exact transaction and scope. */
export const requireAdmittedPartySourceReference = Effect.fn('PartyClientSourceEvidence.requireAdmittedReference')(
  function* requireAdmittedReference(
    transaction: ScopedTransactionExecutor,
    scope: OperationalScope,
    reference: PartyClientSourceReference | undefined,
  ) {
    if (reference !== undefined) {
      return;
    }
    const admitted = yield* readScopedAdmittedWorkload(transaction, scope, 'party.registry.source-write').pipe(
      Effect.mapError(unavailable),
    );
    if (admitted) {
      return yield* evidenceDenied('client_source_assertion_required');
    }
  },
);

/** The source workload never reaches the ordinary actor/manual write branch. */
export const requirePartySourceReferenceForWorkload = (
  reference: PartyClientSourceReference | undefined,
  scope: PartyClientSourceScope,
) =>
  readVerifiedGatewayWorkload(scope)?.workloadKey === 'party.registry.source-write' && reference === undefined
    ? Effect.fail(evidenceDenied('client_source_assertion_required'))
    : Effect.void;

export const authorizePartyEvidenceWithProjection = Effect.fn('PartyClientSourceEvidence.authorizeWithProjection')(
  function* authorize(
    evidence: readonly PartySubjectEvidence[] | undefined,
    scope: PartyClientSourceScope,
    intent: SourceIntent,
  ) {
    if (
      evidence?.some((item) => item.kind === 'MANUAL_DECLARATION') === true &&
      scope.authMethod !== 'session' &&
      scope.authMethod !== 'support_impersonation'
    ) {
      return yield* evidenceDenied('manual_declaration_requires_authenticated_actor');
    }
    const assertion = clientSourceAssertion(evidence);
    yield* requirePartySourceReferenceForWorkload(assertion, scope);
    if (assertion === undefined) {
      return;
    }
    if (evidence?.length !== 1) {
      return yield* evidenceDenied('one_client_source_assertion_required');
    }
    const now = yield* DateTime.now;
    if (DateTime.Order(assertion.sourceObservedAt, now) > 0) {
      return yield* evidenceDenied('client_source_observation_is_future');
    }
    return yield* authorizePartyClientSourceReferenceWithProjection(assertion, scope, intent);
  },
);
export const authorizePartyEvidence = (
  evidence: readonly PartySubjectEvidence[] | undefined,
  scope: PartyClientSourceScope,
  intent: SourceIntent,
) => authorizePartyEvidenceWithProjection(evidence, scope, intent).pipe(Effect.asVoid);

/** A historical source snapshot is decoded and reauthorized for the current protected operation. */
export const requireSupportedPartyEvidenceOperation = (
  evidence: readonly { readonly kind: string }[] | undefined,
  operation: 'UPDATE' | 'CORRECTION' | 'REVIEW' | 'MATCH_PREVIEW' | 'EVIDENCE_READ',
  scope?: PartyClientSourceScope,
  target?: PartySourceCreateTarget,
) => {
  if (evidence?.some((item) => item.kind === 'CLIENT_SOURCE_ASSERTION') !== true) {
    return Effect.void;
  }
  if (scope === undefined || operation === 'UPDATE' || operation === 'CORRECTION') {
    return Effect.fail(unavailable());
  }
  const decoded = Schema.is(Schema.toType(PartySubjectEvidenceListSchema))(evidence)
    ? Effect.succeed(evidence)
    : Schema.decodeUnknownEffect(PartySubjectEvidenceListSchema)(evidence).pipe(Effect.mapError(unavailable));
  return decoded.pipe(
    Effect.flatMap((currentEvidence) =>
      authorizePartyEvidence(currentEvidence, scope, target === undefined ? { operation } : { operation, target }),
    ),
    Effect.mapError(unavailable),
  );
};

const sourceDecisionEvidence = (assertion: PartyClientSourceAssertion, exactOccurrence: boolean) => {
  const { issuer, namespace, recordType, routeRef } = assertion.source;
  const source = sql`jsonb_build_object('issuer', ${issuer}::text, 'namespace', ${namespace}::text, 'recordType', ${recordType}::text, 'routeRef', ${routeRef}::text)`;
  const occurrence = exactOccurrence
    ? sql` || jsonb_build_object('occurrenceId', ${assertion.occurrenceId}::text)`
    : sql``;
  return sql`${partyMatchDecisions.evidenceEvaluation}->'evidence' @> jsonb_build_array(jsonb_build_object('kind', 'CLIENT_SOURCE_ASSERTION', 'source', ${source}, 'recordId', ${assertion.recordId}::text)${occurrence})`;
};

/** Bounded target metadata for governed organization processing; stored source evidence is only a SQL predicate. */
export const findPartySourceTargetMetadata = Effect.fn('PartyClientSourceEvidence.findTargetMetadata')(
  function* findTargetMetadata(
    transaction: Pick<PartyTransaction, 'select'>,
    tenantId: string,
    assertion: PartyClientSourceAssertion,
    exactOccurrence: boolean,
    operation: 'CREATE' | 'MATCH' = 'CREATE',
  ) {
    const identity = and(
      eq(partyMatchDecisions.tenantId, tenantId),
      exactOccurrence
        ? eq(partyMatchDecisions.operation, operation)
        : or(isNotNull(partyMatchDecisions.committedCreateOutcome), eq(partyMatchDecisions.operation, 'REVIEW_MATCH')),
      sourceDecisionEvidence(assertion, exactOccurrence),
    );
    const [decision, additional] = yield* transaction
      .select({
        partyId: partyMatchDecisions.partyId,
        matchDecisionId: partyMatchDecisions.matchDecisionId,
        actionInvocationId: partyMatchDecisions.actionInvocationId,
        matchRuleVersion: partyMatchDecisions.matchRuleVersion,
        operation: partyMatchDecisions.operation,
        outcome: partyMatchDecisions.outcome,
        committedCreateOutcome: partyMatchDecisions.committedCreateOutcome,
        candidateCaseId: partyMatchDecisions.candidateCaseId,
        candidateFingerprint: partyMatchDecisions.candidateFingerprint,
        sourceInputFingerprint: sql<
          string | null
        >`${partyMatchDecisions.evidenceEvaluation}->>'sourceInputFingerprint'`,
      })
      .from(partyMatchDecisions)
      .where(
        and(
          identity,
          exactOccurrence ? eq(partyMatchDecisions.operation, operation) : isNotNull(partyMatchDecisions.partyId),
        ),
      )
      .orderBy(partyMatchDecisions.decidedAt, partyMatchDecisions.matchDecisionId)
      .limit(exactOccurrence ? 2 : 1)
      .pipe(Effect.mapError(unavailable));
    if (additional !== undefined) {
      return yield* evidenceDenied('client_source_receipt_ambiguous');
    }
    if (!exactOccurrence && decision !== undefined && decision.partyId !== null) {
      const [conflicting] = yield* transaction
        .select({ matchDecisionId: partyMatchDecisions.matchDecisionId })
        .from(partyMatchDecisions)
        .where(and(identity, ne(partyMatchDecisions.partyId, decision.partyId)))
        .limit(1)
        .pipe(Effect.mapError(unavailable));
      if (conflicting !== undefined) {
        return yield* evidenceDenied('client_source_party_target_ambiguous');
      }
    }
    return decision;
  },
);

/** These are the existing Party decisions, so no secondary Party identity registry is needed.
 * The caller holds the tenant identity-write lock when establishing a new correlation. */
export const findPartySourceDecision = Effect.fn('PartyClientSourceEvidence.findDecision')(function* findDecision(
  transaction: Pick<PartyTransaction, 'select'>,
  tenantId: string,
  assertion: PartyClientSourceAssertion,
  exactOccurrence: boolean,
) {
  const identity = and(
    eq(partyMatchDecisions.tenantId, tenantId),
    or(isNotNull(partyMatchDecisions.committedCreateOutcome), eq(partyMatchDecisions.operation, 'REVIEW_MATCH')),
    sourceDecisionEvidence(assertion, exactOccurrence),
  );
  const [decision, additional] = yield* transaction
    .select()
    .from(partyMatchDecisions)
    .where(
      and(
        identity,
        exactOccurrence ? eq(partyMatchDecisions.operation, 'CREATE') : isNotNull(partyMatchDecisions.partyId),
      ),
    )
    .orderBy(partyMatchDecisions.decidedAt, partyMatchDecisions.matchDecisionId)
    .limit(exactOccurrence ? 2 : 1)
    .pipe(Effect.mapError(unavailable));
  if (additional !== undefined) {
    return yield* evidenceDenied('client_source_receipt_ambiguous');
  }
  if (!exactOccurrence && decision?.partyId !== undefined && decision.partyId !== null) {
    const [conflicting] = yield* transaction
      .select({ matchDecisionId: partyMatchDecisions.matchDecisionId })
      .from(partyMatchDecisions)
      .where(and(identity, ne(partyMatchDecisions.partyId, decision.partyId)))
      .limit(1)
      .pipe(Effect.mapError(unavailable));
    if (conflicting !== undefined) {
      return yield* evidenceDenied('client_source_party_target_ambiguous');
    }
  }
  return decision;
});

/** Source Match decisions remain owner decisions, never a second Party correlation registry. */
export const findPartySourceMatchDecision = Effect.fn('PartyClientSourceEvidence.findMatchDecision')(
  function* findSourceMatch(
    transaction: Pick<PartyTransaction, 'select'>,
    tenantId: string,
    assertion: PartyClientSourceAssertion,
  ) {
    const rows = yield* transaction
      .select()
      .from(partyMatchDecisions)
      .where(
        and(
          eq(partyMatchDecisions.tenantId, tenantId),
          eq(partyMatchDecisions.operation, 'MATCH'),
          sourceDecisionEvidence(assertion, true),
        ),
      )
      .orderBy(partyMatchDecisions.decidedAt, partyMatchDecisions.matchDecisionId)
      .limit(2)
      .pipe(Effect.mapError(unavailable));
    const [row, additional] = rows;
    if (additional !== undefined) {
      return yield* evidenceDenied('client_source_receipt_ambiguous');
    }
    return row;
  },
);
