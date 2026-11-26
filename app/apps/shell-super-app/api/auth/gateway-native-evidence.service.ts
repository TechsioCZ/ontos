import { OntosModuleIdSchema, recoverSqlTransactionError } from '@app/core-runtime';
import type { ModuleEntrypointAccess } from '@app/core-runtime';
import { TrustedPrincipalContextSchema } from '@app/core-runtime/actions/principal-context';
import type { TrustedPrincipalContext } from '@app/core-runtime/actions/principal-context';
import { internalWorkloadPrincipalId } from '@app/core-runtime/auth/module-credentials';
import {
  RegisteredGatewayWorkloadSchema,
  RegisteredGatewayPrivacyDispatchSchema,
} from '@app/core-runtime/auth/system-principal-context-provenance';
import type {
  RegisteredGatewayWorkload,
  RegisteredGatewayRouteScope,
} from '@app/core-runtime/auth/system-principal-context-provenance';
import { CoreDatabase } from '@app/core-runtime/db/client';
import { computeCanonicalValueHash } from '@app/core-runtime/access/enforcement';
import {
  OutboxPayloadSchema as PrivacyOutboxPayloadSchema,
  outboxProducerModuleKey as privacyModule,
  outboxTopic as privacyOutboxTopic,
} from '@app/privacy/outbox/privacy-measure-dispatched';
import { validatePrivacyMeasureHandoff } from '@app/privacy/domain/privacy-measure-handoff';
import type { PrivacyMeasureHandoffSchema } from '@app/privacy/domain/privacy-measure-handoff';
import {
  OutboxPayloadSchema,
  outboxProducerModuleKey,
  outboxTopic,
} from '@app/symmy-integration/outbox/integration-symmy-job-admitted-v1';
import type { SymmyRouteContextResponseSchema } from '@app/symmy-integration/api/symmy-route-context';
import { sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { Effect, Layer, Match, Option, Schema } from 'effect';
import type { ShellInstalledCatalog } from '../modules/installed-module-catalog.ts';
import type { GatewayDelegationRequestPayload } from './gateway-delegation-issuer.ts';
import { GatewayDelegationError, delegationForbidden, delegationUnavailable } from './gateway-delegation-errors.ts';
import {
  gatewayRegisteredAdmissionOperationContractAllows,
  gatewayRegisteredWorkerOperationContractAllows,
} from './gateway-delegation-policy.ts';
import type { GatewayModuleBinding, GatewayRegisteredWorkloadRule } from './gateway-delegation-policy.ts';
import type { RouteScopeFacts } from './gateway-symmy-route-proof.ts';
import type { PaymentRouteWorkload } from './gateway-payment-route-errors.ts';
import { PaymentRouteWorkloadSchema, forbidden, unavailable } from './gateway-payment-route-errors.ts';
import {
  registeredAssertionPrincipalEligibility,
  registeredRecoveryReceiverStatement,
} from './gateway-native-enrollment-sql.service.ts';
import { GatewayNativeEvidence } from './gateway-native-evidence.ts';

type InstalledContract = ShellInstalledCatalog['contracts'][number];
type OriginalAction = InstalledContract['manifest']['publicSurface']['actions'][number];
type RecoverySubject = Extract<GatewayDelegationRequestPayload['subject'], { readonly _tag: 'RegisteredRecovery' }>;
type RecoverySource = RecoverySubject['source'];
type AssertionSubject = Extract<GatewayDelegationRequestPayload['subject'], { readonly _tag: 'RegisteredAssertion' }>;
type Route = typeof SymmyRouteContextResponseSchema.Type;
type SourcePurpose = RouteScopeFacts['sourcePurpose'];
const paymentSourceWorkload = 'payment.source-ingress';
/** Payment admission needs both its ingress workload and current source-owner authority, even after ingress. */
const originalPaymentAuthority = (principal: 'p' | 'original', workload: SQL) => {
  const original = sql.raw(principal);
  const paymentWorkloads = sql.join(
    PaymentRouteWorkloadSchema.literals.map((key) => sql`${key}`),
    sql`, `,
  );
  return sql`(
    ${workload} not in (${paymentWorkloads}) or exists (
      select 1 from core.access_workload_bindings original_payment_source
      where original_payment_source.tenant_id=${original}.tenant_id
        and original_payment_source.principal_id=${original}.principal_id
        and original_payment_source.workload_key=${paymentSourceWorkload}
        and original_payment_source.status='active'
    )
  )`;
};
/** A finite receiver contract may project a verified company-scoped source into a tenant-only operation. */
const targetWorkloadScope = (workload: RegisteredGatewayWorkload): RegisteredGatewayWorkload => {
  if (workload.legalEntityScope !== 'forbidden') {
    return workload;
  }
  const { legalEntityId: _sourceLegalEntityId, ...tenantWorkload } = workload;
  return tenantWorkload;
};

const recoveryRunReference = (source: RecoverySource): string =>
  Match.value(source).pipe(
    Match.tag('Worker', (worker) => worker.deliveryId),
    Match.tag('HistoricalDelivery', (delivery) => delivery.deliveryId),
    Match.tag('Admission', (admission) => admission.actionInvocationId),
    Match.exhaustive,
  );

const recoveryMode = (source: RecoverySource): RegisteredGatewayWorkload['sourceMode'] =>
  Match.value(source).pipe(
    Match.tag('Worker', () => 'worker' as const),
    Match.tag('HistoricalDelivery', () => 'historical_delivery' as const),
    Match.tag('Admission', () => 'admission' as const),
    Match.exhaustive,
  );

const recoveryWorkloadScope = (
  source: RecoverySource,
  moduleKey: string,
  workload: RegisteredGatewayWorkload,
): RegisteredGatewayWorkload => {
  const scoped = source.legalEntityId === undefined ? workload : { ...workload, legalEntityId: source.legalEntityId };
  return Match.value(source).pipe(
    Match.tag('Worker', (worker) => ({
      ...scoped,
      claimId: worker.claimId,
      workerKey: worker.workerKey,
      workerModuleKey: moduleKey,
    })),
    Match.tag('HistoricalDelivery', (delivery) => ({
      ...scoped,
      workerKey: delivery.workerKey,
      workerModuleKey: moduleKey,
    })),
    Match.tag('Admission', () => scoped),
    Match.exhaustive,
  );
};

const makeSelectOnwardNativeReadReceiver = (database: CoreDatabase['Service']) => {
  const receiverSchema = Schema.Struct({
    bindingIncarnation: Schema.String.check(Schema.isUUID()),
    principalId: TrustedPrincipalContextSchema.fields.principalId,
  });
  /** Redemption of the source's signed native binding and original admission precedes independent receiver selection. */
  const selectOnwardNativeReadReceiver = Effect.fn('GatewayDelegation.selectOnwardNativeReadReceiver')(
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
      const eligible = (
        principalAlias: 'source_principal' | 'receiver',
        bindingAlias: 'current_source' | 'b',
        key: string,
      ) => {
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
          and ${p}.principal_id=${internalWorkloadPrincipalId({ legalEntityId: company, tenantId: tenant, workloadKey: key })}::uuid
          and exists (
            select 1 from core.access_workload_company_bindings cb
            where cb.tenant_id=${b}.tenant_id and cb.workload_binding_id=${b}.binding_id
              and cb.status='active' and cb.legal_entity_id=${company}::uuid
          )
        )
      )`;
      };
      const rows = yield* database.executor
        .transaction(
          Effect.fn('GatewayDelegation.onwardNativeReadEvidence')(function* evidence(transaction) {
            yield* transaction.execute(
              sql`select set_config('ontos.tenant_id', ${tenant}, true), set_config('ontos.legal_entity_id', '', true)`,
              'objects',
            );
            return yield* transaction.execute(
              sql`
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
          limit 2`,
              'objects',
            );
          }),
        )
        .pipe(
          recoverSqlTransactionError,
          Effect.mapError(delegationUnavailable('source_evidence_unavailable')),
          Effect.flatMap((records) =>
            Schema.decodeUnknownEffect(Schema.Array(receiverSchema))(records).pipe(
              Effect.mapError(delegationUnavailable('source_evidence_unavailable')),
            ),
          ),
        );
      const [receiver] = rows;
      if (rows.length !== 1 || receiver === undefined) {
        return yield* delegationForbidden('workload_binding_not_active')();
      }
      return receiver;
    },
  );
  return selectOnwardNativeReadReceiver;
};

const makeValidateCurrentHuman = (database: CoreDatabase['Service']) => {
  const validateCurrentHuman = Effect.fn('OrganizationGovernanceEvidence.currentHuman')(function* human(
    principal: TrustedPrincipalContext,
  ) {
    yield* database.executor
      .transaction(
        Effect.fn('OrganizationGovernanceEvidence.nativeHuman')(function* native(transaction) {
          yield* transaction.execute(
            sql`select set_config('ontos.tenant_id',${principal.tenantId},true),set_config('ontos.legal_entity_id',${principal.legalEntityId ?? ''},true)`,
            'objects',
          );
          const namespace =
            principal.authenticationNamespaceId === undefined
              ? sql`true`
              : sql`b.authentication_namespace_id=${principal.authenticationNamespaceId}`;
          const rows = yield* transaction.execute(
            sql`
      select p.principal_id
      from core.principals p
      join core.tenants t on t.tenant_id=p.tenant_id and t.status='active'
      join core.principal_auth_bindings b on b.tenant_id=p.tenant_id and b.principal_id=p.principal_id
        and b.principal_auth_binding_id=${principal.authBindingId}::uuid and b.status='active' and b.revoked_at is null
      join core.legal_entities l on l.tenant_id=p.tenant_id and l.legal_entity_id=${principal.legalEntityId}::uuid and l.status='active'
      where p.tenant_id=${principal.tenantId}::uuid and p.principal_id=${principal.principalId}::uuid
        and p.kind='human' and p.status='active' and ${namespace}
        and b.subject_type=${principal.authMethod === 'session' ? 'user' : 'api_key'}
      limit 2`,
            'objects',
          );
          if (rows.length !== 1) {
            return yield* delegationForbidden('organization_governance_not_admitted')();
          }
          return yield* Effect.void;
        }),
      )
      .pipe(
        recoverSqlTransactionError,
        Effect.mapError((cause) =>
          Schema.is(GatewayDelegationError)(cause)
            ? cause
            : delegationUnavailable('source_evidence_unavailable')(cause),
        ),
      );
  });

  return validateCurrentHuman;
};

const makeValidatePaymentRoutePrincipal = (database: CoreDatabase['Service']) => {
  const validatePaymentRoutePrincipal = Effect.fn('PaymentRouteScope.validatePrincipal')(function* validatePrincipal(
    candidate: TrustedPrincipalContext,
    requestedWorkload: PaymentRouteWorkload,
  ) {
    const workload = yield* Schema.decodeUnknownEffect(PaymentRouteWorkloadSchema)(requestedWorkload).pipe(
      Effect.mapError(forbidden),
    );
    const principal = yield* Schema.decodeUnknownEffect(TrustedPrincipalContextSchema)(candidate).pipe(
      Effect.mapError(forbidden),
    );
    if (
      principal.authMethod !== 'api_key' ||
      principal.legalEntityId !== undefined ||
      principal.authBindingId === undefined ||
      principal.authContextRef === undefined ||
      !principal.authContextRef.startsWith('better-auth-api-key:')
    ) {
      return yield* Effect.fail(forbidden());
    }
    const providerKeyId = principal.authContextRef.slice('better-auth-api-key:'.length);
    const eligible = yield* database.executor
      .transaction(
        Effect.fn('PaymentRouteScope.nativeIdentity')(function* nativeIdentity(transaction) {
          yield* transaction.execute(
            sql`select set_config('ontos.tenant_id', ${principal.tenantId}, true), set_config('ontos.legal_entity_id', '', true)`,
            'objects',
          );
          return yield* transaction.execute(
            sql`
      select p.principal_id
      from core.principals p
      join core.tenants t on t.tenant_id=p.tenant_id and t.status='active'
      join core.principal_auth_bindings a on a.tenant_id=p.tenant_id and a.principal_id=p.principal_id
        and a.principal_auth_binding_id=${principal.authBindingId}::uuid and a.status='active' and a.revoked_at is null
        and a.subject_type='api_key' and a.provider='better_auth' and a.provider_subject_id=${providerKeyId}
        and a.authentication_namespace_id=${principal.authenticationNamespaceId ?? ''}
      where p.tenant_id=${principal.tenantId}::uuid and p.principal_id=${principal.principalId}::uuid
        and p.kind='integration' and p.status='active'
        and exists(select 1 from core.access_workload_bindings w where w.tenant_id=p.tenant_id and w.principal_id=p.principal_id
          and w.status='active' and w.workload_key=${workload})
        and exists(select 1 from core.access_workload_bindings s where s.tenant_id=p.tenant_id and s.principal_id=p.principal_id
          and s.status='active' and s.workload_key=${paymentSourceWorkload})
      limit 2`,
            'objects',
          );
        }),
      )
      .pipe(recoverSqlTransactionError, Effect.mapError(unavailable));
    if (eligible.length !== 1) {
      return yield* Effect.fail(forbidden());
    }
    return principal;
  });

  return validatePaymentRoutePrincipal;
};

const makeValidateRoutePrincipal = (database: CoreDatabase['Service']) => {
  const validateRoutePrincipal = Effect.fn('SymmyRouteScope.validatePrincipal')(function* validatePrincipal(
    candidate: TrustedPrincipalContext,
    sourcePurpose: SourcePurpose,
  ) {
    const principal = yield* Schema.decodeUnknownEffect(TrustedPrincipalContextSchema)(candidate).pipe(
      Effect.mapError(delegationForbidden('symmy_route_not_admitted')),
    );
    if (
      principal.authMethod !== 'api_key' ||
      principal.legalEntityId !== undefined ||
      principal.authBindingId === undefined ||
      principal.authContextRef === undefined ||
      !principal.authContextRef.startsWith('better-auth-api-key:')
    ) {
      return yield* delegationForbidden('symmy_route_not_admitted')();
    }
    const providerKeyId = principal.authContextRef.slice('better-auth-api-key:'.length);
    const eligible = yield* database.executor
      .transaction(
        Effect.fn('SymmyRouteScope.nativeIdentity')(function* nativeIdentity(transaction) {
          yield* transaction.execute(
            sql`select set_config('ontos.tenant_id', ${principal.tenantId}, true), set_config('ontos.legal_entity_id', '', true)`,
            'objects',
          );
          return yield* transaction.execute(
            sql`
      select p.principal_id
      from core.principals p
      join core.tenants t on t.tenant_id=p.tenant_id and t.status='active'
      join core.principal_auth_bindings a on a.tenant_id=p.tenant_id and a.principal_id=p.principal_id
        and a.principal_auth_binding_id=${principal.authBindingId}::uuid and a.status='active' and a.revoked_at is null
        and a.subject_type='api_key' and a.provider='better_auth' and a.provider_subject_id=${providerKeyId}
        and a.authentication_namespace_id=${principal.authenticationNamespaceId ?? ''}
      where p.tenant_id=${principal.tenantId}::uuid and p.principal_id=${principal.principalId}::uuid
        and p.kind='integration' and p.status='active'
        and exists(select 1 from core.access_workload_bindings w where w.tenant_id=p.tenant_id and w.principal_id=p.principal_id
          and w.status='active' and (w.workload_key='integration.symmy-admit' or (${sourcePurpose}='read' and w.workload_key='integration.symmy-poll')))
      limit 2`,
            'objects',
          );
        }),
      )
      .pipe(recoverSqlTransactionError, Effect.mapError(delegationUnavailable('symmy_route_unavailable')));
    if (eligible.length !== 1) {
      return yield* delegationForbidden('symmy_route_not_admitted')();
    }
    return principal;
  });

  return validateRoutePrincipal;
};

const makeSelectNativeReadReceiver = (database: CoreDatabase['Service']) => {
  const nativeReadRowSchema = Schema.Struct({
    bindingIncarnation: Schema.String.check(Schema.isUUID()),
    originalWorkloadBindingIncarnation: Schema.String.check(Schema.isUUID()),
    originalWorkloadKey: Schema.Literals(['integration.symmy-admit', 'integration.symmy-poll']),
    principalId: TrustedPrincipalContextSchema.fields.principalId,
  });
  const selectNativeReadReceiver = Effect.fn('SymmyRouteScope.selectNativeReadReceiver')(function* select(
    facts: RouteScopeFacts,
    route: Route,
    workloadKey: string,
  ) {
    const systemCount = sql`(
    select count(*) from core.access_workload_bindings sb
    join core.principals sp on sp.tenant_id=sb.tenant_id and sp.principal_id=sb.principal_id
      and sp.kind='system' and sp.status='active'
    where sb.tenant_id=${facts.principal.tenantId}::uuid and sb.workload_key=${workloadKey} and sb.status='active'
  )`;
    const service =
      route.legalEntityId === undefined
        ? sql`false`
        : sql`
    receiver.kind='service' and receiver.platform_role='internal_workload'
    and receiver.principal_id=${internalWorkloadPrincipalId({
      legalEntityId: route.legalEntityId,
      tenantId: facts.principal.tenantId,
      workloadKey,
    })}::uuid
    and exists (
      select 1 from core.access_workload_company_bindings cb
      join core.legal_entities le on le.tenant_id=cb.tenant_id and le.legal_entity_id=cb.legal_entity_id and le.status='active'
      where cb.tenant_id=b.tenant_id and cb.workload_binding_id=b.binding_id and cb.status='active'
        and cb.legal_entity_id=${route.legalEntityId}::uuid
    )`;
    const rows = yield* database.executor
      .transaction(
        Effect.fn('SymmyRouteScope.nativeReadEvidence')(function* nativeReadEvidence(transaction) {
          yield* transaction.execute(
            sql`select set_config('ontos.tenant_id', ${facts.principal.tenantId}, true), set_config('ontos.legal_entity_id', '', true)`,
            'objects',
          );
          return yield* transaction.execute(
            sql`
        select receiver.principal_id as "principalId", b.incarnation as "bindingIncarnation",
          original_binding.workload_key as "originalWorkloadKey",
          original_binding.incarnation as "originalWorkloadBindingIncarnation"
        from core.access_workload_bindings b
        join core.tenants t on t.tenant_id=b.tenant_id and t.status='active'
        join core.principals receiver on receiver.tenant_id=b.tenant_id and receiver.principal_id=b.principal_id and receiver.status='active'
        join core.principals original on original.tenant_id=t.tenant_id and original.principal_id=${facts.principal.principalId}::uuid
          and original.kind='integration' and original.status='active'
        join core.principal_auth_bindings original_auth on original_auth.tenant_id=original.tenant_id
          and original_auth.principal_id=original.principal_id
          and original_auth.principal_auth_binding_id=${facts.principal.authBindingId}::uuid
          and original_auth.status='active' and original_auth.revoked_at is null
          and original_auth.provider='better_auth' and original_auth.subject_type='api_key'
          and original_auth.provider_subject_id=${facts.principal.authContextRef?.slice('better-auth-api-key:'.length) ?? ''}
          and original_auth.authentication_namespace_id=${facts.principal.authenticationNamespaceId ?? ''}
        join core.access_workload_bindings original_binding on original_binding.tenant_id=original.tenant_id
          and original_binding.principal_id=original.principal_id and original_binding.status='active'
          and (original_binding.workload_key='integration.symmy-admit' or (
            ${facts.sourcePurpose}='read' and original_binding.workload_key='integration.symmy-poll'
            and not exists(select 1 from core.access_workload_bindings preferred
              where preferred.tenant_id=original.tenant_id and preferred.principal_id=original.principal_id
                and preferred.workload_key='integration.symmy-admit' and preferred.status='active')
          ))
        where b.tenant_id=${facts.principal.tenantId}::uuid and b.workload_key=${workloadKey} and b.status='active'
          and ((receiver.kind='system' and ${systemCount}=1) or (${systemCount}=0 and ${service}))
          and (${route.legalEntityId ?? null}::uuid is null or exists(
            select 1 from core.legal_entities company where company.tenant_id=t.tenant_id
              and company.legal_entity_id=${route.legalEntityId ?? null}::uuid and company.status='active'))
        limit 2`,
            'objects',
          );
        }),
      )
      .pipe(
        recoverSqlTransactionError,
        Effect.mapError(delegationUnavailable('symmy_route_unavailable')),
        Effect.flatMap((records) =>
          Schema.decodeUnknownEffect(Schema.Array(nativeReadRowSchema))(records).pipe(
            Effect.mapError(delegationUnavailable('symmy_route_unavailable')),
          ),
        ),
      );
    const [receiver] = rows;
    if (rows.length !== 1 || receiver === undefined) {
      return yield* delegationForbidden('symmy_route_not_admitted')();
    }
    return receiver;
  });

  return selectNativeReadReceiver;
};

const makeLoadPrivacyDispatchRow = (database: CoreDatabase['Service']) => {
  const metadataFields = RegisteredGatewayPrivacyDispatchSchema.fields;
  const dispatchActionKey = 'privacy.core.dispatch-privacy-measure';
  const symmyModule = 'integration.symmy';
  const workerKey = 'integration.symmy.symmy-job-privacy-dispatch';
  type Handoff = typeof PrivacyMeasureHandoffSchema.Type;
  const rowSchema = Schema.Struct({
    claimActive: Schema.Boolean,
    claimId: Schema.OptionFromNullOr(Schema.NonEmptyString),
    deliveryId: metadataFields.deliveryId,
    dispatchInvocationId: metadataFields.dispatchInvocationId,
    domainEventId: metadataFields.domainEventId,
    eventPayload: PrivacyOutboxPayloadSchema,
    governanceLegalEntityId: metadataFields.governanceLegalEntityId,
    measureId: metadataFields.measureId,
    messageId: metadataFields.messageId,
    messagePayload: PrivacyOutboxPayloadSchema,
    principalId: metadataFields.principalId,
    tenantId: metadataFields.tenantId,
  });
  type Row = typeof rowSchema.Type;
  const isSupportedHandoff = (handoff: Handoff, row: Row): boolean => {
    const [resource] = handoff.resourceRefs;
    const [content] = handoff.contentScopeRefs;
    const match = /^integration\.symmy\.(?:job|sync-admission):(?<id>[a-fA-F\d-]+)$/u.exec(resource ?? '');
    return (
      validatePrivacyMeasureHandoff(handoff).length === 0 &&
      handoff.tenantId === row.tenantId &&
      handoff.owningCapability === symmyModule &&
      (handoff.kind === 'DELETE' || handoff.kind === 'ANONYMIZE') &&
      handoff.dispositionDecision === handoff.kind &&
      handoff.resourceRefs.length === 1 &&
      handoff.contentScopeRefs.length === 1 &&
      Schema.is(Schema.String.check(Schema.isUUID()))(match?.groups?.['id']) &&
      content === `${resource}#integration.symmy.job-intent` &&
      handoff.measureId === row.measureId &&
      computeCanonicalValueHash(handoff) === computeCanonicalValueHash(row.eventPayload.handoff)
    );
  };
  const loadPrivacyDispatchRow = Effect.fn('PrivacyDispatchEvidence.loadNative')(function* load(input: {
    readonly deliveryId?: string;
    readonly dispatchInvocationId?: string;
    readonly tenantId: string;
  }) {
    return yield* database.executor
      .transaction(
        Effect.fn('PrivacyDispatchEvidence.nativeTransaction')(function* native(transaction) {
          yield* transaction.execute(
            sql`select set_config('ontos.tenant_id',${input.tenantId},true),set_config('ontos.legal_entity_id','',true)`,
            'objects',
          );
          const selection =
            input.deliveryId === undefined
              ? sql`i.action_invocation_id=${input.dispatchInvocationId}::uuid`
              : sql`d.outbox_delivery_id=${input.deliveryId}::uuid`;
          const rows = yield* transaction.execute(
            sql`
      select i.action_invocation_id as "dispatchInvocationId",i.principal_id as "principalId",i.tenant_id as "tenantId",i.legal_entity_id as "governanceLegalEntityId",
        e.domain_event_id as "domainEventId",m.outbox_message_id as "messageId",d.outbox_delivery_id as "deliveryId",e.subject_resource_id as "measureId",
        e.payload_json as "eventPayload",m.payload_json as "messagePayload",d.claimed_by as "claimId",
        (d.status='processing' and d.claim_expires_at>now()) as "claimActive"
      from core.action_invocations i
      join core.principals p on p.tenant_id=i.tenant_id and p.principal_id=i.principal_id and p.kind='human'
      join core.tenants t on t.tenant_id=i.tenant_id and t.status='active'
      join core.legal_entities l on l.tenant_id=i.tenant_id and l.legal_entity_id=i.legal_entity_id and l.status='active'
      join core.domain_events e on e.tenant_id=i.tenant_id and e.action_invocation_id=i.action_invocation_id and e.legal_entity_id=i.legal_entity_id
      join core.outbox_messages m on m.tenant_id=e.tenant_id and m.domain_event_id=e.domain_event_id
      join core.outbox_deliveries d on d.outbox_message_id=m.outbox_message_id
      where i.tenant_id=${input.tenantId}::uuid and i.action_key=${dispatchActionKey} and i.status='succeeded' and ${selection}
        and e.producer_module_key=${privacyModule} and e.subject_module_key=${privacyModule} and e.subject_resource_type='privacy.core.privacy-measure'
        and e.event_type=${privacyOutboxTopic} and m.topic=${privacyOutboxTopic} and m.producer_module_key=${privacyModule}
        and d.consumer_module_key=${symmyModule} and d.worker_key=${workerKey}
      limit 2`,
            'objects',
          );
          const parsed = yield* Schema.decodeUnknownEffect(Schema.Array(rowSchema), { onExcessProperty: 'error' })(
            rows,
          ).pipe(Effect.mapError(delegationUnavailable('source_evidence_unavailable')));
          const [row] = parsed;
          if (parsed.length !== 1 || row === undefined || !isSupportedHandoff(row.messagePayload.handoff, row)) {
            return yield* delegationForbidden('privacy_dispatch_not_admitted')();
          }
          return row;
        }),
      )
      .pipe(
        recoverSqlTransactionError,
        Effect.mapError((cause) =>
          Schema.is(GatewayDelegationError)(cause)
            ? cause
            : delegationUnavailable('source_evidence_unavailable')(cause),
        ),
      );
  });

  return loadPrivacyDispatchRow;
};

