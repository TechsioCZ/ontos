import { recoverSqlTransactionError } from '@app/core-runtime';
import { TrustedPrincipalContextSchema } from '@app/core-runtime/actions/principal-context';
import type { TrustedPrincipalContext } from '@app/core-runtime/actions/principal-context';
import { internalWorkloadPrincipalId } from '@app/core-runtime/auth/module-credentials';
import type { RegisteredGatewayRouteScope } from '@app/core-runtime/auth/system-principal-context-provenance';
import { CoreDatabase } from '@app/core-runtime/db/client';
import { sql } from 'drizzle-orm';
import { Effect, Schema } from 'effect';

import { delegationForbidden, delegationUnavailable } from './gateway-delegation-errors.ts';

const receiverSchema = Schema.Struct({
  principalId: TrustedPrincipalContextSchema.fields.principalId,
  bindingIncarnation: Schema.String.check(Schema.isUUID()),
});

/** Redemption of the source's signed native binding and original admission precedes independent receiver selection. */
export const selectOnwardNativeReadReceiver = Effect.fn('GatewayDelegation.selectOnwardNativeReadReceiver')(
  function* select(input: {
    readonly principal: TrustedPrincipalContext;
    readonly routeScope: RegisteredGatewayRouteScope;
    readonly workloadKey: string;
  }) {
    const native = input.routeScope.nativeReadReceiver;
    const company = input.routeScope.legalEntityId;
    if (native === undefined || company === undefined || native.enrollmentLegalEntityId !== company) {
      return yield* delegationForbidden('workload_binding_not_active')();
    }
    const tenant = input.principal.tenantId;
    // Alias arguments are private constants, never request-controlled SQL.
    const eligible = (principalAlias: 'source_principal' | 'receiver', bindingAlias: 'current_source' | 'b', key: string) => {
      const p = sql.raw(principalAlias);
      const b = sql.raw(bindingAlias);
      const systemCount = sql`(
        select count(*) from core.access_workload_bindings sb
        join core.principals sp on sp.tenant_id=sb.tenant_id and sp.principal_id=sb.principal_id
          and sp.kind='system' and sp.status='active'
        where sb.tenant_id=${tenant}::uuid and sb.workload_key=${key} and sb.status='active'
      )`;
      return sql`(
        (${p}.kind='system' and ${systemCount}=1) or (
          ${systemCount}=0 and ${p}.kind='service' and ${p}.platform_role='internal_workload'
          and ${p}.principal_id=${internalWorkloadPrincipalId({ tenantId: tenant, legalEntityId: company, workloadKey: key })}::uuid
          and exists (
            select 1 from core.access_workload_company_bindings cb
            where cb.tenant_id=${b}.tenant_id and cb.workload_binding_id=${b}.binding_id
              and cb.status='active' and cb.legal_entity_id=${company}::uuid
          )
        )
      )`;
    };
    const database = yield* CoreDatabase;
    const rows = yield* database.executor.transaction(
      Effect.fn('GatewayDelegation.onwardNativeReadEvidence')(function* evidence(transaction) {
        yield* transaction.execute(
          sql`select set_config('ontos.tenant_id', ${tenant}, true), set_config('ontos.legal_entity_id', '', true)`, 'objects',
        );
        return yield* transaction.execute(sql`
          select receiver.principal_id as "principalId", b.incarnation as "bindingIncarnation"
          from core.access_workload_bindings b
          join core.tenants t on t.tenant_id=b.tenant_id and t.status='active'
          join core.legal_entities company on company.tenant_id=t.tenant_id
            and company.legal_entity_id=${company}::uuid and company.status='active'
          join core.principals receiver on receiver.tenant_id=t.tenant_id
            and receiver.principal_id=b.principal_id and receiver.status='active'
          join core.principals source_principal on source_principal.tenant_id=t.tenant_id
            and source_principal.principal_id=${input.principal.principalId}::uuid and source_principal.status='active'
          join core.access_workload_bindings current_source on current_source.tenant_id=t.tenant_id
            and current_source.principal_id=source_principal.principal_id and current_source.status='active'
            and current_source.workload_key=${native.workloadKey}
            and current_source.incarnation=${native.bindingIncarnation}::uuid
          join core.principals original on original.tenant_id=t.tenant_id
            and original.principal_id=${native.originalPrincipalId}::uuid
            and original.kind='integration' and original.status='active'
          join core.access_workload_bindings original_binding on original_binding.tenant_id=t.tenant_id
            and original_binding.principal_id=original.principal_id and original_binding.status='active'
            and original_binding.workload_key=${native.originalWorkloadKey}
            and original_binding.incarnation=${native.originalWorkloadBindingIncarnation}::uuid
          where b.tenant_id=${tenant}::uuid and b.workload_key=${input.workloadKey} and b.status='active'
            and ${eligible('source_principal', 'current_source', native.workloadKey)}
            and ${eligible('receiver', 'b', input.workloadKey)}
          limit 2`, 'objects');
      }),
    ).pipe(
      recoverSqlTransactionError,
      Effect.mapError(delegationUnavailable('source_evidence_unavailable')),
      Effect.flatMap((rows) => Schema.decodeUnknownEffect(Schema.Array(receiverSchema))(rows).pipe(
        Effect.mapError(delegationUnavailable('source_evidence_unavailable')),
      )),
    );
    const [receiver] = rows;
    if (rows.length !== 1 || receiver === undefined) {
      return yield* delegationForbidden('workload_binding_not_active')();
    }
    return receiver;
  },
);
