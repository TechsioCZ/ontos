import {
  AuthorizationMutationStateSchema,
  PrincipalRefSchema as CorePrincipalRefSchema,
} from '@app/core-runtime';
import type { PrincipalRef as CorePrincipalRef } from '@app/core-runtime';
import { CounterpartyRefSchema as PartyCounterpartyRefSchema } from '@app/party-registry/resources/counterparty';
import type { CounterpartyRef as PartyCounterpartyRef } from '@app/party-registry/resources/counterparty';
import { DateTime, Option, Schema, SchemaGetter } from 'effect';
import { CounterpartyPermissionCodeSchema } from './permission-catalog.ts';
import { CounterpartyCommerceAccessGrantRefSchema } from '../resources/counterparty-commerce-access-grant.ts';

const uuid = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand('CounterpartyAccessAuditPrincipalId'),
  Schema.decodeTo(Schema.String),
);
const boundedText = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(500));
const resourceId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300)).pipe(
  Schema.brand('CounterpartyAccessAuditResourceId'),
  Schema.decodeTo(Schema.String),
);
const storefrontKey = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)).pipe(
  Schema.brand('CounterpartyPermissionStorefrontKey'),
  Schema.decodeTo(Schema.String),
);

const AccessInstantDecodedSchema = Schema.String.check(
  Schema.makeFilter((value) => {
    const parsed = DateTime.make(value);
    return Option.isSome(parsed) && DateTime.formatIso(parsed.value) === value
      ? undefined
      : 'must be one canonical UTC instant with millisecond precision';
  }),
).pipe(
  Schema.decodeTo(Schema.toType(Schema.DateTimeUtc), {
    decode: SchemaGetter.transform(DateTime.makeUnsafe),
    encode: SchemaGetter.transform(DateTime.formatIso),
  }),
);
export const AccessInstantSchema = Schema.toEncoded(AccessInstantDecodedSchema);
export type AccessInstant = typeof AccessInstantSchema.Type;

export const CounterpartyRefSchema = PartyCounterpartyRefSchema;
export type CounterpartyRef = PartyCounterpartyRef;

export const PrincipalRefSchema = CorePrincipalRefSchema;
export type PrincipalRef = CorePrincipalRef;

export const CounterpartyPermissionScopeSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('counterparty') }),
  Schema.Struct({
    kind: Schema.Literal('storefront'),
    storefrontKey,
  }),
]);
export type CounterpartyPermissionScope = typeof CounterpartyPermissionScopeSchema.Type;

export const CounterpartyAccessJournalStateSchema = AuthorizationMutationStateSchema;
export type CounterpartyAccessJournalState = typeof CounterpartyAccessJournalStateSchema.Type;

export const CounterpartyAccessGrantSchema = Schema.Struct({
  catalogVersion: Schema.Literal('1'),
  counterpartyRef: CounterpartyRefSchema,
  grantedAt: AccessInstantSchema,
  grantedBy: PrincipalRefSchema,
  grantRef: CounterpartyCommerceAccessGrantRefSchema,
  permission: CounterpartyPermissionCodeSchema,
  reason: Schema.optionalKey(boundedText),
  recipient: PrincipalRefSchema,
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  revokedAt: Schema.optionalKey(AccessInstantSchema),
  revokedBy: Schema.optionalKey(PrincipalRefSchema),
  scope: CounterpartyPermissionScopeSchema,
  state: CounterpartyAccessJournalStateSchema,
});
export type CounterpartyAccessGrant = typeof CounterpartyAccessGrantSchema.Type;

export const CounterpartyAccessDecisionSchema = Schema.Literals([
  'ALLOWED',
  'DENIED',
  'UNAVAILABLE',
]);
export type CounterpartyAccessDecision = typeof CounterpartyAccessDecisionSchema.Type;

export const AccessAuditEvidenceSchema = Schema.Struct({
  actorPrincipalId: uuid,
  claimAttestationReference: Schema.optionalKey(boundedText),
  counterpartyId: resourceId,
  invitationId: Schema.optionalKey(resourceId),
  outcome: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
  permission: Schema.optionalKey(CounterpartyPermissionCodeSchema),
  reason: Schema.optionalKey(boundedText),
  scopeKind: Schema.Literals(['counterparty', 'storefront']),
  storefrontKey: Schema.optionalKey(storefrontKey),
  targetPrincipalId: Schema.optionalKey(uuid),
});
export type AccessAuditEvidence = typeof AccessAuditEvidenceSchema.Type;

