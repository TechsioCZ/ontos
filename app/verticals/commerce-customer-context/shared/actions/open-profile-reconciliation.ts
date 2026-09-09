import { Schema } from 'effect';
import {
  CommerceCustomerProfileSubjectSchema,
  ProfileBoundedKeySchema,
  ProfileInstantSchema,
} from '../domain/profile-contracts.ts';
import { CommerceCustomerProfileRefSchema } from '../domain/profile-decisions.ts';
import { ProfileReconciliationCaseRefSchema } from '../resources/profile-reconciliation-case.ts';

const RevisionSchema = Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1));
const EventVersionSchema = Schema.toEncoded(
  Schema.BigIntFromString.check(Schema.isGreaterThanOrEqualToBigInt(1n)),
);

export const ProfileReconciliationCanonicalizationEvidenceSchema = Schema.Union([
  Schema.Struct({
    evidenceKind: Schema.Literal('PARTY_OWNER_OBSERVATION'),
    observedAt: ProfileInstantSchema,
    policyVersion: ProfileBoundedKeySchema,
    sourceDomainEventId: ProfileBoundedKeySchema,
    sourceEventVersion: EventVersionSchema,
    sourceMessageId: ProfileBoundedKeySchema,
    sourceOwnerModuleId: Schema.Literal('party.registry'),
  }),
  Schema.Struct({
    decisionRef: ProfileBoundedKeySchema,
    evidenceKind: Schema.Literal('AUTHORIZED_OPERATOR_DECISION'),
    observedAt: ProfileInstantSchema,
    policyVersion: ProfileBoundedKeySchema,
  }),
]);
export type ProfileReconciliationCanonicalizationEvidence =
  typeof ProfileReconciliationCanonicalizationEvidenceSchema.Type;

export const OpenProfileReconciliationPayloadSchema = Schema.Struct({
  canonicalizationEvidence: ProfileReconciliationCanonicalizationEvidenceSchema,
  detectedAt: ProfileInstantSchema,
  evidenceRef: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(300)),
  profileRefs: Schema.Array(CommerceCustomerProfileRefSchema).check(Schema.isMinLength(2)),
  reason: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(500)),
  targetSubject: CommerceCustomerProfileSubjectSchema,
  trigger: Schema.Literals([
    'PARTY_ALIAS',
    'COUNTERPARTY_ALIAS',
    'CREATE_COLLISION',
    'IMPORT_CORRELATION',
  ]),
}).check(
  Schema.makeFilter(({ canonicalizationEvidence, trigger }) =>
    canonicalizationEvidence.evidenceKind === 'AUTHORIZED_OPERATOR_DECISION' &&
    trigger !== 'CREATE_COLLISION' &&
    trigger !== 'IMPORT_CORRELATION'
      ? 'Only create/import correlation may use an authorized operator decision'
      : undefined,
  ),
  Schema.makeFilter(({ profileRefs, targetSubject }) =>
    profileRefs.every(
      (profileRef) =>
        profileRef.kind === targetSubject.kind &&
        profileRef.tenantId ===
          (targetSubject.kind === 'RETAIL'
            ? targetSubject.partyRef.tenantId
            : targetSubject.counterpartyRef.tenantId),
    )
      ? undefined
      : 'Every reconciliation member must match the target subject kind and Tenant',
  ),
);
export type OpenProfileReconciliationPayload = typeof OpenProfileReconciliationPayloadSchema.Type;

export const OpenProfileReconciliationResultSchema = Schema.Struct({
  caseRef: ProfileReconciliationCaseRefSchema,
  outcome: Schema.Literals(['RECONCILIATION_OPENED', 'RECONCILIATION_ALREADY_OPEN']),
  revision: RevisionSchema,
  state: Schema.Literal('OPEN'),
});
export type OpenProfileReconciliationResult = typeof OpenProfileReconciliationResultSchema.Type;

export class ProfileReconciliationActionRejected extends Schema.TaggedError<ProfileReconciliationActionRejected>()(
  'ProfileReconciliationActionRejected',
  {
    code: Schema.Literals([
      'PROFILE_NOT_FOUND',
      'CROSS_LEGAL_ENTITY_RECONCILIATION_FORBIDDEN',
      'RECONCILIATION_NOT_FOUND',
      'RECONCILIATION_INCOMPLETE',
      'RECONCILIATION_OUT_OF_ORDER',
      'CURRENT_STATE_CONFLICT',
      'DEPENDENCY_UNAVAILABLE',
      'PERSISTENCE_UNAVAILABLE',
      'OUTCOME_INDETERMINATE',
    ]),
    reason: Schema.String,
    retryable: Schema.Boolean,
  },
) {}
