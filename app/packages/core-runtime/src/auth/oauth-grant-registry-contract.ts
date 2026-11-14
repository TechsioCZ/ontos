import { Schema } from 'effect';

/** Core-owned retained issuer facts; no transport or Auth SQL types cross this boundary. */
export const OAuthGrantModulesSchema = Schema.Union([
  Schema.Literal('all'),
  Schema.Array(
    Schema.Struct({
      access: Schema.Literals(['read', 'write']),
      moduleId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120)).pipe(
        Schema.brand('OAuthGrantModuleId'),
      ),
    }),
  ).check(Schema.isMaxLength(100)),
]);
export type OAuthGrantModules = typeof OAuthGrantModulesSchema.Type;
export const OAuthGrantStatusSchema = Schema.Literals(['draft', 'active', 'denied', 'revoked', 'superseded']);
export const OAuthGrantRevokeReasonSchema = Schema.Literals([
  'user',
  'admin',
  'superseded',
  'operator_removed',
  'agent_disabled',
  'user_disabled',
  'password_changed',
]);
export const OAuthGrantWritePolicySchema = Schema.Literals(['read_only', 'approval', 'direct']);
/** Owns the grant vocabulary stored in unconstrained text and JSON columns. */
export const OAuthGrantRecordFactsSchema = Schema.Struct({
  actingKind: Schema.Literals(['human', 'agent']),
  clientKind: Schema.Literals(['cimd', 'loopback']),
  modules: OAuthGrantModulesSchema,
  revokeReason: Schema.OptionFromNullOr(OAuthGrantRevokeReasonSchema),
  status: OAuthGrantStatusSchema,
  writePolicy: OAuthGrantWritePolicySchema,
});
/** Retained storage facts intentionally retain SQL nulls; absence of a lookup uses Option. */
export interface OAuthGrantRecord {
  readonly actingKind: typeof OAuthGrantRecordFactsSchema.Type.actingKind;
  readonly actingPrincipalId: string;
  readonly authBindingId: string | null;
  readonly clientHost: string;
  readonly clientId: string;
  readonly clientKind: typeof OAuthGrantRecordFactsSchema.Type.clientKind;
  readonly clientLogoUri: string | null;
  readonly clientName: string;
  readonly consentedAt: Date | null;
  readonly consentId: string | null;
  readonly createdAt: Date;
  readonly grantId: string;
  readonly lastUsedAt: Date | null;
  readonly legalEntityId: string;
  readonly modules: OAuthGrantModules;
  readonly profileId: string;
  readonly revokedAt: Date | null;
  readonly revokedByPrincipalId: string | null;
  readonly revokeReason: typeof OAuthGrantRevokeReasonSchema.Type | null;
  readonly sessionId: string | null;
  readonly status: typeof OAuthGrantStatusSchema.Type;
  readonly tenantId: string;
  readonly userId: string;
  readonly userPrincipalId: string;
  readonly writePolicy: typeof OAuthGrantWritePolicySchema.Type;
}
export type OAuthGrantDraft = Omit<
  OAuthGrantRecord,
  | 'authBindingId'
  | 'consentId'
  | 'consentedAt'
  | 'createdAt'
  | 'grantId'
  | 'lastUsedAt'
  | 'revokeReason'
  | 'revokedAt'
  | 'revokedByPrincipalId'
  | 'status'
>;
export interface OAuthGrantKey {
  readonly actingPrincipalId: string;
  readonly clientId: string;
  readonly legalEntityId: string;
  readonly userId: string;
}
export interface OAuthGrantListFilter {
  readonly actingPrincipalId?: string;
  readonly clientId?: string;
  readonly legalEntityId?: string;
  readonly statuses?: readonly OAuthGrantRecord['status'][];
  readonly tenantId: string;
  readonly userId?: string;
  readonly userPrincipalId?: string;
}
export interface OAuthGrantStatusChange {
  readonly grantId: string;
  readonly revokedByPrincipalId: string | null;
  readonly revokeReason: OAuthGrantRecord['revokeReason'];
  readonly status: 'denied' | 'revoked' | 'superseded';
}
export interface OAuthGrantAccessChange {
  readonly grantId: string;
  readonly modules: OAuthGrantModules;
  readonly writePolicy: OAuthGrantRecord['writePolicy'];
}
export interface OAuthGrantBindingStatusChange {
  readonly authBindingId: string;
  readonly status: 'active' | 'disabled';
  readonly tenantId: string;
}
export interface OAuthGrantBindingKey {
  readonly authBindingId: string;
  readonly tenantId: string;
}
export interface OAuthGrantSession {
  readonly sessionId: string;
  readonly userId: string;
}
export interface OAuthGrantApproval {
  readonly actorPrincipalId: string;
  readonly grant: OAuthGrantRecord;
}
export interface OAuthGrantActivation {
  readonly active: OAuthGrantRecord;
  readonly superseded: readonly OAuthGrantRecord[];
}
export interface OAuthGrantPrincipal {
  readonly displayName: string;
  readonly kind: string;
  readonly status: string;
}
