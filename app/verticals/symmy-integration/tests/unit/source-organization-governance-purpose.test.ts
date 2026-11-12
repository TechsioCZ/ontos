import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import type { OperationalScope } from '@app/core-runtime';
import { Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { SymmySourceOrganizationFactsRequestSchema } from '../../shared/apis/symmy-source-organization-facts.ts';
import { symmyOrganizationSourceCallerDecision } from '../../src/persistence/symmy-source-organization-facts-store.ts';

const principal = Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
  authBindingId: '10000000-0000-4000-8000-000000000001',
  authContextRef: 'better-auth-session:organization-governance-purpose',
  authMethod: 'session',
  legalEntityId: '10000000-0000-4000-8000-000000000002',
  principalId: '10000000-0000-4000-8000-000000000003',
  tenantId: '10000000-0000-4000-8000-000000000004',
});
const scope: OperationalScope = {
  ...principal,
  audience: 'symmy-integration',
  correlationId: 'organization-governance-purpose-fixture',
};
const governance = Schema.decodeUnknownSync(SymmySourceOrganizationFactsRequestSchema)({
  effectKey: 'party-create',
  execution: { jobId: '10000000-0000-4000-8000-000000000005', kind: 'JOB' },
  purpose: 'GOVERNANCE',
  sourceReference: {
    occurrenceId: 'occurrence-1',
    recordId: 'org-1',
    source: {
      issuer: 'INTERNAL',
      namespace: 'organizations',
      recordType: 'ORGANIZATION',
      routeRef: '10000000-0000-4000-8000-000000000006',
    },
  },
});
const processing = Schema.decodeUnknownSync(SymmySourceOrganizationFactsRequestSchema)({
  effectId: '10000000-0000-4000-8000-000000000007',
  originalAdmissionInvocationId: '10000000-0000-4000-8000-000000000008',
  purpose: 'PROCESSING',
});

describe('organization governance purpose admission', () => {
  it('does not accept an ordinary staff session as proof of the finite governance carrier', () => {
    expect(symmyOrganizationSourceCallerDecision(scope, governance)).toBe('forbidden');
    expect(symmyOrganizationSourceCallerDecision(scope, processing)).toBe('forbidden');
  });

  it('does not treat copied governance metadata or a Privacy app label as verified authority', () => {
    const copy = {
      ...scope,
      actor: { appId: 'privacy' },
      organizationGovernanceRead: {
        governanceLegalEntityId: principal.legalEntityId,
        principalId: principal.principalId,
        requestHash: 'a'.repeat(64),
        tenantId: principal.tenantId,
      },
    };
    expect(symmyOrganizationSourceCallerDecision(copy, governance)).toBe('forbidden');
    expect(symmyOrganizationSourceCallerDecision(copy, processing)).toBe('forbidden');
  });
});
