import { PrivacyMeasureHandoffSchema } from '@app/privacy/domain/privacy-measure-handoff';
import type { PrivacyMeasureHandoff } from '@app/privacy/domain/privacy-measure-handoff';
import { Option, Schema } from 'effect';
import { TenantIdSchema } from '@app/core-runtime/auth/external-identity-contracts';
import { LegalEntityIdSchema } from '@app/core-runtime/access/ids';
import { SymmyJobIdSchema } from './symmy-job-identities.ts';
import { SymmyJobLifecyclePolicyRefSchema, SymmyLifecycleRouteIdSchema } from './symmy-job-notification.ts';
import type { SymmyFixtureExecutionPlan } from './symmy-job-execution.ts';

export const SYMMY_DEMO_MEMBERSHIP_RETENTION = {
  companyId: 'c0c78a3e-6e2a-57e0-9d0d-86253499fee7',
  enrollmentRouteId: 'f637a6ec-865b-43bc-9c28-57783757f367',
  issuer: 'symmy-akros',
  namespace: 'akros-erp',
  policyId: 'akros-symmy-memberships',
  revision: 'v1',
  sourceRouteId: '5a6fb39a-c26e-4186-9dc2-5e410210d36c',
  tenantId: 'bceaa540-13eb-5508-9ac0-9ed7e40a2ee9',
} as const;

const uuid = Schema.String.check(Schema.isUUID());
export const SymmyJobRetentionPolicySchema = Schema.Struct({
  ...SymmyJobLifecyclePolicyRefSchema.fields,
  governanceLegalEntityId: LegalEntityIdSchema,
  retentionMs: Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(315_576_000_000)),
  routeId: SymmyLifecycleRouteIdSchema,
  routeFamily: Schema.optionalKey(Schema.Literal('DEMO_GROUP_MEMBERSHIP')),
  targetLegalEntityId: Schema.OptionFromNullOr(LegalEntityIdSchema),
  tenantId: TenantIdSchema,
}).check(
  Schema.makeFilter((policy) => {
    const demo = SYMMY_DEMO_MEMBERSHIP_RETENTION;
    return (
      policy.routeFamily === undefined ||
      (policy.tenantId === demo.tenantId &&
        policy.routeId === demo.enrollmentRouteId &&
        policy.governanceLegalEntityId === demo.companyId &&
        Option.getOrNull(policy.targetLegalEntityId) === demo.companyId &&
        policy.policyId === demo.policyId &&
        policy.revision === demo.revision) ||
      'Demo membership retention is restricted to the enrolled AKROS source and company'
    );
  }),
);
export type SymmyJobRetentionPolicy = typeof SymmyJobRetentionPolicySchema.Type;

interface RetainedRoute {
  readonly tenantId: string;
  readonly legalEntityId: string | null;
  readonly routeId: string;
  readonly routeKey: string;
  readonly fixturePlan: SymmyFixtureExecutionPlan | null;
}

/** A standing demo family policy applies only to real selected routes of its exact enrolled source. */
export const symmyRetentionPolicyMatchesRoute = (policy: SymmyJobRetentionPolicy, route: RetainedRoute): boolean => {
  if (policy.routeFamily === undefined) {
    return policy.tenantId === route.tenantId && policy.routeId === route.routeId;
  }
  const demo = SYMMY_DEMO_MEMBERSHIP_RETENTION;
  const plan = route.fixturePlan;
  const selector = plan?.selector;
  return (
    route.tenantId === demo.tenantId &&
    policy.tenantId === demo.tenantId &&
    policy.routeId === demo.enrollmentRouteId &&
    route.legalEntityId === demo.companyId &&
    route.routeKey === 'customerGroupCustomersBatch' &&
    plan?.sourceRouteId === demo.sourceRouteId &&
    plan.sourceRouteRevision === demo.revision &&
    plan.sourceMappingVersion === demo.revision &&
    selector?.kind === 'CUSTOMER_GROUP' &&
    selector.source.route.tenantId === demo.tenantId &&
    selector.source.route.integrationRouteId === demo.sourceRouteId &&
    selector.source.issuerId === demo.issuer &&
    selector.source.sourceNamespace === demo.namespace &&
    selector.target?.tenantId === demo.tenantId &&
    plan.items.every(({ source }) => source.issuerId === demo.issuer && source.sourceNamespace === demo.namespace)
  );
};
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
