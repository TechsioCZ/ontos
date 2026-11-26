import { internalWorkloadPrincipalId } from '@app/core-runtime/auth/module-credentials';
import { sql } from 'drizzle-orm';

/** Installed registered-call rules still constrain every edge; this only identifies its actual enrolled executor. */
export const registeredAssertionPrincipalEligibility = (input: {
  readonly enrollmentMode: 'system' | 'system-or-canonical-company-service';
  readonly legalEntityId?: string | undefined;
  readonly side: 'receiver' | 'source';
  readonly tenantId: string;
  readonly workloadKey: string;
}) => {
  const principal = sql.raw(input.side === 'receiver' ? 'receiver_principal' : 'source_principal');
  const binding = sql.raw(input.side === 'receiver' ? 'receiver' : 'current_source');
  const systemCount = sql`(
    select count(*) from core.access_workload_bindings legacy_binding
    join core.principals legacy_principal
      on legacy_principal.tenant_id=legacy_binding.tenant_id
      and legacy_principal.principal_id=legacy_binding.principal_id
      and legacy_principal.kind='system' and legacy_principal.status='active'
    where legacy_binding.tenant_id=${input.tenantId}::uuid
      and legacy_binding.workload_key=${input.workloadKey} and legacy_binding.status='active'
  )`;
  const legacy = sql`(${principal}.kind='system' and ${systemCount}=1)`;
  if (input.legalEntityId === undefined || input.enrollmentMode !== 'system-or-canonical-company-service') {
    return legacy;
  }
  const principalId = internalWorkloadPrincipalId({
    legalEntityId: input.legalEntityId,
    tenantId: input.tenantId,
    workloadKey: input.workloadKey,
  });
  return sql`(${legacy} or (
    ${systemCount}=0 and ${principal}.kind='service'
    and ${principal}.platform_role='internal_workload'
    and ${principal}.principal_id=${principalId}::uuid
    and exists (
      select 1 from core.access_workload_company_bindings company_binding
      join core.legal_entities company on company.tenant_id=company_binding.tenant_id
        and company.legal_entity_id=company_binding.legal_entity_id and company.status='active'
      where company_binding.tenant_id=${binding}.tenant_id
        and company_binding.workload_binding_id=${binding}.binding_id
        and company_binding.legal_entity_id=${input.legalEntityId}::uuid and company_binding.status='active'
    )
  ))`;
};

/** Recovery uses the same native executor selection as fresh registered calls; it does not adopt arbitrary services. */
export const registeredRecoveryReceiverStatement = (input: {
  readonly enrollmentMode: 'system' | 'system-or-canonical-company-service';
  readonly legalEntityId?: string | undefined;
  readonly tenantId: string;
  readonly workloadKey: string;
}) => sql`
        select receiver.principal_id as "principalId", receiver.incarnation as "bindingIncarnation"
        from core.access_workload_bindings receiver
        join core.principals receiver_principal
          on receiver_principal.tenant_id=receiver.tenant_id
          and receiver_principal.principal_id=receiver.principal_id and receiver_principal.status='active'
        join core.tenants t on t.tenant_id=receiver.tenant_id and t.status='active'
        where receiver.tenant_id=${input.tenantId}::uuid
          and receiver.workload_key=${input.workloadKey} and receiver.status='active'
          and (${input.legalEntityId ?? null}::uuid is null or exists(
            select 1 from core.legal_entities l where l.tenant_id=t.tenant_id
              and l.legal_entity_id=${input.legalEntityId ?? null}::uuid and l.status='active'))
          and ${registeredAssertionPrincipalEligibility({ ...input, side: 'receiver' })}
        limit 2`;