const makeAdmitWorkload = (database: CoreDatabase['Service']) => {
  type WorkloadSubject = Extract<
    GatewayDelegationRequestPayload['subject'],
    { readonly _tag: 'RegisteredWorkload' | 'RegisteredAdmission' }
  >;
  type WorkerSubject = Extract<WorkloadSubject, { readonly _tag: 'RegisteredWorkload' }>;
  const workloadFields = RegisteredGatewayWorkloadSchema.fields;
  const actionKeySchema = Schema.NonEmptyString.pipe(
    Schema.brand('GatewaySourceActionKey'),
    Schema.decodeTo(Schema.String),
  );
  const legalEntityIdSchema = Schema.String.check(Schema.isUUID()).pipe(
    Schema.brand('GatewayLegalEntityId'),
    Schema.decodeTo(Schema.String),
  );
  const RowSchema = Schema.Struct({
    actionInvocationId: workloadFields.admissionInvocationId,
    bindingIncarnation: Schema.String.check(Schema.isUUID()),
    principalId: TrustedPrincipalContextSchema.fields.principalId,
  });
  const claimRowsSchema = Schema.Array(
    Schema.Struct({
      actionInvocationId: workloadFields.admissionInvocationId,
      consumerModuleKey: OntosModuleIdSchema,
      producerModuleKey: OntosModuleIdSchema,
      topic: Schema.NonEmptyString,
      workerKey: OntosModuleIdSchema,
    }),
  );
  const decodeClaimRows = Schema.decodeUnknownEffect(claimRowsSchema);
  const originalRowSchema = Schema.Struct({
    actionKey: actionKeySchema,
    bindingIncarnation: Schema.String.check(Schema.isUUID()),
    legalEntityId: Schema.OptionFromNullOr(legalEntityIdSchema),
    ownerBindingIncarnation: Schema.String.check(Schema.isUUID()),
    principalId: TrustedPrincipalContextSchema.fields.principalId,
    workloadKey: workloadFields.workloadKey,
  });
  type OriginalRow = typeof originalRowSchema.Type;
  type SourceContract = ShellInstalledCatalog['contracts'][number];
  const sourceActionKeyOf = (subject: WorkloadSubject): Option.Option<string> =>
    Match.value(subject).pipe(
      Match.tag('RegisteredWorkload', Option.none<string>),
      Match.tag('RegisteredAdmission', (admission) => Option.some(admission.sourceActionKey)),
      Match.exhaustive,
    );
  const runReferenceOf = (subject: WorkloadSubject): string =>
    Match.value(subject).pipe(
      Match.tag('RegisteredWorkload', (worker) => worker.deliveryId),
      Match.tag('RegisteredAdmission', (admission) => admission.actionInvocationId),
      Match.exhaustive,
    );
  const originalIsAllowed = (
    original: OriginalRow,
    source: SourceContract,
    actionKey: Option.Option<string>,
  ): boolean => {
    const actions = new Set(source.manifest.originatorActions);
    return (
      actions.has(original.actionKey) &&
      (Option.isNone(actionKey) || original.actionKey === actionKey.value) &&
      source.manifest.publicSurface.actions.some(
        (action) =>
          action.actionKey === original.actionKey &&
          action.accessWorkload?.workloads.some((key) => key === original.workloadKey) === true,
      )
    );
  };
  const admissionAuthContextMatches = (subject: WorkloadSubject, authContextRef: string | undefined): boolean =>
    Match.value(subject).pipe(
      Match.tag('RegisteredWorkload', () => true),
      Match.tag(
        'RegisteredAdmission',
        (admission) =>
          admission.expectedAuthContextRef === undefined || admission.expectedAuthContextRef === authContextRef,
      ),
      Match.exhaustive,
    );

  const completeWorkload = (
    subject: WorkloadSubject,
    moduleKey: string,
    workload: RegisteredGatewayWorkload,
  ): RegisteredGatewayWorkload => {
    const scoped =
      subject.legalEntityId === undefined ? workload : { ...workload, legalEntityId: subject.legalEntityId };
    return Match.value(subject).pipe(
      Match.tag('RegisteredWorkload', (worker) => ({
        ...scoped,
        claimId: worker.claimId,
        workerKey: worker.workerKey,
        workerModuleKey: moduleKey,
      })),
      Match.tag('RegisteredAdmission', () => scoped),
      Match.exhaustive,
    );
  };

  const admitWorkload = Effect.fn('GatewayNativeEvidence.admitWorkload')(function* admit(input: {
    readonly binding: GatewayModuleBinding;
    readonly destination: InstalledContract;
    readonly rule: GatewayRegisteredWorkloadRule;
    readonly source: InstalledContract;
    readonly subject: WorkloadSubject;
  }) {
    const { binding, destination, rule, source, subject } = input;
    return yield* database.executor
      .transaction(
        Effect.fn('GatewayDelegation.workloadEvidence')(function* workloadEvidence(transaction) {
          yield* transaction
            .execute(
              sql`select set_config('ontos.tenant_id', ${subject.tenantId}, true), set_config('ontos.legal_entity_id', '', true)`,
              'objects',
            )
            .pipe(recoverSqlTransactionError, Effect.mapError(delegationUnavailable('source_evidence_unavailable')));
          const runReference = runReferenceOf(subject);
          const actionInvocationId = yield* Match.value(subject).pipe(
            Match.tag('RegisteredAdmission', (admission) => Effect.succeed(admission.actionInvocationId)),
            Match.tag(
              'RegisteredWorkload',
              Effect.fn('GatewayDelegation.workerAdmission')(function* workerAdmission(worker: WorkerSubject) {
                const claims = yield* transaction
                  .execute(
                    sql`
        select e.action_invocation_id as "actionInvocationId", d.worker_key as "workerKey", d.consumer_module_key as "consumerModuleKey", m.producer_module_key as "producerModuleKey", m.topic
        from core.outbox_deliveries d
        join core.outbox_messages m on m.outbox_message_id = d.outbox_message_id
        join core.domain_events e on e.domain_event_id = m.domain_event_id and e.tenant_id = m.tenant_id
        where d.outbox_delivery_id = ${runReference}::uuid
          and d.worker_key = ${worker.workerKey} and d.consumer_module_key = ${source.manifest.module.id}
          and m.producer_module_key = ${source.manifest.module.id} and m.tenant_id = ${worker.tenantId}::uuid
          and d.status = 'processing' and d.claimed_by = ${worker.claimId} and d.claim_expires_at > now()
        limit 2
      `,
                    'objects',
                  )
                  .pipe(
                    recoverSqlTransactionError,
                    Effect.mapError(delegationUnavailable('source_evidence_unavailable')),
                    Effect.flatMap(decodeClaimRows),
                    Effect.mapError(delegationUnavailable('source_evidence_unavailable')),
                  );
                const [claim] = claims;
                if (claims.length !== 1 || claim === undefined) {
                  return yield* delegationForbidden('workload_source_not_admitted')();
                }
                if (
                  worker.operationRequirementKey !== undefined &&
                  !gatewayRegisteredWorkerOperationContractAllows(source, destination, rule, worker.legalEntityId, {
                    ...claim,
                    requirementKey: worker.operationRequirementKey,
                  })
                ) {
                  return yield* delegationForbidden('conditional_requirement_refused')();
                }
                return claim.actionInvocationId;
              }),
            ),
            Match.exhaustive,
          );
          let systems = yield* transaction
            .execute(
              sql`
      select b.incarnation as "bindingIncarnation", p.principal_id as "principalId", ${actionInvocationId} as "actionInvocationId"
      from core.access_workload_bindings b
      join core.tenants t on t.tenant_id = b.tenant_id and t.status = 'active'
      join core.principals p on p.tenant_id = b.tenant_id and p.principal_id = b.principal_id and p.kind = 'system' and p.status = 'active'
      where b.tenant_id = ${subject.tenantId}::uuid and b.workload_key = ${rule.workloadKey} and b.status = 'active'
      limit 2
    `,
              'objects',
            )
            .pipe(
              recoverSqlTransactionError,
              Effect.mapError(delegationUnavailable('source_evidence_unavailable')),
              Effect.flatMap((rows) =>
                Schema.decodeUnknownEffect(Schema.Array(RowSchema))(rows).pipe(
                  Effect.mapError(delegationUnavailable('source_evidence_unavailable')),
                ),
              ),
            );
          if (
            systems.length === 0 &&
            subject.legalEntityId !== undefined &&
            (rule.workloadKey === 'party.registry.source-write' ||
              rule.workloadKey === 'commerce.customer-context.source-write')
          ) {
            const principalId = internalWorkloadPrincipalId({
              legalEntityId: subject.legalEntityId,
              tenantId: subject.tenantId,
              workloadKey: rule.workloadKey,
            });
            systems = yield* transaction
              .execute(
                sql`
      select b.incarnation as "bindingIncarnation", p.principal_id as "principalId", ${actionInvocationId} as "actionInvocationId"
      from core.access_workload_bindings b
      join core.tenants t on t.tenant_id = b.tenant_id and t.status = 'active'
      join core.principals p on p.tenant_id = b.tenant_id and p.principal_id = b.principal_id
        and p.kind = 'service' and p.platform_role = 'internal_workload' and p.status = 'active'
      join core.access_workload_company_bindings cb on cb.tenant_id = b.tenant_id
        and cb.workload_binding_id = b.binding_id and cb.status = 'active'
      join core.legal_entities le on le.tenant_id = cb.tenant_id
        and le.legal_entity_id = cb.legal_entity_id and le.status = 'active'
      where b.tenant_id = ${subject.tenantId}::uuid and b.workload_key = ${rule.workloadKey} and b.status = 'active'
        and p.principal_id = ${principalId}::uuid and cb.legal_entity_id = ${subject.legalEntityId}::uuid
      limit 2
    `,
                'objects',
              )
              .pipe(
                recoverSqlTransactionError,
                Effect.mapError(delegationUnavailable('source_evidence_unavailable')),
                Effect.flatMap((rows) =>
                  Schema.decodeUnknownEffect(Schema.Array(RowSchema))(rows).pipe(
                    Effect.mapError(delegationUnavailable('source_evidence_unavailable')),
                  ),
                ),
              );
          }
          const [row] = systems;
          if (
            systems.length !== 1 ||
            row === undefined ||
            (subject.expectedPrincipalId !== undefined && row.principalId !== subject.expectedPrincipalId)
          ) {
            return yield* delegationForbidden('workload_binding_not_active')();
          }
          // The admitted integration identity outlives ingress credential rotation. Only its current
          // registered source workload, owner authority and active Principal govern fresh effects.
          const originals = yield* transaction
            .execute(
              sql`
      select i.action_key as "actionKey", i.principal_id as "principalId", i.legal_entity_id as "legalEntityId",
        b.workload_key as "workloadKey", b.incarnation as "bindingIncarnation", ob.incarnation as "ownerBindingIncarnation"
      from core.action_invocations i
      join core.principals p on p.tenant_id = i.tenant_id and p.principal_id = i.principal_id
        and p.kind = 'integration' and p.status = 'active'
      join core.access_workload_bindings b on b.tenant_id = p.tenant_id and b.principal_id = p.principal_id and b.status = 'active'
      join core.access_workload_bindings ob on ob.tenant_id = p.tenant_id
        and ob.principal_id = ${row.principalId}::uuid and ob.incarnation = ${row.bindingIncarnation}::uuid
        and ob.status = 'active' and ob.workload_key = ${rule.workloadKey}
      where i.tenant_id = ${subject.tenantId}::uuid and i.action_invocation_id = ${row.actionInvocationId}::uuid and i.status = 'succeeded'
        and ${originalPaymentAuthority('p', sql`b.workload_key`)}
    `,
              'objects',
            )
            .pipe(
              recoverSqlTransactionError,
              Effect.mapError(delegationUnavailable('source_evidence_unavailable')),
              Effect.flatMap((result) =>
                Schema.decodeUnknownEffect(Schema.Array(originalRowSchema))(result).pipe(
                  Effect.mapError(delegationUnavailable('source_evidence_unavailable')),
                ),
              ),
            );
          const actionKey = sourceActionKeyOf(subject);
          const eligible = originals.filter((original) => originalIsAllowed(original, source, actionKey));
          const [original] = eligible;
          if (
            eligible.length !== 1 ||
            original === undefined ||
            (subject.legalEntityId !== undefined &&
              Option.getOrUndefined(original.legalEntityId) !== subject.legalEntityId)
          ) {
            return yield* delegationForbidden('workload_source_not_admitted')();
          }
          const admissionContractAllows = Match.value(subject).pipe(
            Match.tag('RegisteredWorkload', () => true),
            Match.tag(
              'RegisteredAdmission',
              (admission) =>
                admission.operationRequirementKey === undefined ||
                gatewayRegisteredAdmissionOperationContractAllows(source, destination, rule, admission.legalEntityId, {
                  admissionActionKey: original.actionKey,
                  requirementKey: admission.operationRequirementKey,
                }),
            ),
            Match.exhaustive,
          );
          if (!admissionContractAllows) {
            return yield* delegationForbidden('conditional_requirement_refused')();
          }
          if (subject.legalEntityId !== undefined) {
            const companies = yield* transaction
              .execute(
                sql`select legal_entity_id from core.legal_entities where tenant_id = ${subject.tenantId}::uuid and legal_entity_id = ${subject.legalEntityId}::uuid and status = 'active'`,
                'objects',
              )
              .pipe(recoverSqlTransactionError, Effect.mapError(delegationUnavailable('source_evidence_unavailable')));
            if (companies.length !== 1) {
              return yield* delegationForbidden('legal_entity_not_active')();
            }
          }
          const principal = yield* Schema.decodeUnknownEffect(TrustedPrincipalContextSchema)({
            authContextRef: `job:${rule.jobKey}:run:${runReference}`,
            authMethod: 'system',
            principalId: row.principalId,
            tenantId: subject.tenantId,
          }).pipe(Effect.mapError(delegationForbidden('source_evidence_malformed')));
          if (!admissionAuthContextMatches(subject, principal.authContextRef)) {
            return yield* delegationForbidden('workload_source_not_admitted')();
          }
          const workload: RegisteredGatewayWorkload = {
            admissionInvocationId: actionInvocationId,
            bindingIncarnation: row.bindingIncarnation,
            declarationKey: rule.declarationKey,
            entrypointKey: rule.entrypointKey,
            jobKey: rule.jobKey,
            legalEntityScope: rule.legalEntityScope,
            originalOwnerBindingIncarnation: original.ownerBindingIncarnation,
            originalPrincipalId: original.principalId,
            originalWorkloadBindingIncarnation: original.bindingIncarnation,
            originalWorkloadKey: original.workloadKey,
            runReference,
            schemaVersion: rule.schemaVersion,
            sourceAppId: binding.sourceAppId,
            sourceBuildMarker: binding.sourceBuildMarker,
            sourceMode: Match.value(subject).pipe(
              Match.tag('RegisteredWorkload', () => 'worker' as const),
              Match.tag('RegisteredAdmission', () => 'admission' as const),
              Match.exhaustive,
            ),
            workloadKey: rule.workloadKey,
          };
          return {
            principal,
            sourceKey: runReference,
            workload: completeWorkload(subject, source.manifest.module.id, workload),
          };
        }),
      )
      .pipe(
        recoverSqlTransactionError,
        Effect.mapError((cause) =>
          Schema.is(GatewayDelegationError)(cause)
            ? cause
            : delegationUnavailable('source_evidence_unavailable')(cause),
        ),
      );
  });

  return admitWorkload;
};