const AccessDenialOperationSchema = Schema.Literals(['grant', 'revoke', 'invite', 'bootstrap']);
const AccessDenialRecipientSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal('principal'),
    principalId: uuid,
  }),
  Schema.Struct({
    invitationId: resourceId,
    kind: Schema.Literal('invitation'),
  }),
  Schema.Struct({
    deliveryMethod: Schema.Literals(['VERIFIED_CONTACT_POINT', 'APPROVED_RECIPIENT_DISCOVERY']),
    kind: Schema.Literal('delivery'),
  }),
]);

/** Safe fields captured before authorization/policy denial; no delivery or proof secret is allowed. */
export const AccessDeniedAuditEvidenceSchema = Schema.Struct({
  actorPrincipalId: uuid,
  counterpartyId: resourceId,
  invitationId: Schema.optionalKey(resourceId),
  operation: AccessDenialOperationSchema,
  permission: Schema.optionalKey(CounterpartyPermissionCodeSchema),
  recipient: AccessDenialRecipientSchema,
  requestedPermissions: Schema.optionalKey(Schema.Array(CounterpartyPermissionCodeSchema)),
  requestedScope: CounterpartyPermissionScopeSchema,
});
export type AccessDeniedAuditEvidence = typeof AccessDeniedAuditEvidenceSchema.Type;

export const scopeContains = (
  grantScope: CounterpartyPermissionScope,
  requestedScope: CounterpartyPermissionScope,
): boolean =>
  grantScope.kind === 'counterparty' ||
  (requestedScope.kind === 'storefront' &&
    grantScope.kind === 'storefront' &&
    grantScope.storefrontKey === requestedScope.storefrontKey);

export const decideCounterpartyPermission = (
  grants: readonly CounterpartyAccessGrant[],
  input: {
    readonly counterpartyRef: CounterpartyRef;
    readonly permission: typeof CounterpartyPermissionCodeSchema.Type;
    readonly principalRef: PrincipalRef;
    readonly scope: CounterpartyPermissionScope;
  },
): CounterpartyAccessDecision => {
  if (input.principalRef.tenantId !== input.counterpartyRef.tenantId) {
    return 'DENIED';
  }
  const matching = grants.filter(
    (grant) =>
      grant.counterpartyRef.tenantId === input.counterpartyRef.tenantId &&
      grant.counterpartyRef.resourceId === input.counterpartyRef.resourceId &&
      grant.recipient.principalId === input.principalRef.principalId &&
      grant.recipient.tenantId === input.principalRef.tenantId &&
      grant.permission === input.permission &&
      scopeContains(grant.scope, input.scope),
  );
  if (matching.some(({ state }) => state === 'ACTIVE')) {
    return 'ALLOWED';
  }
  if (matching.some(({ state }) => state === 'RECONCILIATION_REQUIRED')) {
    return 'UNAVAILABLE';
  }
  return 'DENIED';
};

export const canRevokeAdministratorGrant = (
  grants: readonly CounterpartyAccessGrant[],
  targetGrantRef: typeof CounterpartyCommerceAccessGrantRefSchema.Type,
): boolean => {
  const target = grants.find(
    ({ grantRef }) =>
      grantRef.resourceId === targetGrantRef.resourceId &&
      grantRef.tenantId === targetGrantRef.tenantId,
  );
  if (target?.permission !== 'counterparty.access.manage' || target.state !== 'ACTIVE') {
    return true;
  }
  return grants.some(
    (grant) =>
      grant.grantRef.resourceId !== targetGrantRef.resourceId &&
      grant.counterpartyRef.resourceId === target.counterpartyRef.resourceId &&
      grant.counterpartyRef.tenantId === target.counterpartyRef.tenantId &&
      grant.permission === 'counterparty.access.manage' &&
      grant.state === 'ACTIVE',
  );
};
