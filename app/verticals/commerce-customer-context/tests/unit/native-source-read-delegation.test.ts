import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { computeCanonicalValueHash } from '@app/core-runtime/actions/canonical-value-hash';
import {
  RegisteredGatewayRouteScopeSchema,
  trustVerifiedGatewayPrincipalContext,
} from '@app/core-runtime/auth/system-principal-context-provenance';
import { SourceProcessingEligibilityRequestSchema } from '@app/privacy-contracts/source-processing-eligibility';
import type { GatewayDelegationSubject } from '@app/shared-contracts/gateway-context-server';
import { Match, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { commerceSourceDelegationSubject } from '../../src/integrations/source-delegation-subject.ts';

const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const nativeReadPayload = (subject: GatewayDelegationSubject) =>
  Match.value(subject).pipe(
    Match.tag('NativeRouteRead', ({ _tag: _kind, ...payload }) => payload),
    Match.orElse(() => null),
  );

it('keeps a native source page prerequisite bound to its sealed route, declared provider and exact decoded input', () => {
  const principal = Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    authContextRef: 'job:native-source-read:run:unit',
    authMethod: 'system',
    principalId: id(1),
    tenantId: id(2),
  });
  const route = Schema.decodeUnknownSync(RegisteredGatewayRouteScopeSchema)({
    nativeReadReceiver: {
      bindingIncarnation: id(3),
      originalPrincipalId: id(4),
      originalWorkloadBindingIncarnation: id(5),
      originalWorkloadKey: 'integration.symmy-poll',
      workloadKey: 'commerce.customer-context.source-read',
    },
    operations: [
      {
        entrypointKey: 'commerce.customer-context.api.customer-profile-source-page',
        schemaVersion: '1',
      },
    ],
    principalId: id(1),
    routeId: id(6),
    routeKey: 'adminCustomers',
    routeRevision: 'v1',
    sourceRouteId: id(7),
    sourceRouteRevision: 'v1',
    tenantId: id(2),
  });
  const scope = trustVerifiedGatewayPrincipalContext(principal, 'a'.repeat(64), undefined, undefined, undefined, route);
  const input = Schema.decodeUnknownSync(SourceProcessingEligibilityRequestSchema)({
    consumerModuleId: 'commerce.customer-context',
    operation: 'PROFILE_CREATE',
    source: {
      issuer: 'unit-source',
      namespace: 'unit-source',
      occurrenceId: 'unit-occurrence',
      recordId: 'unit-record',
      recordType: 'CUSTOMER',
      routeRef: id(7),
    },
    target: null,
  });
  const requirement = 'commerce.customer-context.requirement.customer-profile-source-page-privacy';
  const subject = commerceSourceDelegationSubject(
    scope,
    'privacy.core.source-processing-eligibility.read',
    input,
    requirement,
  );
  expect(nativeReadPayload(subject)).toEqual({
    operationRequirementKey: requirement,
    requestHash: computeCanonicalValueHash(input),
    scope,
  });
  expect('actionInvocationId' in subject).toBe(false);
  expect(
    nativeReadPayload(
      commerceSourceDelegationSubject(
        { ...scope },
        'privacy.core.source-processing-eligibility.read',
        input,
        requirement,
      ),
    ),
  ).toBeNull();
});