const makeAdmitAssertion = (database: CoreDatabase['Service']) => {
  const admitAssertion = Effect.fn('GatewayNativeEvidence.admitAssertion')(function* admit(input: {
    readonly binding: GatewayModuleBinding;
    readonly rule: GatewayRegisteredWorkloadRule;
    readonly sourceAccess: ModuleEntrypointAccess;
    readonly sourcePrincipal: TrustedPrincipalContext;
    readonly subject: AssertionSubject;
    readonly workload: RegisteredGatewayWorkload;
  }) {
    const { binding, rule, sourceAccess, sourcePrincipal, subject, workload } = input;
    return yield* database.executor
      .transaction(
        Effect.fn('GatewayDelegation.registeredAssertionEvidence')(function* evidence(transaction) {
          yield* transaction
            .execute(
              sql`select set_config('ontos.tenant_id', ${sourcePrincipal.tenantId}, true), set_config('ontos.legal_entity_id', '', true)`,
              'objects',
            )
            .pipe(Effect.mapError(delegationUnavailable('source_evidence_unavailable')));
          const originalAuthority =
            workload.recovery === undefined
              ? sql`
        join core.principals original on original.tenant_id=t.tenant_id and original.principal_id=${workload.originalPrincipalId}::uuid and original.kind='integration' and original.status='active'
        join core.access_workload_bindings admission on admission.tenant_id=t.tenant_id and admission.principal_id=original.principal_id and admission.workload_key=${workload.originalWorkloadKey} and admission.incarnation=${workload.originalWorkloadBindingIncarnation}::uuid and admission.status='active'
          and ${originalPaymentAuthority('original', sql`${workload.originalWorkloadKey}`)}
        join core.access_workload_bindings owner on owner.tenant_id=t.tenant_id and owner.binding_id=receiver.binding_id and owner.principal_id=receiver.principal_id and owner.workload_key=${rule.workloadKey} and owner.status='active'
        join core.access_workload_bindings source_owner on source_owner.tenant_id=t.tenant_id and source_owner.binding_id=current_source.binding_id and source_owner.principal_id=source_principal.principal_id and source_owner.workload_key=${workload.workloadKey} and source_owner.incarnation=${workload.originalOwnerBindingIncarnation}::uuid and source_owner.status='active'
          `
              : sql``;
          const ownerBindingExpression = workload.recovery === undefined ? sql`owner.incarnation` : sql`null::uuid`;
          const rows = yield* transaction
            .execute(
              sql`
        select receiver.principal_id as "principalId", receiver.incarnation as "bindingIncarnation", ${ownerBindingExpression} as "ownerBindingIncarnation"
        from core.access_workload_bindings receiver
        join core.principals receiver_principal on receiver_principal.tenant_id=receiver.tenant_id and receiver_principal.principal_id=receiver.principal_id and receiver_principal.status='active'
        join core.tenants t on t.tenant_id=receiver.tenant_id and t.status='active'
        join core.principals source_principal on source_principal.tenant_id=t.tenant_id and source_principal.principal_id=${sourcePrincipal.principalId}::uuid and source_principal.status='active'
        join core.access_workload_bindings current_source on current_source.tenant_id=t.tenant_id and current_source.principal_id=${sourcePrincipal.principalId}::uuid and current_source.workload_key=${workload.workloadKey} and current_source.incarnation=${workload.bindingIncarnation}::uuid and current_source.status='active'
        ${originalAuthority}
        where receiver.tenant_id=${sourcePrincipal.tenantId}::uuid and receiver.workload_key=${rule.workloadKey} and receiver.status='active'
          and ${registeredAssertionPrincipalEligibility({
            side: 'receiver',
            tenantId: sourcePrincipal.tenantId,
            workloadKey: rule.workloadKey,
            // The installed rule may project to a tenant-only read; executor enrollment remains in the source company.
            legalEntityId: workload.legalEntityId,
          })}
          and ${registeredAssertionPrincipalEligibility({
            legalEntityId: workload.legalEntityId,
            side: 'source',
            tenantId: sourcePrincipal.tenantId,
            workloadKey: workload.workloadKey,
          })}
          and (${workload.sourceMode} <> 'worker' or trust.registered_workload_delivery_is_active(${workload.runReference}::uuid, ${workload.claimId ?? ''}, ${workload.workerKey ?? ''}, ${workload.workerModuleKey ?? ''}, ${sourcePrincipal.tenantId}::uuid))
          and (${workload.legalEntityId ?? null}::uuid is null or exists(select 1 from core.legal_entities l where l.tenant_id=t.tenant_id and l.legal_entity_id=${workload.legalEntityId ?? null}::uuid and l.status='active'))
        limit 2
      `,
              'objects',
            )
            .pipe(
              Effect.mapError(delegationUnavailable('source_evidence_unavailable')),
              Effect.flatMap((result) =>
                Schema.decodeUnknownEffect(
                  Schema.Array(
                    Schema.Struct({
                      bindingIncarnation: Schema.String.check(Schema.isUUID()),
                      ownerBindingIncarnation: Schema.OptionFromNullOr(Schema.String.check(Schema.isUUID())),
                      principalId: TrustedPrincipalContextSchema.fields.principalId,
                    }),
                  ),
                )(result).pipe(Effect.mapError(delegationUnavailable('source_evidence_unavailable'))),
              ),
            );
          const [row] = rows;
          if (
            rows.length !== 1 ||
            row === undefined ||
            (subject.expectedPrincipalId !== undefined && row.principalId !== subject.expectedPrincipalId)
          ) {
            return yield* delegationForbidden('workload_binding_not_active')();
          }
          const principal = yield* Schema.decodeUnknownEffect(TrustedPrincipalContextSchema)({
            authContextRef: `job:${rule.jobKey}:run:${workload.runReference}`,
            authMethod: 'system',
            principalId: row.principalId,
            tenantId: sourcePrincipal.tenantId,
          }).pipe(Effect.mapError(delegationForbidden('source_evidence_malformed')));
          const targetWorkload = targetWorkloadScope({
            ...workload,
            bindingIncarnation: row.bindingIncarnation,
            declarationKey: rule.declarationKey,
            entrypointKey: rule.entrypointKey,
            jobKey: rule.jobKey,
            legalEntityScope: rule.legalEntityScope,
            schemaVersion: rule.schemaVersion,
            sourceAppId: binding.sourceAppId,
            sourceBuildMarker: binding.sourceBuildMarker,
            workloadKey: rule.workloadKey,
          });
          if (workload.recovery !== undefined) {
            if (subject.recoveryRequestHash === undefined) {
              return yield* delegationForbidden('registered_workload_unmatched')();
            }
            const {
              originalOwnerBindingIncarnation: _originalOwnerBindingIncarnation,
              originalWorkloadBindingIncarnation: _originalWorkloadBindingIncarnation,
              originalWorkloadKey: _originalWorkloadKey,
              ...historicalWorkload
            } = targetWorkload;
            return {
              principal,
              sourceAccess,
              sourceKey: workload.runReference,
              workload: {
                ...historicalWorkload,
                recovery: { ...workload.recovery, requestHash: subject.recoveryRequestHash },
              },
            };
          }
          if (Option.isNone(row.ownerBindingIncarnation)) {
            return yield* delegationForbidden('workload_binding_not_active')();
          }
          return {
            principal,
            sourceAccess,
            sourceKey: workload.runReference,
            workload: {
              ...targetWorkload,
              originalOwnerBindingIncarnation: row.ownerBindingIncarnation.value,
            },
          };
        }),
      )
      .pipe(
        recoverSqlTransactionError,
        Effect.mapError((cause) =>
          Schema.is(GatewayDelegationError)(cause)
            ? cause
            : delegationUnavailable('source_evidence_unavailable')(cause),
        ),
      );
  });

  return admitAssertion;
};

