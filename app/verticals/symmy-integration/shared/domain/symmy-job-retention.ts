import { PrivacyMeasureHandoffSchema } from '@app/privacy/domain/privacy-measure-handoff';
import type { PrivacyMeasureHandoff } from '@app/privacy/domain/privacy-measure-handoff';
import { Schema } from 'effect';
import { TenantIdSchema } from '@app/core-runtime/auth/external-identity-contracts';
import { LegalEntityIdSchema } from '@app/core-runtime/access/ids';
import { SymmyJobIdSchema } from './symmy-job-identities.ts';
import { SymmyJobLifecyclePolicyRefSchema, SymmyLifecycleRouteIdSchema } from './symmy-job-notification.ts';

const uuid = Schema.String.check(Schema.isUUID());
export const SymmyJobRetentionPolicySchema = Schema.Struct({
  ...SymmyJobLifecyclePolicyRefSchema.fields,
  governanceLegalEntityId: LegalEntityIdSchema,
  retentionMs: Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(315_576_000_000)),
  routeId: SymmyLifecycleRouteIdSchema,
  targetLegalEntityId: Schema.OptionFromNullOr(LegalEntityIdSchema),
  tenantId: TenantIdSchema,
});
export type SymmyJobRetentionPolicy = typeof SymmyJobRetentionPolicySchema.Type;

export const SymmyJobLifecycleMetadataSchema = Schema.Struct({
  admittedAt: Schema.DateTimeUtcFromString,
  jobId: SymmyJobIdSchema,
  legalEntityId: Schema.OptionFromNullOr(LegalEntityIdSchema),
  originalAdmissionInvocationId: Schema.optionalKey(
    Schema.OptionFromNullOr(Schema.String.check(Schema.isUUID()).pipe(Schema.brand('ActionInvocationId'))),
  ),
  policy: Schema.OptionFromNullOr(SymmyJobLifecyclePolicyRefSchema),
  purged: Schema.Boolean,
  routeId: SymmyLifecycleRouteIdSchema,
});
export type SymmyJobLifecycleMetadata = typeof SymmyJobLifecycleMetadataSchema.Type;

export const SymmyJobRetentionAuthoritySchema = Schema.Struct({
  authorityReceiptRef: Schema.NonEmptyString,
  authorityRevision: Schema.NonEmptyString,
  contentScopeRef: Schema.NonEmptyString,
  resourceRef: Schema.NonEmptyString,
  status: Schema.Literal('CURRENT_APPROVED'),
});
export type SymmyJobRetentionAuthority = typeof SymmyJobRetentionAuthoritySchema.Type;

export const SymmyJobRetentionResultSchema = Schema.Literals(['PURGED', 'ALREADY_PURGED', 'BLOCKED']);
export type SymmyJobRetentionResult = typeof SymmyJobRetentionResultSchema.Type;

export const symmyJobResourceRef = (jobId: string): string => `integration.symmy.job:${jobId}`;
export const symmyJobIntentContentRef = (jobId: string): string =>
  `${symmyJobResourceRef(jobId)}#integration.symmy.job-intent`;

/** Only an exact approved operational-payload disposition can remove a whole completed job's intent. */
export const symmyJobIdForPrivacyHandoff = (handoff: PrivacyMeasureHandoff): string | undefined => {
  if (
    !Schema.is(PrivacyMeasureHandoffSchema)(handoff) ||
    handoff.owningCapability !== 'integration.symmy' ||
    (handoff.kind !== 'DELETE' && handoff.kind !== 'ANONYMIZE') ||
    handoff.dispositionDecision !== handoff.kind ||
    handoff.resourceRefs.length !== 1 ||
    handoff.contentScopeRefs.length !== 1
  ) {
    return undefined;
  }
  const [resourceRef] = handoff.resourceRefs;
  const jobId = resourceRef?.slice('integration.symmy.job:'.length);
  if (
    jobId === undefined ||
    !Schema.is(uuid)(jobId) ||
    resourceRef !== symmyJobResourceRef(jobId) ||
    handoff.contentScopeRefs[0] !== symmyJobIntentContentRef(jobId)
  ) {
    return undefined;
  }
  return jobId;
};

export const symmyRetentionTargetForPrivacyHandoff = (
  handoff: PrivacyMeasureHandoff,
): { readonly id: string; readonly kind: 'JOB' | 'SYNC' } | undefined => {
  const jobId = symmyJobIdForPrivacyHandoff(handoff);
  if (jobId !== undefined) {
    return { id: jobId, kind: 'JOB' };
  }
  const [resource] = handoff.resourceRefs;
  const prefix = 'integration.symmy.sync-admission:';
  if (resource === undefined || !resource.startsWith(prefix)) {
    return undefined;
  }
  const id = resource.slice(prefix.length);
  if (
    !Schema.is(uuid)(id) ||
    handoff.owningCapability !== 'integration.symmy' ||
    (handoff.kind !== 'DELETE' && handoff.kind !== 'ANONYMIZE') ||
    handoff.dispositionDecision !== handoff.kind ||
    handoff.resourceRefs.length !== 1 ||
    handoff.contentScopeRefs.length !== 1 ||
    handoff.contentScopeRefs[0] !== `${resource}#integration.symmy.job-intent`
  ) {
    return undefined;
  }
  return { id, kind: 'SYNC' };
};
