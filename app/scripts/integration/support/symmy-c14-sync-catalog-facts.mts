import { CreateProductPayloadSchema } from '@app/catalog/api/create-product-action';
import { CreateProductRecoveryResponseSchema } from '@app/catalog/api/create-product-recovery';
import { ProductActionInvocationIdSchema } from '@app/catalog/domain/product';
import { GovernVariantAxesRecoveryResponseSchema } from '@app/catalog/api/govern-variant-axes-recovery';
import { ConfirmVariantCombinationResultSchema } from '@app/catalog/api/confirm-variant-combination-recovery';
import { SetProductLocalizedFactsRecoveryResponseSchema } from '@app/catalog/api/set-product-localized-facts-recovery';
import { UpdateProductRecoveryResponseSchema } from '@app/catalog/api/update-product-recovery';
import { SetProductUnitTargetDivisibilityResultSchema } from '@app/catalog/api/set-product-unit-target-divisibility-recovery';
import { DecideProductTypeUnnecessaryResultSchema } from '@app/catalog/api/decide-product-type-unnecessary-recovery';
import { ProductRefSchema } from '@app/catalog-selection-contracts/resources/product';
import { VariantRefSchema } from '@app/catalog-selection-contracts/resources/variant';
import type { ProductUnitRefSchema } from '@app/catalog-selection-contracts/resources/product-unit';
import { SymmyEffectOutcomeSchema, SymmyOwnerEffectRefSchema } from '@app/shared-contracts/symmy';
import { assert, expect } from 'effect-rstest';
import { Effect, Option, Schema } from 'effect';

import type { prepareInternalSyncAuthority } from './symmy-c14-sync-authority.mts';
import { internalSyncSource } from './symmy-c14-sync-plans.mts';

type Authority = Effect.Success<ReturnType<typeof prepareInternalSyncAuthority>>;
const uuid = Schema.String.check(Schema.isUUID());
const digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const productReceiptSchema = Schema.TaggedStruct('ProductCreated', {
  actionInvocationId: ProductActionInvocationIdSchema,
  initialVariantRef: VariantRefSchema,
  productRef: ProductRefSchema,
  productRevision: CreateProductRecoveryResponseSchema.fields.product.fields.revision,
  variantRevision: CreateProductRecoveryResponseSchema.fields.product.fields.revision,
});
const snapshotSchema = Schema.Struct({
  acting_principal_id: uuid,
  action_key: Schema.String,
  committed_reply: Schema.Struct({ encoded: Schema.Json, kind: Schema.Literal('result') }),
  core_action_key: Schema.String,
  core_principal_id: uuid,
  core_request_hash: digest,
  core_status: Schema.Literal('succeeded'),
  effect_key: Schema.String,
  invocation_id: uuid,
  outcome: SymmyEffectOutcomeSchema.members[0],
  owner_executor_principal_id: uuid,
  owner_receipt: Schema.OptionFromNullOr(Schema.Json),
  owner_request_hash: digest,
  product_receipt: productReceiptSchema,
  product_result: CreateProductRecoveryResponseSchema,
  ref: SymmyOwnerEffectRefSchema,
  result: Schema.Json,
  schema_version: Schema.Literal(1),
  source_product: CreateProductPayloadSchema,
});
const axesReceiptSchema = Schema.TaggedStruct('ReadinessAxes', {
  axisRevision: GovernVariantAxesRecoveryResponseSchema.fields.axisRevision,
});
const variantReceiptSchema = Schema.TaggedStruct('ReadinessVariant', {
  variantRevision: UpdateProductRecoveryResponseSchema.fields.product.fields.revision,
});
const activationReceiptSchema = Schema.TaggedStruct('ReadinessProduct', {
  productRevision: UpdateProductRecoveryResponseSchema.fields.product.fields.revision,
});
const correlationSchema = Schema.Struct({
  acting_principal_id: uuid,
  action_invocation_id: uuid,
  core_action_key: Schema.Literal('commerce.catalog.create-product'),
  core_principal_id: uuid,
  core_status: Schema.Literal('succeeded'),
  entity_kind: Schema.Literals(['PRODUCT', 'VARIANT']),
  intent_fingerprint: digest,
  issuer_id: Schema.String,
  mapping_revision: Schema.String,
  product_id: uuid,
  record_id: Schema.String,
  record_namespace: Schema.String,
  route_scope: Schema.String,
  tenant_id: uuid,
  variant_id: uuid,
});
const currentSchema = Schema.Struct({
  axes: Schema.Array(uuid),
  axis_revision: Schema.Int,
  combination_axis_revision: Schema.Int,
  combination_key: digest,
  decision_actor: uuid,
  decision_revision: Schema.Int,
  decision_state: Schema.Literal('CONFIRMED'),
  divisible: Schema.Literal(false),
  locale: Schema.Literal('en'),
  localized_revision: Schema.Int,
  localized_state: Schema.Literal('SET'),
  name: Schema.String,
  product_lifecycle: Schema.Literal('ACTIVE'),
  product_revision: Schema.Int,
  structured_attributes_required: Schema.Literal(false),
  unit_id: uuid,
  unit_revision: Schema.Int,
  value_revision_tokens: Schema.Array(Schema.String),
  variant_axes_required: Schema.Literal(false),
  variant_lifecycle: Schema.Literal('ACTIVE'),
  variant_revision: Schema.Int,
  variant_revision_tokens: Schema.Array(Schema.String),
});

