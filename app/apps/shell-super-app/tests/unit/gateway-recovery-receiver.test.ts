import { internalWorkloadPrincipalId } from '@app/core-runtime/auth/module-credentials';
import { PgDialect } from 'drizzle-orm/pg-core';
import { expect, it } from 'effect-rstest';

import { registeredRecoveryReceiverStatement } from '../../api/auth/gateway-native-enrollment-sql.service.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const legalEntityId = '22222222-2222-4222-8222-222222222222';
const workloadKey = 'party.registry.source-read';
const dialect = new PgDialect();

it('selects recovery readers by the exact canonical company SERVICE only when no active legacy SYSTEM exists', () => {
  const query = dialect.sqlToQuery(
    registeredRecoveryReceiverStatement({
      enrollmentMode: 'system-or-canonical-company-service',
      legalEntityId,
      tenantId,
      workloadKey,
    }),
  );
  expect(query.sql).toContain("receiver_principal.status='active'");
  expect(query.sql).toContain("receiver.status='active'");
  expect(query.sql).toContain("t.status='active'");
  expect(query.sql).toContain("receiver_principal.kind='system'");
  expect(query.sql).toContain("legacy_principal.kind='system' and legacy_principal.status='active'");
  expect(query.sql).toContain("legacy_binding.status='active'");
  expect(query.sql).toContain("receiver_principal.kind='service'");
  expect(query.sql).toContain("receiver_principal.platform_role='internal_workload'");
  expect(query.sql).toContain('company_binding.workload_binding_id=receiver.binding_id');
  expect(query.sql).toContain("company_binding.status='active'");
  expect(query.sql).toContain("company.status='active'");
  expect(query.sql).toContain('limit 2');
  expect(query.params).toContain(internalWorkloadPrincipalId({ legalEntityId, tenantId, workloadKey }));
  expect(query.params).toContain(legalEntityId);
});

it('never selects arbitrary SERVICE readers for an unknown workload or a missing company', () => {
  for (const input of [
    { enrollmentMode: 'system' as const, legalEntityId, tenantId, workloadKey: 'unrelated.owner.read' },
    { enrollmentMode: 'system-or-canonical-company-service' as const, tenantId, workloadKey },
  ]) {
    const query = dialect.sqlToQuery(registeredRecoveryReceiverStatement(input));
    expect(query.sql).toContain("receiver_principal.kind='system'");
    expect(query.sql).not.toContain("receiver_principal.kind='service'");
    expect(query.sql).not.toContain("receiver_principal.kind='integration'");
    expect(query.sql).toContain("receiver.status='active'");
  }
});