const makeAdmitRecovery = (database: CoreDatabase['Service']) => {
  const workloadFields = RegisteredGatewayWorkloadSchema.fields;
  const sourceActionKeySchema = Schema.NonEmptyString.pipe(
    Schema.brand('GatewaySourceActionKey'),
    Schema.decodeTo(Schema.String),
  );
  const legalEntityIdSchema = Schema.String.check(Schema.isUUID()).pipe(
    Schema.brand('GatewayRecoveryLegalEntityId'),
    Schema.decodeTo(Schema.String),
  );
  const sourceRowsSchema = Schema.Array(
    Schema.Struct({
      actionInvocationId: workloadFields.admissionInvocationId,
      actionKey: sourceActionKeySchema,
      deliveryEvidence: Schema.optionalKey(
        Schema.Struct({
          consumerModuleKey: OntosModuleIdSchema,
          producerModuleKey: OntosModuleIdSchema,
          topic: Schema.NonEmptyString,
          workerKey: OntosModuleIdSchema,
        }),
      ),
      historicalEvidence: Schema.optionalKey(
        Schema.Struct({
          eventPayload: OutboxPayloadSchema,
          messagePayload: OutboxPayloadSchema,
          subjectResourceId: OutboxPayloadSchema.fields.jobId,
          subjectResourceType: Schema.Literal('integration.symmy.import-job'),
          topic: Schema.Literal(outboxTopic),
        }),
      ),
      legalEntityId: Schema.OptionFromNullOr(legalEntityIdSchema),
      principalId: TrustedPrincipalContextSchema.fields.principalId,
    }),
  );
  const ownerRowsSchema = Schema.Array(Schema.Struct({ actionInvocationId: workloadFields.admissionInvocationId }));
  const systemRowsSchema = Schema.Array(
    Schema.Struct({
      bindingIncarnation: Schema.String.check(Schema.isUUID()),
      principalId: TrustedPrincipalContextSchema.fields.principalId,
    }),
  );

  type SourceRow = (typeof sourceRowsSchema.Type)[number];

  const historicalAdmissionMatches = (row: SourceRow, proof: RecoverySource): boolean =>
    Match.value(proof).pipe(
      Match.tag('HistoricalDelivery', () => {
        const evidence = row.historicalEvidence;
        return (
          evidence !== undefined &&
          evidence.eventPayload.jobId === evidence.messagePayload.jobId &&
          evidence.eventPayload.jobId === evidence.subjectResourceId
        );
      }),
      Match.tag('Worker', () => true),
      Match.tag('Admission', () => true),
      Match.exhaustive,
    );

  const conditionalRecoveryContractAllows = (input: {
    readonly admission: SourceRow;
    readonly destination: InstalledContract;
    readonly proof: RecoverySource;
    readonly requirementKey: string;
    readonly rule: GatewayRegisteredWorkloadRule;
    readonly source: InstalledContract;
  }): boolean => {
    const { admission, destination, proof, requirementKey, rule, source } = input;
    const delivery = admission.deliveryEvidence;
    const workerAllows = () =>
      delivery !== undefined &&
      gatewayRegisteredWorkerOperationContractAllows(source, destination, rule, proof.legalEntityId, {
        ...delivery,
        requirementKey,
      });
    return Match.value(proof).pipe(
      Match.tag('Worker', workerAllows),
      Match.tag('HistoricalDelivery', workerAllows),
      Match.tag('Admission', () =>
        gatewayRegisteredAdmissionOperationContractAllows(source, destination, rule, proof.legalEntityId, {
          admissionActionKey: admission.actionKey,
          requirementKey,
        }),
      ),
      Match.exhaustive,
    );
  };

  const sourceAdmissionIsDeclared = (row: SourceRow, source: InstalledContract, proof: RecoverySource): boolean => {
    const permitted =
      source.manifest.originatorActions?.some((actionKey) => actionKey === row.actionKey) === true &&
      source.manifest.publicSurface.actions.some((action) => action.actionKey === row.actionKey);
    return (
      permitted &&
      Match.value(proof).pipe(
        Match.tag('Worker', () => true),
        Match.tag('HistoricalDelivery', () => true),
        Match.tag('Admission', (admission) => row.actionKey === admission.sourceActionKey),
        Match.exhaustive,
      )
    );
  };

  /** Owner scope is determined by its historical Action contract, independently of the receipt Read. */
  const originalCompanyOf = (action: OriginalAction, admission: SourceRow): Option.Option<string> =>
    action.legalEntityScope === 'forbidden' ? Option.none() : admission.legalEntityId;

  const recoveryCompanyMatches = (
    action: OriginalAction,
    admission: SourceRow,
    proof: RecoverySource,
    rule: GatewayRegisteredWorkloadRule,
  ): boolean => {
    const ownerCompany = originalCompanyOf(action, admission);
    if (action.legalEntityScope === 'required' && Option.isNone(ownerCompany)) {
      return false;
    }
    if (rule.legalEntityScope === 'forbidden') {
      return proof.legalEntityId === undefined;
    }
    if (rule.legalEntityScope === 'optional') {
      return proof.legalEntityId === Option.getOrUndefined(ownerCompany);
    }
    const requiredCompany = Option.orElse(ownerCompany, () => admission.legalEntityId);
    return Option.isSome(requiredCompany) && proof.legalEntityId === requiredCompany.value;
  };

  const admitRecovery = Effect.fn('GatewayNativeEvidence.admitRecovery')(function* admit(input: {
    readonly binding: GatewayModuleBinding;
    readonly destination: InstalledContract;
    readonly originalAction: OriginalAction;
    readonly recoveryOf: NonNullable<GatewayRegisteredWorkloadRule['recoveryOf']>;
    readonly rule: GatewayRegisteredWorkloadRule;
    readonly source: InstalledContract;
    readonly subject: RecoverySubject;
  }) {
    const { binding, destination, originalAction, recoveryOf, rule, source, subject } = input;
    const runReference = recoveryRunReference(subject.source);
    return yield* database.executor
      .transaction(
        Effect.fn('GatewayDelegation.recoveryEvidence')(function* recoveryEvidence(transaction) {
          const { source: proof } = subject;
          yield* transaction
            .execute(
              sql`select set_config('ontos.tenant_id', ${proof.tenantId}, true), set_config('ontos.legal_entity_id', '', true)`,
              'objects',
            )
            .pipe(Effect.mapError(delegationUnavailable('source_evidence_unavailable')));
          const sourceStatement = Match.value(proof).pipe(
            Match.tag(
              'Worker',
              (worker) => sql`
          select i.action_invocation_id as "actionInvocationId", i.action_key as "actionKey", i.legal_entity_id as "legalEntityId", i.principal_id as "principalId",
            jsonb_build_object('consumerModuleKey',d.consumer_module_key,'producerModuleKey',m.producer_module_key,'topic',m.topic,'workerKey',d.worker_key) as "deliveryEvidence"
          from core.outbox_deliveries d
          join core.outbox_messages m on m.outbox_message_id=d.outbox_message_id
          join core.domain_events e on e.domain_event_id=m.domain_event_id and e.tenant_id=m.tenant_id
          join core.action_invocations i on i.tenant_id=m.tenant_id and i.action_invocation_id=e.action_invocation_id and i.status='succeeded'
          join core.principals p on p.tenant_id=i.tenant_id and p.principal_id=i.principal_id and p.kind='integration'
          where d.outbox_delivery_id=${worker.deliveryId}::uuid and d.worker_key=${worker.workerKey} and d.claimed_by=${worker.claimId}
            and d.consumer_module_key=${source.manifest.module.id} and m.producer_module_key=${source.manifest.module.id}
            and m.tenant_id=${worker.tenantId}::uuid and d.status='processing' and d.claim_expires_at>now()
          limit 2`,
            ),
            Match.tag(
              'HistoricalDelivery',
              (delivery) => sql`
          select i.action_invocation_id as "actionInvocationId", i.action_key as "actionKey", i.legal_entity_id as "legalEntityId", i.principal_id as "principalId",
            jsonb_build_object('consumerModuleKey',d.consumer_module_key,'producerModuleKey',m.producer_module_key,'topic',m.topic,'workerKey',d.worker_key) as "deliveryEvidence",
            jsonb_build_object('eventPayload',e.payload_json,'messagePayload',m.payload_json,'subjectResourceId',e.subject_resource_id,'subjectResourceType',e.subject_resource_type,'topic',m.topic) as "historicalEvidence"
          from core.outbox_deliveries d
          join core.outbox_messages m on m.outbox_message_id=d.outbox_message_id
          join core.domain_events e on e.domain_event_id=m.domain_event_id and e.tenant_id=m.tenant_id
          join core.action_invocations i on i.tenant_id=m.tenant_id and i.action_invocation_id=e.action_invocation_id and i.status='succeeded'
          join core.principals p on p.tenant_id=i.tenant_id and p.principal_id=i.principal_id and p.kind='integration'
          where d.outbox_delivery_id=${delivery.deliveryId}::uuid and d.worker_key=${delivery.workerKey}
            and d.consumer_module_key=${outboxProducerModuleKey} and m.producer_module_key=${outboxProducerModuleKey}
            and e.producer_module_key=${outboxProducerModuleKey} and e.subject_module_key=${outboxProducerModuleKey}
            and m.topic=${outboxTopic} and e.event_type=${outboxTopic}
            and m.tenant_id=${delivery.tenantId}::uuid and e.legal_entity_id is not distinct from i.legal_entity_id
          limit 2`,
            ),
            Match.tag(
              'Admission',
              (admission) => sql`
          select i.action_invocation_id as "actionInvocationId", i.action_key as "actionKey", i.legal_entity_id as "legalEntityId", i.principal_id as "principalId"
          from core.action_invocations i
          join core.principals p on p.tenant_id=i.tenant_id and p.principal_id=i.principal_id and p.kind='integration'
          where i.tenant_id=${admission.tenantId}::uuid and i.action_invocation_id=${admission.actionInvocationId}::uuid
            and i.action_key=${admission.sourceActionKey} and i.status='succeeded'
          limit 2`,
            ),
            Match.exhaustive,
          );
          const admissions = yield* transaction.execute(sourceStatement, 'objects').pipe(
            Effect.mapError(delegationUnavailable('source_evidence_unavailable')),
            Effect.flatMap((rows) =>
              Schema.decodeUnknownEffect(sourceRowsSchema, { onExcessProperty: 'error' })(rows).pipe(
                Effect.mapError(delegationUnavailable('source_evidence_unavailable')),
              ),
            ),
          );
          const [admission] = admissions;
          if (
            admissions.length !== 1 ||
            admission === undefined ||
            !sourceAdmissionIsDeclared(admission, source, proof) ||
            !historicalAdmissionMatches(admission, proof) ||
            !recoveryCompanyMatches(originalAction, admission, proof, rule)
          ) {
            return yield* delegationForbidden('workload_source_not_admitted')();
          }
          if (
            subject.operationRequirementKey !== undefined &&
            !conditionalRecoveryContractAllows({
              admission,
              destination,
              proof,
              requirementKey: subject.operationRequirementKey,
              rule,
              source,
            })
          ) {
            return yield* delegationForbidden('conditional_requirement_refused')();
          }
          const ownerLegalEntityId = Option.getOrUndefined(originalCompanyOf(originalAction, admission));
          const originalAuthContextRef = `job:${recoveryOf.jobKey}:run:${runReference}`;
          const originals = yield* transaction
            .execute(
              sql`
        select i.action_invocation_id as "actionInvocationId"
        from core.action_invocations i
        where i.tenant_id=${proof.tenantId}::uuid and i.principal_id=${subject.originalPrincipalId}::uuid
          and i.action_key=${subject.originalActionKey} and i.idempotency_key=${subject.originalIdempotencyKey}
          and i.request_hash=${subject.originalRequestHash} and i.auth_method='system' and i.auth_context_ref=${originalAuthContextRef}
          and i.legal_entity_id is not distinct from ${ownerLegalEntityId ?? null}::uuid
        limit 2`,
              'objects',
            )
            .pipe(
              Effect.mapError(delegationUnavailable('source_evidence_unavailable')),
              Effect.flatMap((rows) =>
                Schema.decodeUnknownEffect(ownerRowsSchema)(rows).pipe(
                  Effect.mapError(delegationUnavailable('source_evidence_unavailable')),
                ),
              ),
            );
          const [original] = originals;
          if (originals.length !== 1 || original === undefined) {
            return yield* delegationForbidden('recovery_original_unmatched')();
          }
          const systems = yield* transaction
            .execute(
              registeredRecoveryReceiverStatement({
                legalEntityId: proof.legalEntityId,
                tenantId: proof.tenantId,
                workloadKey: rule.workloadKey,
              }),
              'objects',
            )
            .pipe(
              Effect.mapError(delegationUnavailable('source_evidence_unavailable')),
              Effect.flatMap((rows) =>
                Schema.decodeUnknownEffect(systemRowsSchema)(rows).pipe(
                  Effect.mapError(delegationUnavailable('source_evidence_unavailable')),
                ),
              ),
            );
          const [system] = systems;
          if (
            systems.length !== 1 ||
            system === undefined ||
            (subject.expectedPrincipalId !== undefined && system.principalId !== subject.expectedPrincipalId)
          ) {
            return yield* delegationForbidden('workload_binding_not_active')();
          }
          const principal = yield* Schema.decodeUnknownEffect(TrustedPrincipalContextSchema)({
            authContextRef: `job:${rule.jobKey}:run:${runReference}`,
            authMethod: 'system',
            principalId: system.principalId,
            tenantId: proof.tenantId,
          }).pipe(Effect.mapError(delegationForbidden('source_evidence_malformed')));
          const workload: RegisteredGatewayWorkload = {
            admissionInvocationId: admission.actionInvocationId,
            bindingIncarnation: system.bindingIncarnation,
            declarationKey: rule.declarationKey,
            entrypointKey: rule.entrypointKey,
            jobKey: rule.jobKey,
            legalEntityScope: rule.legalEntityScope,
            originalPrincipalId: admission.principalId,
            recovery: {
              originalActionInvocationId: original.actionInvocationId,
              originalActionKey: subject.originalActionKey,
              originalAuthContextRef,
              originalIdempotencyKey: subject.originalIdempotencyKey,
              originalPrincipalId: subject.originalPrincipalId,
              originalRequestHash: subject.originalRequestHash,
              requestHash: subject.requestHash,
            },
            runReference,
            schemaVersion: rule.schemaVersion,
            sourceAppId: binding.sourceAppId,
            sourceBuildMarker: binding.sourceBuildMarker,
            sourceMode: recoveryMode(proof),
            workloadKey: rule.workloadKey,
          };
          return {
            principal,
            sourceKey: runReference,
            workload: recoveryWorkloadScope(proof, source.manifest.module.id, workload),
          };
        }),
      )
      .pipe(
        recoverSqlTransactionError,
        Effect.mapError((cause) =>
          Schema.is(GatewayDelegationError)(cause)
            ? cause
            : delegationUnavailable('source_evidence_unavailable')(cause),
        ),
      );
  });

  return admitRecovery;
};