/** Reads committed owner evidence, not just the worker's accepted status labels. */
export const assertInternalSyncCatalog = Effect.fn('InternalC14Sync.catalogReadinessEvidence')(
  function* catalogReadinessEvidence(input: {
    readonly adoption: boolean;
    readonly authority: Authority;
    readonly jobId: string;
    readonly keys: readonly string[];
    readonly sourceRouteId: string;
    readonly unitRef: typeof ProductUnitRefSchema.Type;
  }) {
    const { admin, systemPrincipalId, tenantId } = input.authority;
    const snapshots = yield* admin`
      select e.effect_key, coalesce(e.resolved_effect,e.effect)->'ref' as ref,
        e.resolved_effect#>'{intent,payload,sourceProduct}' as source_product,
        e.owner_invocation_id as invocation_id, e.owner_executor_principal_id, e.owner_request_hash,
        e.owner_receipt, e.outcome, parent.owner_receipt as product_receipt,
        original.encoded_result as product_result,
        s.action_key, s.acting_principal_id, s.schema_version, s.encoded_result as result,
        i.status as core_status, i.action_key as core_action_key, i.principal_id as core_principal_id,
        i.request_hash as core_request_hash, i.committed_reply_json as committed_reply
      from symmy_integration.job_effects e
      join symmy_integration.job_effects parent on parent.tenant_id=e.tenant_id and parent.job_id=e.job_id
        and parent.item_id=e.item_id and parent.effect_key='product-create'
      left join catalog.catalog_result_snapshots original on original.tenant_id=parent.tenant_id
        and original.action_invocation_id::text=parent.owner_receipt->>'actionInvocationId'
        and original.action_key='commerce.catalog.create-product'
        and original.acting_principal_id=e.owner_executor_principal_id
        and original.schema_version=1
      left join catalog.catalog_result_snapshots s on s.tenant_id=e.tenant_id
        and s.action_invocation_id=e.owner_invocation_id
      left join core.action_invocations i on i.tenant_id=e.tenant_id
        and i.action_invocation_id=e.owner_invocation_id
      where e.tenant_id=${tenantId} and e.job_id=${input.jobId} and e.effect_key like 'readiness-%'
      order by e.effect_key
    `.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(snapshotSchema))));
    expect(snapshots).toHaveLength(input.keys.length * 6);
    return yield* Effect.forEach(
      input.keys,
      Effect.fn('InternalC14Sync.catalogSkuEvidence')(function* skuEvidence(key: string) {
        const recordId = `product:sku:${key}`;
        const rows = snapshots.filter(({ ref }) => ref.occurrence.record.sourceRecordId === recordId);
        expect(rows).toHaveLength(6);
        const rowFor = (effectKey: string) => {
          const matches = rows.filter(({ effect_key }) => effect_key === effectKey);
          expect(matches).toHaveLength(1);
          const [row] = matches;
          assert.isDefined(row);
          return row;
        };
        const axesRow = rowFor('readiness-axes');
        const confirmRow = rowFor('readiness-confirm');
        const nameRow = rowFor('readiness-name');
        const activateRow = rowFor('readiness-activate');
        const unitRow = rowFor('readiness-unit');
        const untypedRow = rowFor('readiness-untyped');
        const receipt = axesRow.product_receipt;
        const { initialVariantRef, productRef } = receipt;
        const original = axesRow.product_result;
        expect(original.product.productRef).toEqual(productRef);
        expect(original.variantId).toBe(initialVariantRef.resourceId);
        expect(receipt.productRevision).toBe(original.product.revision);
        assert.isDefined(original.initialVariantRevision);
        expect(receipt.variantRevision).toBe(original.initialVariantRevision);
        expect(productRef.tenantId).toBe(tenantId);
        expect(initialVariantRef.tenantId).toBe(tenantId);
        for (const [row, action] of [
          [axesRow, 'govern-variant-axes'],
          [confirmRow, 'confirm-variant-combination'],
          [nameRow, 'set-product-localized-facts'],
          [activateRow, 'update-product'],
          [unitRow, 'set-product-unit-target-divisibility'],
          [untypedRow, 'decide-product-type-unnecessary'],
        ] as const) {
          const actionKey = `commerce.catalog.${action}`;
          expect(row.action_key).toBe(actionKey);
          expect(row.core_action_key).toBe(actionKey);
          expect(row.ref.operation).toEqual({
            entrypointKey: actionKey,
            moduleId: 'commerce.catalog',
            schemaVersion: '1',
          });
          expect(row.ref.originalTarget).toEqual(productRef);
          expect(row.owner_executor_principal_id).toBe(systemPrincipalId);
          expect(row.core_principal_id).toBe(systemPrincipalId);
          expect(row.acting_principal_id).toBe(systemPrincipalId);
          expect(row.owner_request_hash).toBe(row.core_request_hash);
          expect(row.committed_reply.encoded).toEqual(row.result);
          expect(row.product_receipt).toEqual(receipt);
          expect(row.product_result).toEqual(original);
          expect(row.outcome.effectId).toBe(row.ref.effectId);
          expect(row.outcome.owner).toBe('commerce.catalog');
          expect(row.outcome.status).toBe(input.adoption ? 'accepted_no_change' : 'accepted_change');
          expect(row.ref.occurrence.record).toEqual({
            entityKind: 'PRODUCT',
            issuerId: internalSyncSource.issuerId,
            route: { integrationRouteId: input.sourceRouteId, tenantId },
            sourceNamespace: internalSyncSource.namespace,
            sourceRecordId: recordId,
          });
          expect(row.source_product.sourceCorrelation).toMatchObject({
            initialVariantRecordId: `variant:sku:${key}`,
            issuerId: internalSyncSource.issuerId,
            mappingRevision: internalSyncSource.mappingVersion,
            recordId,
            recordNamespace: internalSyncSource.namespace,
            routeScope: input.sourceRouteId,
          });
          expect(row.source_product.variantId).toBe(initialVariantRef.resourceId);
          expect(row.source_product.name).toBe(key);
          expect(row.ref.routeRevision).toBe(internalSyncSource.routeRevision);
          expect(row.ref.mappingVersion).toBe(internalSyncSource.mappingVersion);
        }
        const axes = yield* Schema.decodeUnknownEffect(GovernVariantAxesRecoveryResponseSchema)(axesRow.result);
        const confirmed = yield* Schema.decodeUnknownEffect(ConfirmVariantCombinationResultSchema)(confirmRow.result);
        const name = yield* Schema.decodeUnknownEffect(SetProductLocalizedFactsRecoveryResponseSchema)(nameRow.result);
        const activated = yield* Schema.decodeUnknownEffect(UpdateProductRecoveryResponseSchema)(activateRow.result);
        const unit = yield* Schema.decodeUnknownEffect(SetProductUnitTargetDivisibilityResultSchema)(unitRow.result);
        const untyped = yield* Schema.decodeUnknownEffect(DecideProductTypeUnnecessaryResultSchema)(untypedRow.result);
        for (const result of [axes, confirmed, name, activated, unit, untyped]) {
          expect(result.changed).toBe(!input.adoption);
        }
        expect(axes.productRef).toEqual(productRef);
        const axesReceipt = yield* Schema.decodeUnknownEffect(axesReceiptSchema)(
          Option.getOrUndefined(axesRow.owner_receipt),
        );
        expect(axesReceipt.axisRevision).toBe(axes.axisRevision);
        expect(confirmed.variant.productRef).toEqual(productRef);
        expect(confirmed.variant.variantRef).toEqual(initialVariantRef);
        expect(confirmed.variant.lifecycle).toBe('ACTIVE');
        expect(confirmed.combinationAxisRevision).toBe(axes.axisRevision);
        // Independent SHA-256 known vector for the axis-free [] encoding, not the Action's own result.
        expect(confirmed.combinationKey).toBe('4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945');
        assert.isDefined(confirmed.variantRevision);
        const variantReceipt = yield* Schema.decodeUnknownEffect(variantReceiptSchema)(
          Option.getOrUndefined(confirmRow.owner_receipt),
        );
        expect(variantReceipt.variantRevision).toBe(confirmed.variantRevision);
        expect(activated.product.productRef).toEqual(productRef);
        expect(activated.product.lifecycle).toBe('ACTIVE');
        expect(activated.product.variants).toEqual([confirmed.variant]);
        const activationReceipt = yield* Schema.decodeUnknownEffect(activationReceiptSchema)(
          Option.getOrUndefined(activateRow.owner_receipt),
        );
        expect(activationReceipt.productRevision).toBe(activated.product.revision);
        expect(unit.unit).toEqual(input.unitRef);
        expect(unit.ruleRevision.unit).toEqual(input.unitRef);
        assert.isDefined(unit.targetDivisibility);
        expect(unit.targetDivisibility).toMatchObject({
          divisible: false,
          targetId: initialVariantRef.resourceId,
          targetType: 'commerce.catalog.variant',
          tenantId,
          unit: input.unitRef,
        });
        expect(untyped.productRef).toEqual(productRef);
        expect(untyped.decisionState).toBe('CONFIRMED');
        const correlations = yield* admin`
          select c.*, i.status as core_status, i.action_key as core_action_key, i.principal_id as core_principal_id
          from catalog.catalog_source_correlations c
          left join core.action_invocations i on i.tenant_id=c.tenant_id and i.action_invocation_id=c.action_invocation_id
          where c.tenant_id=${tenantId} and c.product_id=${productRef.resourceId}
          order by c.entity_kind, c.record_id
        `.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(correlationSchema))));
        expect(correlations).toHaveLength(2);
        expect(correlations.map(({ entity_kind, record_id }) => ({ entity_kind, record_id }))).toEqual([
          { entity_kind: 'PRODUCT', record_id: recordId },
          { entity_kind: 'VARIANT', record_id: `variant:sku:${key}` },
        ]);
        for (const correlation of correlations) {
          expect(correlation).toMatchObject({
            acting_principal_id: systemPrincipalId,
            action_invocation_id: receipt.actionInvocationId,
            core_principal_id: systemPrincipalId,
            issuer_id: internalSyncSource.issuerId,
            mapping_revision: internalSyncSource.mappingVersion,
            product_id: productRef.resourceId,
            record_namespace: internalSyncSource.namespace,
            route_scope: input.sourceRouteId,
            tenant_id: tenantId,
            variant_id: initialVariantRef.resourceId,
          });
        }
        const currentRows = yield* admin`
          select p.lifecycle_state as product_lifecycle, p.current_revision as product_revision,
            v.lifecycle_state as variant_lifecycle, v.current_revision as variant_revision,
            v.combination_axis_revision, v.combination_key,
            a.axis_revision, a.attribute_definition_ids as axes,
            l.locale, l.current_revision as localized_revision, l.state as localized_state, l.name,
            u.unit_id, u.current_revision as unit_revision, u.divisible,
            d.decision_revision, d.decision_state, d.structured_attributes_required, d.variant_axes_required,
            d.value_revision_tokens, d.variant_revision_tokens, d.acting_principal_id as decision_actor
          from catalog.products p
          join catalog.product_variants v on v.tenant_id=p.tenant_id and v.product_id=p.product_id
          join catalog.product_variant_axis_events a on a.tenant_id=p.tenant_id and a.product_id=p.product_id
          join catalog.product_localized_facts l on l.tenant_id=p.tenant_id and l.product_id=p.product_id
          join catalog.variant_unit_divisibility u on u.tenant_id=v.tenant_id and u.variant_id=v.variant_id
          join catalog.product_type_untyped_decisions d on d.tenant_id=p.tenant_id and d.product_id=p.product_id
          where p.tenant_id=${tenantId} and p.product_id=${productRef.resourceId}
            and v.variant_id=${initialVariantRef.resourceId}
        `.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(currentSchema))));
        expect(currentRows).toHaveLength(1);
        const [current] = currentRows;
        expect(current).toEqual({
          axes: [],
          axis_revision: axes.axisRevision,
          combination_axis_revision: confirmed.combinationAxisRevision,
          combination_key: confirmed.combinationKey,
          decision_actor: systemPrincipalId,
          decision_revision: untyped.decisionRevision,
          decision_state: 'CONFIRMED',
          divisible: false,
          locale: 'en',
          localized_revision: name.revision,
          localized_state: 'SET',
          name: key,
          product_lifecycle: 'ACTIVE',
          product_revision: activated.product.revision,
          structured_attributes_required: false,
          unit_id: input.unitRef.resourceId,
          unit_revision: unit.targetDivisibility.revision,
          value_revision_tokens: [],
          variant_axes_required: false,
          variant_lifecycle: 'ACTIVE',
          variant_revision: confirmed.variantRevision,
          variant_revision_tokens: [`${initialVariantRef.resourceId}:${confirmed.variantRevision}`],
        });
        return {
          invocations: rows.map(({ effect_key, invocation_id }) => ({
            effectKey: effect_key,
            invocationId: invocation_id,
          })),
          key,
          productReceipt: receipt,
          snapshots: rows.map(({ effect_key, result }) => ({ effectKey: effect_key, result })),
          state: { correlations, current, productRef, variantRef: initialVariantRef },
        };
      }),
      { concurrency: 1 },
    );
  },
);
