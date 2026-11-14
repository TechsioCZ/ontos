import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { Effect, Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { requireApprovalOwnerIdentity } from '../../api/access-admin/approval-owner-identity.ts';

const companyId = '70000000-0000-4000-8000-000000000001';
const tenantPrincipal = Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
  authBindingId: '30000000-0000-4000-8000-000000000001',
  authContextRef: 'session:owner-approval',
  authenticationNamespaceId: 'shell.staff',
  authMethod: 'session',
  principalId: '40000000-0000-4000-8000-000000000001',
  tenantId: '50000000-0000-4000-8000-000000000001',
});
const admitted = { ...tenantPrincipal, correlationId: 'owner-approval' };

it.effect('retains the original resolved company principal rather than constructing one from the tenant scope', () =>
  Effect.gen(function* preservesCompanyPrincipal() {
    const principal = Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
      ...tenantPrincipal,
      legalEntityId: companyId,
    });
    expect(yield* requireApprovalOwnerIdentity(admitted, principal, companyId)).toBe(principal);
  }),
);

it.effect('retains the original tenant principal for a tenant-scoped proposal', () =>
  Effect.gen(function* preservesTenantPrincipal() {
    expect(yield* requireApprovalOwnerIdentity(admitted, tenantPrincipal)).toBe(tenantPrincipal);
  }),
);

for (const [name, change, expectedCompany] of [
  ['unselected company', {}, companyId],
  ['different selected company', { legalEntityId: '70000000-0000-4000-8000-000000000002' }, companyId],
  ['company principal for tenant proposal', { legalEntityId: companyId }, undefined],
  ['different tenant', { tenantId: '50000000-0000-4000-8000-000000000002' }, undefined],
  ['different principal', { principalId: '40000000-0000-4000-8000-000000000002' }, undefined],
  ['different auth binding', { authBindingId: '30000000-0000-4000-8000-000000000002' }, undefined],
  ['different session', { authContextRef: 'session:other' }, undefined],
  ['different namespace', { authenticationNamespaceId: 'other.realm' }, undefined],
  ['API key substitution', { authMethod: 'api_key' }, undefined],
] as const) {
  it.effect(`refuses ${name} instead of synthesizing a matching owner identity`, () =>
    Effect.gen(function* refusesIdentitySubstitution() {
      const principal = Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({ ...tenantPrincipal, ...change });
      const result = yield* Effect.result(requireApprovalOwnerIdentity(admitted, principal, expectedCompany));
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure.status).toBe(403);
      }
    }),
  );
}

it.effect('preserves the actual support impersonator and refuses an impersonator change', () =>
  Effect.gen(function* preservesSupportImpersonator() {
    const principal = Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
      ...tenantPrincipal,
      authMethod: 'support_impersonation',
      impersonatedByPrincipalId: '40000000-0000-4000-8000-000000000003',
    });
    const scope = { ...principal, correlationId: 'support-owner-approval' };
    expect(yield* requireApprovalOwnerIdentity(scope, principal)).toBe(principal);
    const other = Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
      ...principal,
      impersonatedByPrincipalId: '40000000-0000-4000-8000-000000000004',
    });
    expect(Result.isFailure(yield* Effect.result(requireApprovalOwnerIdentity(scope, other)))).toBe(true);
  }),
);
