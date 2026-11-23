import {
  RegisteredGatewayRouteScopeSchema,
  RegisteredGatewayWorkloadSchema,
  trustVerifiedGatewayPrincipalContext,
} from '@app/core-runtime/auth/system-principal-context-provenance';
import { getReadHandler } from '@app/core-runtime/testing/reads';
import { TestClock } from 'effect/testing';
import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { Effect, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  SourceProcessingEligibilityRequestSchema,
  SourceProcessingEligibilityResponseSchema,
} from '../../shared/apis/source-processing-eligibility.ts';
import { DemoSourceProcessingPolicySchema } from '../../shared/domain/demo-source-processing-policy.ts';
import {
  demoSourceProcessingPolicyMatches,
  sourceProcessingEligibilityRead,
  evaluateSourceProcessingEligibility,
} from '../../src/api/source-processing-eligibility.read.ts';
import type { SourceProcessingEligibilityServices } from '../../src/api/source-processing-eligibility.read.ts';

const policy = Schema.decodeUnknownSync(DemoSourceProcessingPolicySchema)({
  active: true,
  callers: [{ authMethod: 'api_key', principalId: '72000000-0000-4000-8000-000000000021' }],
  customerRouteId: '5158ef08-7315-57e1-a9ed-b0fef8cd9ac1',
  dataUse: 'DEMO_TEST_DATA_ONLY',
  effectiveFrom: '2026-11-23T00:00:00.000Z',
  groupRouteId: 'f637a6ec-865b-43bc-9c28-57783757f367',
  issuer: 'symmy-akros',
  legalEntityId: 'c0c78a3e-6e2a-57e0-9d0d-86253499fee7',
  namespace: 'akros-erp',
  policyId: 'akros-symmy-demo-test-data',
  purpose: 'DEMO_CUSTOMER_IMPORT_TESTING',
  reason: 'Operator-approved synthetic import testing',
  revision: 'v1',
  tenantId: 'bceaa540-13eb-5508-9ac0-9ed7e40a2ee9',
  validUntil: '2026-12-23T00:00:00.000Z',
});
const scope = {
  ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    authBindingId: '72000000-0000-4000-8000-000000000025',
    authContextRef: 'demo:test:actual-caller',
    authMethod: 'api_key',
    legalEntityId: policy.legalEntityId,
    principalId: '72000000-0000-4000-8000-000000000021',
    tenantId: policy.tenantId,
  }),
  correlationId: 'demo-test',
};
const request = Schema.decodeUnknownSync(SourceProcessingEligibilityRequestSchema)({
  consumerModuleId: 'integration.symmy',
  operation: 'CUSTOMER_SOURCE_INTAKE',
  source: {
    issuer: policy.issuer,
    namespace: policy.namespace,
    occurrenceId: 'first-occurrence',
    recordId: 'customer-not-known-at-bootstrap',
    recordType: 'CUSTOMER',
    routeRef: policy.customerRouteId,
  },
  target: null,
});
const at = '2026-11-23T01:00:00.000Z';
const services = (protectedScope = false): SourceProcessingEligibilityServices => ({
  contexts: [],
  demo: { hasScopeProtections: () => Effect.succeed(protectedScope), policy },
  protections: () => Effect.succeed({ items: [], sourceSubjectRefs: [] }),
  purposes: { get: () => Effect.succeed(Option.none()) },
  repository: {
    listApplicabilityDecisions: () => Effect.succeed([]),
    listApplicabilityPolicies: () => Effect.succeed([]),
    resolveEligibilityInputs: () => Effect.die('Demo testing does not fabricate legal basis inputs'),
  },
  subjectExists: () => Effect.succeed(false),
});

it.effect(
  'authorizes two previously unseen customer records and occurrences without inventing a subject or consent',
  () =>
    Effect.gen(function* test() {
      for (const recordId of ['unseen-person-1', 'unseen-person-2']) {
        const exactRequest = {
          ...request,
          source:
            request.source === null
              ? null
              : {
                  ...request.source,
                  recordId,
                  occurrenceId: `new-${recordId}`,
                },
        };
        const result = yield* evaluateSourceProcessingEligibility(exactRequest, scope, services(), at);
        expect(result.outcome).toBe('ALLOWED');
        expect(Schema.is(SourceProcessingEligibilityResponseSchema)(result)).toBe(true);
        if (result.outcome === 'ALLOWED' && '_tag' in result.evidence) {
          expect(result.evidence._tag).toBe('DEMO_TEST_DATA_SOURCE_POLICY');
          expect(result.evidence.source.recordId).toBe(recordId);
          expect('subjectRef' in result.evidence).toBe(false);
          expect('consent' in result.evidence).toBe(false);
        }
      }
    }),
);

