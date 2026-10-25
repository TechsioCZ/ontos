import { and, desc, eq } from 'drizzle-orm';
import { Effect, Schema } from 'effect';

import { IdentityPersistenceUnavailableError } from '../../auth/principal-management-errors.ts';
import { actionInvocations, auditEvents, domainEvents } from '../../db/schema.ts';
import type { ScopedTransactionExecutor } from '../../db/scoped-transaction.ts';
import {
  OutboxPayloadSchema,
  outboxProducerModuleKey,
  outboxTopic,
} from '../../outbox/core-identity-principal-lifecycle-changed-v1.ts';

export const replaceAgentOperatorsActionKey = 'core.identity.replace-agent-operators';
const PrincipalIdSchema = Schema.String.check(Schema.isUUID(), Schema.isPattern(/^[0-9a-f-]+$/u)).pipe(
  Schema.brand('AgentOperatorPrincipalId'),
  Schema.decodeTo(Schema.String),
);
const LegalEntityIdSchema = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand('AgentOperatorLegalEntityId'),
  Schema.decodeTo(Schema.String),
);
// The complete desired set plus Core's execution metadata must fit the 4 KiB audit envelope.
const OperatorIdsSchema = Schema.Array(PrincipalIdSchema).check(
  Schema.isMaxLength(64),
  Schema.makeFilter((ids) => (new Set(ids).size === ids.length ? undefined : 'An operator may occur only once')),
);
const RevisionSchema = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER - 1),
);
export const ReplaceAgentOperatorsPayloadSchema = Schema.Struct({
  agentPrincipalId: PrincipalIdSchema,
  context: Schema.Literals(['agent-created', 'operators-edited']),
  expectedRevision: RevisionSchema,
  operatorPrincipalIds: OperatorIdsSchema,
  revokedConnections: Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(0),
    Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
  ),
});
export type ReplaceAgentOperatorsPayload = typeof ReplaceAgentOperatorsPayloadSchema.Type;
export const ReplaceAgentOperatorsAuditEvidenceSchema = Schema.Struct({
  agentPrincipalId: PrincipalIdSchema,
  context: ReplaceAgentOperatorsPayloadSchema.fields.context,
  desiredOperatorPrincipalIds: OperatorIdsSchema,
  legalEntityId: LegalEntityIdSchema,
  previousRevision: RevisionSchema,
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)),
  revokedConnections: ReplaceAgentOperatorsPayloadSchema.fields.revokedConnections,
});
export type AgentOperatorCommand = typeof ReplaceAgentOperatorsAuditEvidenceSchema.Type;
export const ReplaceAgentOperatorsResultSchema = Schema.Struct({
  agentPrincipalId: PrincipalIdSchema,
  projection: Schema.Literal('pending'),
  revision: ReplaceAgentOperatorsAuditEvidenceSchema.fields.revision,
});
export type ReplaceAgentOperatorsResult = typeof ReplaceAgentOperatorsResultSchema.Type;
const CommittedEvidenceSchema = Schema.Struct({
  ...ReplaceAgentOperatorsAuditEvidenceSchema.fields,
  actionKey: Schema.Literal(replaceAgentOperatorsActionKey),
});
const invalidEvidence = (cause?: unknown) =>
  Object.defineProperty(
    new IdentityPersistenceUnavailableError({
      code: 'identity_persistence_unavailable',
      reason: 'The latest committed agent operator command is invalid',
    }),
    'cause',
    { value: cause },
  );

