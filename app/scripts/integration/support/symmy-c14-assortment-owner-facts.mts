import { randomUUID } from 'node:crypto';

import type { PgClient } from '@effect/sql-pg';
import { Effect } from 'effect';

interface FixtureScope {
  readonly admin: PgClient.PgClient;
  readonly principalId: string;
  readonly sellerId: string;
  readonly tenantId: string;
}
interface FixtureFacts {
  readonly group: string;
  readonly market: string;
  readonly product: string;
  readonly storefront: string;
  readonly storefrontAppId: string;
}

const activeFrom = '2026-10-01T00:00:00.000Z';
const reason = 'Synthetic C14 Assortment owner configuration';

/** Install real owner records only in the disposable composed-proof database. */
export const prepareAssortmentFixtureOwnerFacts = Effect.fn('SymmyC14Assortment.prepareOwnerFacts')(
  function* prepareFacts({ admin, principalId, sellerId, tenantId }: FixtureScope, facts: FixtureFacts) {
    const definition = randomUUID();
    const association = randomUUID();
    const { storefront } = facts;
    const productAction = randomUUID();
    const groupAction = randomUUID();
    const marketAction = randomUUID();
    const storefrontAction = randomUUID();
    yield* admin.withTransaction(
      Effect.gen(function* prepareTransaction() {
        yield* admin`insert into catalog.products
          (product_id,tenant_id,lifecycle_state,name,created_by_action_invocation_id,created_by_principal_id)
          values(${facts.product},${tenantId},'ACTIVE','C14 Assortment Product',${productAction},${principalId})`;
        yield* admin`insert into catalog.product_category_hierarchy_revisions (tenant_id) values(${tenantId})`;
        yield* admin`insert into commerce_customer_context.customer_groups
          (customer_group_id,tenant_id,legal_entity_id,meaning_key,stable_code)
          values(${facts.group},${tenantId},${sellerId},'c14.assortment.group','C14_ASSORTMENT_GROUP')`;
        yield* admin`insert into commerce_customer_context.customer_group_revisions
          (customer_group_id,tenant_id,legal_entity_id,change_kind,description,display_name,membership_criteria,purpose,revision,semantic_fingerprint,action_invocation_id,actor_principal_id,reason)
          values(${facts.group},${tenantId},${sellerId},'CREATED',${reason},'C14 Assortment Group',${reason},${reason},1,encode(sha256(convert_to(jsonb_build_array(lower(${reason}::text),lower(${reason}::text))::text,'UTF8')),'hex'),${groupAction},${principalId},${reason})`;
        yield* admin`insert into commerce_customer_context.customer_group_lifecycle_periods
          (customer_group_id,tenant_id,legal_entity_id,active_from,revision,action_invocation_id,actor_principal_id,reason)
          values(${facts.group},${tenantId},${sellerId},${activeFrom},1,${groupAction},${principalId},${reason})`;

        yield* admin`insert into storefront_registry.storefront_applications
          (storefront_application_id,tenant_id,storefront_app_id,current_revision)
          values(${storefront},${tenantId},${facts.storefrontAppId},1)`;
        yield* admin`insert into storefront_registry.storefront_application_revisions
          (tenant_id,storefront_application_id,revision_number,allowed_channels,lifecycle,effective_from,reason,action_invocation_id,acting_principal_id)
          values(${tenantId},${storefront},1,'["B2C"]'::jsonb,'ACTIVE',${activeFrom},${reason},${storefrontAction},${principalId})`;
        yield* admin`insert into storefront_registry.storefront_registry_generations
          (tenant_id,generation,last_action_invocation_id) values(${tenantId},1,${storefrontAction})`;

        yield* admin`insert into commerce_market_catalog.markets
          (market_id,tenant_id,selling_legal_entity_id,business_code,created_by_action_invocation_id,created_by_principal_id)
          values(${facts.market},${tenantId},${sellerId},'C14_ASSORTMENT',${marketAction},${principalId})`;
        yield* admin`insert into commerce_market_catalog.market_definition_revisions
          (market_definition_revision_id,tenant_id,market_id,selling_legal_entity_id,revision_number,purpose,channels,jurisdictions,supported_locales,effective_from,change_reason,action_invocation_id,acting_principal_id)
          values(${definition},${tenantId},${facts.market},${sellerId},1,${reason},'["B2C"]'::jsonb,'[{"kind":"COUNTRY","code":"CZ"}]'::jsonb,'["cs-CZ"]'::jsonb,${activeFrom},${reason},${marketAction},${principalId})`;
        yield* admin`update commerce_market_catalog.markets set current_definition_revision_id=${definition}
          where tenant_id=${tenantId} and market_id=${facts.market}`;
        yield* admin`insert into commerce_market_catalog.market_lifecycle_periods
          (tenant_id,market_id,selling_legal_entity_id,revision_number,lifecycle,effective_from,reason,action_invocation_id,acting_principal_id)
          values(${tenantId},${facts.market},${sellerId},1,'ACTIVE',${activeFrom},${reason},${marketAction},${principalId})`;
        yield* admin`insert into commerce_market_catalog.storefront_associations
          (storefront_association_id,tenant_id,selling_legal_entity_id,created_by_action_invocation_id,created_by_principal_id)
          values(${association},${tenantId},${sellerId},${marketAction},${principalId})`;
        yield* admin`insert into commerce_market_catalog.storefront_association_revisions
          (tenant_id,storefront_association_id,revision_number,market_id,market_definition_revision_id,selling_legal_entity_id,storefront_app_id,channel,effective_from,provenance_kind,provenance_reference,reason,action_invocation_id,acting_principal_id)
          values(${tenantId},${association},1,${facts.market},${definition},${sellerId},${facts.storefrontAppId},'B2C',${activeFrom},'CONFIGURATION_ACTION',${reason},${reason},${marketAction},${principalId})`;
        yield* admin`insert into commerce_market_catalog.market_catalog_completeness_generations
          (tenant_id,generation,last_action_invocation_id) values(${tenantId},1,${marketAction})`;
      }),
    );
  },
);