export type GatewayPrivacyDispatchRow = Effect.Success<ReturnType<ReturnType<typeof makeLoadPrivacyDispatchRow>>>;

export interface GatewayNativeEvidenceOperations {
  readonly admitAssertion: ReturnType<typeof makeAdmitAssertion>;
  readonly admitRecovery: ReturnType<typeof makeAdmitRecovery>;
  readonly admitWorkload: ReturnType<typeof makeAdmitWorkload>;
  readonly loadPrivacyDispatchRow: ReturnType<typeof makeLoadPrivacyDispatchRow>;
  readonly selectNativeReadReceiver: ReturnType<typeof makeSelectNativeReadReceiver>;
  readonly selectOnwardNativeReadReceiver: ReturnType<typeof makeSelectOnwardNativeReadReceiver>;
  readonly validateCurrentHuman: ReturnType<typeof makeValidateCurrentHuman>;
  readonly validatePaymentRoutePrincipal: ReturnType<typeof makeValidatePaymentRoutePrincipal>;
  readonly validateRoutePrincipal: ReturnType<typeof makeValidateRoutePrincipal>;
}

/** Captures database custody once. Operations expose only fixed native admission facts. */
export const GatewayNativeEvidenceLive = Layer.effect(
  GatewayNativeEvidence,
  Effect.gen(function* prepareNativeEvidence() {
    const database = yield* CoreDatabase;
    return {
      admitAssertion: makeAdmitAssertion(database),
      admitRecovery: makeAdmitRecovery(database),
      admitWorkload: makeAdmitWorkload(database),
      loadPrivacyDispatchRow: makeLoadPrivacyDispatchRow(database),
      selectNativeReadReceiver: makeSelectNativeReadReceiver(database),
      selectOnwardNativeReadReceiver: makeSelectOnwardNativeReadReceiver(database),
      validateCurrentHuman: makeValidateCurrentHuman(database),
      validatePaymentRoutePrincipal: makeValidatePaymentRoutePrincipal(database),
      validateRoutePrincipal: makeValidateRoutePrincipal(database),
    } satisfies GatewayNativeEvidenceOperations;
  }),
);