it.effect('fails closed on expired, paused or protected source-wide testing authority', () =>
  Effect.gen(function* test() {
    expect((yield* evaluateSourceProcessingEligibility(request, scope, services(), policy.validUntil)).outcome).toBe(
      'DENIED',
    );
    expect(
      (yield* evaluateSourceProcessingEligibility(
        request,
        scope,
        {
          ...services(),
          demo: { policy: { ...policy, active: false }, hasScopeProtections: () => Effect.succeed(false) },
        },
        at,
      )).outcome,
    ).toBe('DENIED');
    expect(yield* evaluateSourceProcessingEligibility(request, scope, services(true), at)).toEqual({
      evaluatedAt: at,
      outcome: 'DENIED',
      reason: 'PROTECTED_MATERIAL',
    });
  }),
);

it('cannot enroll another tenant, company, issuer or data-use declaration', () => {
  const valid = Schema.is(DemoSourceProcessingPolicySchema);
  expect(valid({ ...policy, tenantId: '70000000-0000-4000-8000-000000000020' })).toBe(false);
  expect(valid({ ...policy, legalEntityId: '71000000-0000-4000-8000-000000000024' })).toBe(false);
  expect(valid({ ...policy, issuer: 'other-source' })).toBe(false);
  expect(valid({ ...policy, dataUse: 'REAL_CUSTOMER_RECORDS' })).toBe(false);
});

it('never extends source enrollment to another principal, company, namespace or unlisted operation', () => {
  expect(demoSourceProcessingPolicyMatches(policy, request, scope)).toBe(true);
  expect(
    demoSourceProcessingPolicyMatches(policy, request, {
      ...scope,
      principalId: Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
        ...scope,
        principalId: '72000000-0000-4000-8000-000000000026',
      }).principalId,
    }),
  ).toBe(false);
  expect(demoSourceProcessingPolicyMatches(policy, request, { ...scope, legalEntityId: undefined })).toBe(false);
  expect(
    demoSourceProcessingPolicyMatches(
      policy,
      {
        ...request,
        source:
          request.source === null
            ? null
            : {
                ...request.source,
                namespace: 'foreign-source',
              },
      },
      scope,
    ),
  ).toBe(false);
  expect(demoSourceProcessingPolicyMatches(policy, { ...request, operation: 'DELETE_ALL_CUSTOMERS' }, scope)).toBe(
    false,
  );
});

it.effect('leaves ordinary exact-context authorization closed when no demo policy is installed', () =>
  Effect.gen(function* test() {
    const { demo: _demo, ...ordinary } = services();
    expect((yield* evaluateSourceProcessingEligibility(request, scope, ordinary, at)).outcome).toBe('DENIED');
  }),
);

it('separates group intake records from owner membership records on the same enrolled route', () => {
  const matches = (
    consumerModuleId: 'integration.symmy' | 'commerce.customer-context',
    operation: string,
    recordType: string,
    routeRef: string = policy.groupRouteId,
  ) =>
    demoSourceProcessingPolicyMatches(
      policy,
      Schema.decodeUnknownSync(SourceProcessingEligibilityRequestSchema)({
        ...request,
        consumerModuleId,
        operation,
        source: { ...request.source, recordType, routeRef },
      }),
      scope,
    );
  expect(matches('integration.symmy', 'CUSTOMER_SOURCE_INTAKE', 'CUSTOMER_GROUP')).toBe(true);
  expect(matches('integration.symmy', 'CUSTOMER_SOURCE_INTAKE', 'CUSTOMER_GROUP_MEMBERSHIP')).toBe(false);
  for (const operation of ['customer-group-membership.write', 'customer-group-membership.recover']) {
    expect(matches('commerce.customer-context', operation, 'CUSTOMER_GROUP_MEMBERSHIP')).toBe(true);
    expect(matches('commerce.customer-context', operation, 'CUSTOMER_GROUP')).toBe(false);
    expect(matches('commerce.customer-context', operation, 'CUSTOMER_GROUP_MEMBERSHIP', policy.customerRouteId)).toBe(
      false,
    );
  }
});