/** Change the synthetic Group through its real lifecycle routine, preserving its revision history. */
export const changeAssortmentFixtureGroup = (
  { admin, principalId, sellerId, tenantId }: FixtureScope,
  groupId: string,
  transition: 'archive' | 'reactivate',
  expectedRevision: number,
) =>
  admin.withTransaction(
    Effect.gen(function* changeGroupLifecycle() {
      yield* admin`select set_config('ontos.tenant_id',${tenantId},true), set_config('ontos.legal_entity_id',${sellerId},true)`;
      const [changed] = yield* transition === 'archive'
        ? admin<{
            actual_revision: number;
            outcome: string;
          }>`select outcome,actual_revision from commerce_customer_context.archive_customer_group(
            ${tenantId},${sellerId},${groupId},${expectedRevision},statement_timestamp(),${reason},statement_timestamp(),${principalId},${randomUUID()})`
        : admin<{
            actual_revision: number;
            outcome: string;
          }>`select outcome,actual_revision from commerce_customer_context.reactivate_customer_group(
            ${tenantId},${sellerId},${groupId},${expectedRevision},statement_timestamp(),${reason},statement_timestamp(),${principalId},${randomUUID()})`;
      return changed;
    }),
  );

/** Append an actual Storefront Registry revision while keeping the pinned appId and resource UUID. */
export const changeAssortmentFixtureStorefront = (
  { admin, principalId, tenantId }: FixtureScope,
  storefrontId: string,
  lifecycle: 'ACTIVE' | 'SUSPENDED',
  expectedRevision: number,
) =>
  admin.withTransaction(
    Effect.gen(function* changeStorefrontLifecycle() {
      yield* admin`select set_config('ontos.tenant_id',${tenantId},true)`;
      const [changed] = yield* admin<{ outcome: string }>`select payload->>'_tag' as outcome
        from storefront_registry.revise_storefront_application(${tenantId},jsonb_build_object(
          'actionInvocationId',${randomUUID()}::uuid,
          'allowedChannels','["B2C"]'::jsonb,
          'effectiveInterval',jsonb_build_object('effectiveFrom',statement_timestamp()),
          'expectedRevision',${expectedRevision}::integer,
          'lifecycle',${lifecycle}::text,
          'principalId',${principalId}::uuid,
          'reason',${reason}::text,
          'recordedAt',statement_timestamp(),
          'storefrontApplicationRef',jsonb_build_object(
            'moduleId','commerce.storefront-registry',
            'resourceId',${storefrontId}::uuid,
            'resourceType','commerce.storefront-registry.storefront-application',
            'tenantId',${tenantId}::uuid
          )
        ))`;
      return changed;
    }),
  );
