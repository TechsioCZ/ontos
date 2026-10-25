import { Schema } from 'effect';

const Uuid = Schema.String.check(Schema.isUUID());
const PrincipalId = Uuid.pipe(Schema.brand('PrincipalId'));
const optionalDetail = Schema.optionalKey(Schema.OptionFromNullOr(Schema.String));
const optionalPrincipal = Schema.optionalKey(Schema.OptionFromNullOr(PrincipalId));

export const IdentityAdministrationAuditInputSchema = Schema.Struct({
  subjects: Schema.Literals(['agents', 'people']),
});

/** Finite scalar display evidence only; profile objects, operator sets and credentials never leave Core. */
export const IdentityAdministrationAuditDetailsSchema = Schema.Struct({
  agentPrincipalId: optionalPrincipal,
  audience: optionalDetail,
  context: optionalDetail,
  correlationId: optionalDetail,
  description: optionalDetail,
  displayName: optionalDetail,
  email: optionalDetail,
  legalEntityId: Schema.optionalKey(Schema.OptionFromNullOr(Uuid.pipe(Schema.brand('LegalEntityId')))),
  newRoleKey: optionalDetail,
  newRoleLabel: optionalDetail,
  newStatus: optionalDetail,
  operation: optionalDetail,
  ownerPrincipalId: optionalPrincipal,
  previousRoleKey: optionalDetail,
  previousRoleLabel: optionalDetail,
  previousStatus: optionalDetail,
  principalKind: optionalDetail,
  reason: optionalDetail,
  revokedConnections: optionalDetail,
  subjectType: optionalDetail,
  targetPrincipalId: optionalPrincipal,
  writePolicy: optionalDetail,
});

export const IdentityAdministrationAuditEntrySchema = Schema.Struct({
  actorName: Schema.OptionFromNullOr(Schema.String),
  auditEventId: Uuid.pipe(Schema.brand('AuditEventId')),
  details: IdentityAdministrationAuditDetailsSchema,
  eventType: Schema.Literals([
    'action.executed',
    'action.rejected',
    'identity.agent_operators_changed',
    'authn.rejected',
  ]),
  occurredAt: Schema.DateTimeUtcFromString,
  outcome: Schema.Literals(['allowed', 'denied', 'succeeded', 'failed']),
  outcomeCode: Schema.String,
  targetName: Schema.OptionFromNullOr(Schema.String),
});
export const IdentityAdministrationAuditResultSchema = Schema.Struct({
  entries: Schema.Array(IdentityAdministrationAuditEntrySchema).check(Schema.isMaxLength(80)),
});
export type IdentityAdministrationAuditResult = typeof IdentityAdministrationAuditResultSchema.Type;

const nullableText = Schema.optionalKey(Schema.Union([Schema.String, Schema.Null]));
export const IdentityAdministrationAuditEvidenceSchema = Schema.Struct({
  actionKey: Schema.optionalKey(
    Schema.Literals([
      'core.identity.configure-agent',
      'core.identity.manage-agent-status',
      'core.identity.manage-demo-account',
      'core.identity.replace-agent-operators',
    ]),
  ),
  agentPrincipalId: nullableText,
  audience: nullableText,
  context: nullableText,
  correlationId: nullableText,
  description: nullableText,
  displayName: nullableText,
  email: nullableText,
  legalEntityId: nullableText,
  newRoleKey: nullableText,
  newRoleLabel: nullableText,
  newStatus: nullableText,
  operation: nullableText,
  ownerPrincipalId: nullableText,
  previousRoleKey: nullableText,
  previousRoleLabel: nullableText,
  previousStatus: nullableText,
  principalKind: nullableText,
  reason: nullableText,
  revokedConnections: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null, Schema.Finite])),
  subjectType: nullableText,
  targetPrincipalId: nullableText,
  writePolicy: nullableText,
});

/** Persisted rows may contain richer native evidence. Decode a whitelist, not a generic JSON capability. */
export const identityAdministrationAuditDetails = (
  evidence: typeof IdentityAdministrationAuditEvidenceSchema.Type,
  eventType: string,
  principalId: string | null,
) => {
  const details = new Map<string, string | null>();
  const isDetail = Schema.is(Schema.Union([Schema.String, Schema.Null]));
  for (const [key, value] of Object.entries(evidence)) {
    if (key !== 'actionKey' && isDetail(value)) {
      details.set(key, value);
    }
  }
  if (evidence.actionKey === 'core.identity.replace-agent-operators') {
    details.set('operation', 'replace-agent-operators');
    if (Schema.is(Schema.Finite)(evidence.revokedConnections)) {
      details.set('revokedConnections', String(evidence.revokedConnections));
    }
  }
  if (eventType === 'authn.rejected' && principalId !== null) {
    details.set('targetPrincipalId', principalId);
  }
  if (
    !Schema.is(Schema.String)(details.get('targetPrincipalId')) &&
    Schema.is(Schema.String)(evidence.agentPrincipalId)
  ) {
    details.set('targetPrincipalId', evidence.agentPrincipalId);
  }
  return Schema.decodeEffect(IdentityAdministrationAuditDetailsSchema)(Object.fromEntries(details));
};