it.effect(
  'requires the matching source module on the sealed Privacy receiver even when no delegated actor exists',
  () =>
    Effect.gen(function* test() {
      yield* TestClock.setTime(Date.parse(at));
      const principal = Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
        authMethod: 'system',
        authContextRef: 'job:privacy:run:demo',
        principalId: scope.principalId,
        tenantId: scope.tenantId,
      });
      const receiver = { ...principal, correlationId: scope.correlationId, legalEntityId: scope.legalEntityId };
      const owner = Schema.decodeUnknownSync(RegisteredGatewayWorkloadSchema)({
        admissionInvocationId: scope.principalId,
        bindingIncarnation: scope.principalId,
        declarationKey: 'privacy.core.source-processing-eligibility.read',
        entrypointKey: 'privacy.core.api.source-processing-eligibility',
        jobKey: 'integration.symmy.execute-symmy-job',
        legalEntityId: scope.legalEntityId,
        legalEntityScope: 'required',
        originalOwnerBindingIncarnation: scope.principalId,
        originalWorkloadBindingIncarnation: scope.principalId,
        originalWorkloadKey: 'integration.symmy-admit',
        originalPrincipalId: scope.principalId,
        runReference: scope.principalId,
        schemaVersion: '1',
        sourceAppId: 'commerce-customer-context',
        sourceBuildMarker: 'test',
        sourceMode: 'worker',
        workloadKey: 'privacy.core.source-processing-check',
      });
      const authorized = trustVerifiedGatewayPrincipalContext(
        { ...receiver },
        'a'.repeat(64),
        undefined,
        undefined,
        owner,
      );
      const checked = (
        caller: typeof receiver,
        consumerModuleId: 'commerce.customer-context' | 'party.registry',
        operation: string,
      ) =>
        getReadHandler(sourceProcessingEligibilityRead)(
          { ...request, consumerModuleId, operation },
          {
            readKey: sourceProcessingEligibilityRead.descriptor.readKey,
            scope: caller,
            services: {
              ...services(),
              demo: {
                policy: { ...policy, callers: [{ authMethod: 'system', principalId: scope.principalId }] },
                hasScopeProtections: () => Effect.succeed(false),
              },
            },
          },
        );
      expect(
        (yield* checked(authorized, 'commerce.customer-context', 'customer-profile-source.read')).result.outcome,
      ).toBe('ALLOWED');
      expect((yield* checked(authorized, 'party.registry', 'EVIDENCE_READ')).result.outcome).toBe('DENIED');
      expect(
        (yield* checked(receiver, 'commerce.customer-context', 'customer-profile-source.read')).result.outcome,
      ).toBe('DENIED');
    }),
);

it.effect('requires sealed intake actor, original admission, enrolled receiver and matching logical source', () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse(at));
    const native = Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
      authContextRef: 'job:integration.symmy.route-read:run:demo',
      authMethod: 'system',
      principalId: '72000000-0000-4000-8000-000000000027',
      tenantId: scope.tenantId,
    });
    const caller = { ...native, correlationId: scope.correlationId, legalEntityId: policy.legalEntityId };
    const route = Schema.decodeUnknownSync(RegisteredGatewayRouteScopeSchema)({
      legalEntityId: policy.legalEntityId,
      tenantId: scope.tenantId,
      principalId: native.principalId,
      routeKey: 'customersBatch',
      routeId: policy.customerRouteId,
      sourceRouteId: policy.customerRouteId,
      routeRevision: '1',
      sourceRouteRevision: '1',
      operations: [{ entrypointKey: 'privacy.core.api.source-processing-eligibility', schemaVersion: '1' }],
      nativeReadReceiver: {
        bindingIncarnation: scope.principalId,
        enrollmentLegalEntityId: policy.legalEntityId,
        originalPrincipalId: scope.principalId,
        originalWorkloadBindingIncarnation: scope.principalId,
        originalWorkloadKey: 'integration.symmy-admit',
        workloadKey: 'privacy.core.source-processing-check',
      },
    });
    const actor = {
      appId: 'symmy-integration',
      buildMarker: 'test-build',
      principalId: '72000000-0000-4000-8000-000000000029',
    };
    const seal = (proof: typeof route, by?: typeof actor) =>
      trustVerifiedGatewayPrincipalContext({ ...caller }, 'a'.repeat(64), undefined, by, undefined, proof);
    const redeemed = seal(route, actor);
    const receiver = { authMethod: 'system' as const, principalId: native.principalId };
    const both = { ...policy, callers: [...policy.callers, receiver] };
    const outcome = (authority: typeof caller, granted = both, input = request) =>
      getReadHandler(sourceProcessingEligibilityRead)(input, {
        readKey: sourceProcessingEligibilityRead.descriptor.readKey,
        scope: authority,
        services: { ...services(), demo: { policy: granted, hasScopeProtections: () => Effect.succeed(false) } },
      }).pipe(Effect.map(({ result }) => result.outcome));
    expect(yield* outcome(redeemed)).toBe('ALLOWED');
    expect(yield* outcome(redeemed, { ...both, callers: [receiver] })).toBe('DENIED');
    expect(yield* outcome(redeemed, { ...both, callers: [...policy.callers] })).toBe('DENIED');
    expect(yield* outcome(seal(route))).toBe('DENIED');
    expect(yield* outcome(seal(route, { ...actor, appId: 'party-registry' }))).toBe('DENIED');
    const proof = Schema.decodeUnknownSync(RegisteredGatewayRouteScopeSchema);
    expect(
      yield* outcome(
        seal(
          proof({
            ...route,
            nativeReadReceiver: { ...route.nativeReadReceiver, originalWorkloadKey: 'integration.symmy-poll' },
          }),
          actor,
        ),
      ),
    ).toBe('DENIED');
    expect(yield* outcome(seal(proof({ ...route, sourceRouteId: policy.groupRouteId }), actor))).toBe('DENIED');
    expect(
      yield* outcome(
        seal(
          proof({
            ...route,
            nativeReadReceiver: {
              ...route.nativeReadReceiver,
              workloadKey: 'privacy.core.organization-business-check',
            },
          }),
          actor,
        ),
      ),
    ).toBe('DENIED');
    expect(yield* outcome(caller)).toBe('DENIED');
  }),
);
