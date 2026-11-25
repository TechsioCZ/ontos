import { internalWorkloadPrincipalId } from '@app/core-runtime/auth/module-credentials';
import { PgDialect } from 'drizzle-orm/pg-core';
import { expect, it } from 'effect-rstest';

import { registeredAssertionPrincipalEligibility } from '../../api/auth/gateway-native-enrollment-sql.service.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const legalEntityId = '10000000-0000-4000-8000-000000000002';
const sourceWriters = [
  'party.registry.source-write',
  'commerce.customer-context.source-write',
  'party.registry.source-read',
  'commerce.customer-context.source-read',
  'privacy.core.source-processing-check',
  'privacy.core.organization-business-check',
  'privacy.core.organization-profile-ico-check',
  'commerce.customer-context.organization-ico-facts.read',
  'integration.symmy.source-organization-facts.read',
  'pricing.price-group-catalog.source-read',
];

it('admits only canonical company platform writers for both sides and both source-write workloads', () => {
  for (const side of ['source', 'receiver'] as const) {
    for (const workloadKey of sourceWriters) {
      const query = new PgDialect().sqlToQuery(
        registeredAssertionPrincipalEligibility({ legalEntityId, side, tenantId, workloadKey }),
      );
      const principal = side === 'source' ? 'source_principal' : 'receiver_principal';
      const binding = side === 'source' ? 'current_source' : 'receiver';
      expect(query.sql).toContain(`${principal}.kind='system'`);
      expect(query.sql).toContain("legacy_principal.kind='system' and legacy_principal.status='active'");
      expect(query.sql).toContain("legacy_binding.status='active'");
      expect(query.sql).toContain(')=1');
      expect(query.sql).toContain(')=0 and');
      expect(query.sql).toContain(`${principal}.kind='service'`);
      expect(query.sql).toContain(`${principal}.platform_role='internal_workload'`);
      expect(query.sql).toContain(`company_binding.tenant_id=${binding}.tenant_id`);
      expect(query.sql).toContain(`company_binding.workload_binding_id=${binding}.binding_id`);
      expect(query.sql).toContain("company_binding.status='active'");
      expect(query.sql).toContain("company.status='active'");
      expect(query.params).toContain(tenantId);
      expect(query.params).toContain(legalEntityId);
      expect(query.params).toContain(workloadKey);
      expect(query.params).toContain(internalWorkloadPrincipalId({ legalEntityId, tenantId, workloadKey }));
    }
  }
});

it('keeps unrelated workloads and company-less requests strictly unique-SYSTEM only', () => {
  for (const side of ['source', 'receiver'] as const) {
    for (const input of [
      { legalEntityId, workloadKey: 'integration.symmy.execute-symmy-job' },
      { legalEntityId, workloadKey: 'privacy.core.unregistered-check' },
      { workloadKey: 'party.registry.source-write' },
      { workloadKey: 'commerce.customer-context.source-write' },
    ]) {
      const query = new PgDialect().sqlToQuery(registeredAssertionPrincipalEligibility({ side, tenantId, ...input }));
      expect(query.sql).toContain("kind='system'");
      expect(query.sql).toContain(')=1');
      expect(query.sql).not.toContain("kind='service'");
      expect(query.sql).not.toContain('company_binding');
    }
  }
});

it('binds service selection to the requested company rather than another company canonical identity', () => {
  const workloadKey = 'party.registry.source-write';
  const otherCompany = '10000000-0000-4000-8000-000000000003';
  const query = new PgDialect().sqlToQuery(
    registeredAssertionPrincipalEligibility({ legalEntityId, side: 'source', tenantId, workloadKey }),
  );
  expect(query.params).not.toContain(otherCompany);
  expect(query.params).not.toContain(
    internalWorkloadPrincipalId({ legalEntityId: otherCompany, tenantId, workloadKey }),
  );
});