/** Validate the latest row, never fall back to older evidence after corruption. */
export const decodeCommittedAgentOperatorCommand = Effect.fn('AgentOperatorCommand.decodeCommitted')(
  function* decodeCommitted(input: {
    readonly agentPrincipalId: string;
    readonly auditCompanyId: string | null;
    readonly eventCompanyId: string | null;
    readonly evidence: unknown;
    readonly invocationActionKey: string | null;
    readonly invocationCompanyId: string | null;
    readonly payload: unknown;
  }) {
    const evidence = yield* Schema.decodeUnknownEffect(CommittedEvidenceSchema)(input.evidence).pipe(
      Effect.mapError(invalidEvidence),
    );
    const payload = yield* Schema.decodeUnknownEffect(OutboxPayloadSchema, { onExcessProperty: 'error' })(
      input.payload,
    ).pipe(Effect.mapError(invalidEvidence));
    if (
      input.invocationActionKey !== replaceAgentOperatorsActionKey ||
      evidence.agentPrincipalId !== input.agentPrincipalId ||
      payload.data.principalId !== input.agentPrincipalId ||
      evidence.legalEntityId !== input.auditCompanyId ||
      evidence.legalEntityId !== input.eventCompanyId ||
      evidence.legalEntityId !== input.invocationCompanyId ||
      evidence.revision !== evidence.previousRevision + 1
    ) {
      return yield* invalidEvidence();
    }
    return {
      agentPrincipalId: evidence.agentPrincipalId,
      context: evidence.context,
      desiredOperatorPrincipalIds: evidence.desiredOperatorPrincipalIds,
      legalEntityId: evidence.legalEntityId,
      previousRevision: evidence.previousRevision,
      revision: evidence.revision,
      revokedConnections: evidence.revokedConnections,
    } satisfies AgentOperatorCommand;
  },
);

/**
 * Private Core SQL capability shared by command handling, governed directory reads and projection.
 * The caller holds the target row lock when issuing a command, or principal serialization when projecting.
 * Operators are principal-global: deliberately do NOT filter by selected company.
 */
export const readLatestAgentOperatorCommand = Effect.fn('AgentOperatorCommand.readLatest')(function* readLatest(
  transaction: Pick<ScopedTransactionExecutor, 'select'>,
  tenantId: string,
  agentPrincipalId: string,
) {
  const [latest] = yield* transaction
    .select({
      auditCompanyId: auditEvents.legalEntityId,
      eventCompanyId: domainEvents.legalEntityId,
      evidence: auditEvents.evidenceJson,
      invocationActionKey: actionInvocations.actionKey,
      invocationCompanyId: actionInvocations.legalEntityId,
      payload: domainEvents.payloadJson,
    })
    .from(domainEvents)
    .innerJoin(
      actionInvocations,
      and(
        eq(actionInvocations.tenantId, domainEvents.tenantId),
        eq(actionInvocations.actionInvocationId, domainEvents.actionInvocationId),
        eq(actionInvocations.actionKey, replaceAgentOperatorsActionKey),
        eq(actionInvocations.status, 'succeeded'),
      ),
    )
    .leftJoin(
      auditEvents,
      and(
        eq(auditEvents.tenantId, domainEvents.tenantId),
        eq(auditEvents.actionInvocationId, domainEvents.actionInvocationId),
        eq(auditEvents.eventType, 'action.executed'),
        eq(auditEvents.outcome, 'succeeded'),
        eq(auditEvents.outcomeStage, 'execution'),
        eq(auditEvents.auditProfile, 'sensitive'),
      ),
    )
    .where(
      and(
        eq(domainEvents.tenantId, tenantId),
        eq(domainEvents.eventType, outboxTopic),
        eq(domainEvents.producerModuleKey, outboxProducerModuleKey),
        eq(domainEvents.subjectModuleKey, outboxProducerModuleKey),
        eq(domainEvents.subjectResourceType, 'principal'),
        eq(domainEvents.subjectResourceId, agentPrincipalId),
      ),
    )
    .orderBy(desc(domainEvents.tenantSequenceNo))
    .limit(1)
    .pipe(Effect.mapError(invalidEvidence));
  if (latest === undefined) {
    return null;
  }
  return yield* decodeCommittedAgentOperatorCommand({ ...latest, agentPrincipalId });
});
