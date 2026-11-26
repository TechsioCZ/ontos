import { PrivacyMeasureHandoffSchema } from '@app/privacy/domain/privacy-measure-handoff';
import { Option, Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import {
  SymmyJobRetentionPolicySchema,
  SYMMY_DEMO_MEMBERSHIP_RETENTION,
  symmyRetentionPolicyMatchesRoute,
  symmyRetentionTargetForPrivacyHandoff,
} from '../../shared/domain/symmy-job-retention.ts';
import { SymmyFixtureExecutionPlanSchema } from '../../shared/domain/symmy-job-execution.ts';
import { SymmyRouteEnrollmentRequestSchema, symmyRetentionRefusals } from '../../src/ops/symmy-route-enrollment.ts';

const id = '10000000-0000-4000-8000-000000000003';
const handoff = Schema.decodeUnknownSync(PrivacyMeasureHandoffSchema)({
  contentScopeRefs: [`integration.symmy.job:${id}#integration.symmy.job-intent`],
  controllerObligationRef: null,
  dispositionDecision: 'DELETE',
  expectedEvidenceRefs: [],
  idempotencyKey: 'internal-disposition-key',
  kind: 'DELETE',
  measureId: 'internal-measure',
  owningCapability: 'integration.symmy',
  preconditionRefs: [],
  requestedAt: '2026-11-07T00:00:00.000Z',
  requestedResult: 'Remove the approved operational payload',
  resourceRefs: [`integration.symmy.job:${id}`],
  right: 'ERASURE',
  sourceDecisionRef: 'internal-decision',
  sourceDecisionRevision: 1,
  subjectRef: 'internal-subject',
  taskId: 'internal-task',
  tenantId: 'internal-tenant',
});

it('requires an exact job-qualified content disposition rather than a generic payload permission', () => {
  expect(symmyRetentionTargetForPrivacyHandoff(handoff)).toEqual({ id, kind: 'JOB' });
  expect(
    symmyRetentionTargetForPrivacyHandoff({ ...handoff, contentScopeRefs: ['integration.symmy.job-intent'] }),
  ).toBeUndefined();
  expect(
    symmyRetentionTargetForPrivacyHandoff({
      ...handoff,
      contentScopeRefs: [`integration.symmy.job:10000000-0000-4000-8000-000000000099#integration.symmy.job-intent`],
    }),
  ).toBeUndefined();
});

it('keeps synchronous admission identity separate while requiring the same exact native disposition scope', () => {
  const resourceRef = `integration.symmy.sync-admission:${id}`;
  expect(
    symmyRetentionTargetForPrivacyHandoff({
      ...handoff,
      contentScopeRefs: [`${resourceRef}#integration.symmy.job-intent`],
      resourceRefs: [resourceRef],
    }),
  ).toEqual({ id, kind: 'SYNC' });
  expect(symmyRetentionTargetForPrivacyHandoff({ ...handoff, resourceRefs: [resourceRef] })).toBeUndefined();
});

it('rejects foreign owners, multiple resources and mismatched disposition kinds', () => {
  expect(symmyRetentionTargetForPrivacyHandoff({ ...handoff, owningCapability: 'party.registry' })).toBeUndefined();
  expect(
    symmyRetentionTargetForPrivacyHandoff({
      ...handoff,
      resourceRefs: [...handoff.resourceRefs, ...handoff.resourceRefs],
    }),
  ).toBeUndefined();
  expect(symmyRetentionTargetForPrivacyHandoff({ ...handoff, dispositionDecision: 'RETAIN' })).toBeUndefined();
  expect(symmyRetentionTargetForPrivacyHandoff({ ...handoff, kind: 'RECTIFY' })).toBeUndefined();
});

it('requires explicit target absence and a concrete governance company in external policy configuration', () => {
  const encoded = {
    governanceLegalEntityId: id,
    policyId: 'internal-retention',
    retentionMs: 60_000,
    revision: 'v1',
    routeId: id,
    targetLegalEntityId: null,
    tenantId: id,
  };
  const decode = Schema.decodeUnknownSync(SymmyJobRetentionPolicySchema);
  const encode = Schema.encodeSync(SymmyJobRetentionPolicySchema);
  const tenantPolicy = decode(encoded);
  expect(Option.isNone(tenantPolicy.targetLegalEntityId)).toBe(true);
  expect(encode(tenantPolicy)).toEqual(encoded);
  const companyPolicy = decode({ ...encoded, targetLegalEntityId: id });
  expect(Option.getOrNull(companyPolicy.targetLegalEntityId)).toBe(id);
  expect(encode(companyPolicy)).toEqual({ ...encoded, targetLegalEntityId: id });
  const { targetLegalEntityId: _target, ...missingTarget } = encoded;
  const { governanceLegalEntityId: _governance, ...missingGovernance } = encoded;
  expect(() => decode(missingTarget)).toThrow();
  expect(() => decode(missingGovernance)).toThrow();
});

const demo = SYMMY_DEMO_MEMBERSHIP_RETENTION;
const demoFamilyPolicy = {
  governanceLegalEntityId: demo.companyId,
  policyId: demo.policyId,
  retentionMs: 60_000,
  revision: demo.revision,
  routeFamily: 'DEMO_GROUP_MEMBERSHIP',
  routeId: demo.enrollmentRouteId,
  targetLegalEntityId: demo.companyId,
  tenantId: demo.tenantId,
} satisfies typeof SymmyJobRetentionPolicySchema.Encoded;
const demoRoute = () => ({
  fixturePlan: Schema.decodeUnknownSync(SymmyFixtureExecutionPlanSchema)({
    items: [
      {
        effects: [
          {
            effectKey: 'operation-0',
            operation: {
              entrypointKey: 'commerce.customer-context.apply-customer-group-membership-source',
              moduleId: 'commerce.customer-context',
              schemaVersion: '1',
            },
          },
        ],
        itemKey: 'source-template',
        source: {
          entityKind: 'CUSTOMER_GROUP',
          issuerId: demo.issuer,
          sourceNamespace: demo.namespace,
          sourceRecordId: 'ENROLLMENT_TEMPLATE',
        },
      },
    ],
    selector: {
      kind: 'CUSTOMER_GROUP',
      source: {
        entityKind: 'CUSTOMER_GROUP',
        issuerId: demo.issuer,
        route: { integrationRouteId: demo.sourceRouteId, tenantId: demo.tenantId },
        sourceNamespace: demo.namespace,
        sourceRecordId: 'created-after-boot',
      },
      target: {
        moduleId: 'commerce.customer-context',
        resourceId: id,
        resourceType: 'commerce.customer-context.customer-group',
        tenantId: demo.tenantId,
      },
    },
    sourceMappingVersion: demo.revision,
    sourceRouteId: demo.sourceRouteId,
    sourceRouteRevision: demo.revision,
  }),
  legalEntityId: demo.companyId,
  routeId: id,
  routeKey: 'customerGroupCustomersBatch',
  tenantId: demo.tenantId,
});

it('authorizes new demo membership route IDs under one explicit source-family retention policy', () => {
  const policy = Schema.decodeUnknownSync(SymmyJobRetentionPolicySchema)(demoFamilyPolicy);
  expect(symmyRetentionPolicyMatchesRoute(policy, demoRoute())).toBe(true);
  expect(
    symmyRetentionPolicyMatchesRoute(policy, {
      ...demoRoute(),
      routeId: '10000000-0000-4000-8000-000000000099',
    }),
  ).toBe(true);
});

it('keeps the physical retention policy while matching the enrolled logical group source', () => {
  const policy = Schema.decodeUnknownSync(SymmyJobRetentionPolicySchema)(demoFamilyPolicy);
  const route = demoRoute();
  const logicalSource = '5a6fb39a-c26e-4186-9dc2-5e410210d36c';
  const plan = Schema.decodeUnknownSync(SymmyFixtureExecutionPlanSchema)({
    ...route.fixturePlan,
    selector: {
      ...route.fixturePlan.selector,
      source: {
        ...route.fixturePlan.selector?.source,
        route: { integrationRouteId: logicalSource, tenantId: demo.tenantId },
      },
    },
    sourceRouteId: logicalSource,
  });
  expect(policy.routeId).toBe('f637a6ec-865b-43bc-9c28-57783757f367');
  expect(symmyRetentionPolicyMatchesRoute(policy, { ...route, fixturePlan: plan })).toBe(true);
  const physicalSourcePlan = Schema.decodeUnknownSync(SymmyFixtureExecutionPlanSchema)({
    ...plan,
    selector: {
      ...plan.selector,
      source: {
        ...plan.selector?.source,
        route: { integrationRouteId: policy.routeId, tenantId: demo.tenantId },
      },
    },
    sourceRouteId: policy.routeId,
  });
  expect(symmyRetentionPolicyMatchesRoute(policy, { ...route, fixturePlan: physicalSourcePlan })).toBe(false);
});

it('uses the same family policy when bootstrapping or verifying a new membership route', () => {
  const route = demoRoute();
  const request = Schema.decodeUnknownSync(SymmyRouteEnrollmentRequestSchema)({
    configuration: route.fixturePlan,
    legalEntityId: route.legalEntityId,
    lifecyclePolicy: { policyId: demo.policyId, revision: demo.revision },
    mappingVersion: demo.revision,
    principalId: '10000000-0000-4000-8000-000000000009',
    routeCode: 'created-after-boot',
    routeId: route.routeId,
    routeKey: route.routeKey,
    routeRevision: demo.revision,
    tenantId: route.tenantId,
  });
  const policy = Schema.decodeUnknownSync(SymmyJobRetentionPolicySchema)(demoFamilyPolicy);
  expect(symmyRetentionRefusals(request, [policy])).toEqual([]);
  expect(symmyRetentionRefusals(request, [policy, policy])).toHaveLength(1);
});

it('does not extend family retention to another tenant, company, source, route kind or unselected group', () => {
  const policy = Schema.decodeUnknownSync(SymmyJobRetentionPolicySchema)(demoFamilyPolicy);
  const route = demoRoute();
  expect(symmyRetentionPolicyMatchesRoute(policy, { ...route, tenantId: id })).toBe(false);
  expect(symmyRetentionPolicyMatchesRoute(policy, { ...route, legalEntityId: id })).toBe(false);
  expect(symmyRetentionPolicyMatchesRoute(policy, { ...route, routeKey: 'customersBatch' })).toBe(false);
  const { sourceRouteId: _source, ...withoutSource } = route.fixturePlan;
  const { selector: _selector, ...withoutSelector } = route.fixturePlan;
  expect(
    symmyRetentionPolicyMatchesRoute(policy, {
      ...route,
      fixturePlan: withoutSource,
    }),
  ).toBe(false);
  expect(
    symmyRetentionPolicyMatchesRoute(policy, {
      ...route,
      fixturePlan: withoutSelector,
    }),
  ).toBe(false);
});

it('refuses external family policy configuration for any source or company outside the demo', () => {
  const decode = Schema.decodeUnknownResult(SymmyJobRetentionPolicySchema);
  for (const wrong of [
    { ...demoFamilyPolicy, tenantId: id },
    { ...demoFamilyPolicy, routeId: id },
    { ...demoFamilyPolicy, governanceLegalEntityId: id },
    { ...demoFamilyPolicy, targetLegalEntityId: id },
    { ...demoFamilyPolicy, policyId: 'an-unapproved-family' },
  ]) {
    expect(Result.isFailure(decode(wrong))).toBe(true);
  }
});
