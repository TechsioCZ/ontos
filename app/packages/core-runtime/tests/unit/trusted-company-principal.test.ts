import { Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  TrustedCompanyPrincipalContextSchema,
  TrustedPrincipalContextSchema,
} from '../../src/actions/principal-context.ts';

const principal = Schema.decodeSync(TrustedPrincipalContextSchema)({
  authBindingId: '40000000-0000-4000-8000-000000000001',
  authContextRef: 'better-auth-session:company-scope',
  authMethod: 'session',
  legalEntityId: '20000000-0000-4000-8000-000000000001',
  principalId: '30000000-0000-4000-8000-000000000001',
  tenantId: '10000000-0000-4000-8000-000000000001',
});

it('narrows the original company carrier without reconstructing it', () => {
  const original = principal;
  if (!Schema.is(TrustedCompanyPrincipalContextSchema)(principal)) {
    throw new Error('Expected a valid company principal');
  }
  expect(principal).toBe(original);
  expect(principal.legalEntityId).toBe('20000000-0000-4000-8000-000000000001');
});

it('requires company scope and retains every trusted-context validation rule', () => {
  const { legalEntityId: _company, ...tenantPrincipal } = principal;
  const valid = Schema.is(TrustedCompanyPrincipalContextSchema);
  expect(valid(tenantPrincipal)).toBe(false);
  expect(valid({ ...principal, legalEntityId: 'not-a-company-id' })).toBe(false);
  const { authBindingId: _binding, ...unboundPrincipal } = principal;
  expect(valid(unboundPrincipal)).toBe(false);
  expect(valid({ ...principal, authMethod: 'system' })).toBe(false);
  expect(valid({ ...principal, authMethod: 'support_impersonation' })).toBe(false);
});
