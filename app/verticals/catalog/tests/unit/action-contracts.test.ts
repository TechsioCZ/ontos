import { describe, expect, it } from 'effect-rstest';
import { Schema } from 'effect';

import {
  ActionCommitIndeterminate,
  ActionPermissionCheckError,
  ActionPermissionDenied,
  ActionRequestHashConflict,
} from '@app/core-runtime';
import { mapCorrectProductActionProblem } from '../../api/correct-product-action-problems.ts';
import { mapCreateProductActionProblem } from '../../api/create-product-action-problems.ts';
import { mapReactivateProductActionProblem } from '../../api/reactivate-product-action-problems.ts';
import { mapRetireProductActionProblem } from '../../api/retire-product-action-problems.ts';
import { mapUpdateProductActionProblem } from '../../api/update-product-action-problems.ts';

import { CorrectProductPayloadSchema, correctProductAction } from '../../src/actions/correct-product.action.ts';
import { ProductSelectionRevalidationRequiredSchema } from '../../shared/actions/correct-product.ts';
import { catalogAuthorityBundles } from '../../shared/api.ts';
import { ProductPersistenceConflict } from '../../shared/domain/product-errors.ts';
import { CatalogPersistenceConflict, CatalogPersistenceUnavailable } from '../../src/persistence/errors.ts';
import {
  CreateProductPayloadSchema,
  createProductAction,
  mapCreateProductPersistenceConflict,
} from '../../src/actions/create-product.action.ts';
import {
  ReactivateProductPayloadSchema,
  reactivateProductAction,
} from '../../src/actions/reactivate-product.action.ts';
import { RetireProductPayloadSchema, retireProductAction } from '../../src/actions/retire-product.action.ts';
import { UpdateProductPayloadSchema, updateProductAction } from '../../src/actions/update-product.action.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const productRef = {
  moduleId: 'commerce.catalog',
  resourceId: '22222222-2222-4222-8222-222222222222',
  resourceType: 'commerce.catalog.product',
  tenantId,
} as const;
const variantRef = {
  moduleId: 'commerce.catalog',
  resourceId: '33333333-3333-4333-8333-333333333333',
  resourceType: 'commerce.catalog.variant',
  tenantId,
} as const;
const classification = {
  affectsOpenSelection: false,
  evidenceRefs: ['urn:evidence:correction-1'],
  kind: 'COSMETIC_CORRECTION',
  productRef,
  reason: 'Correct Product',
} as const;

describe('Catalog Product Action contracts', () => {
  it('preserves exact Variant identity conflicts through the create Action and redacted API problem', () => {
    const diagnostic = 'secret driver constraint and tenant identifier';
    const variantCollision = mapCreateProductPersistenceConflict(
      new CatalogPersistenceConflict({
        code: 'catalog_persistence_conflict',
        conflict: 'VARIANT_ID',
        reason: diagnostic,
      }),
    );
    expect(Schema.is(ProductPersistenceConflict)(variantCollision)).toBe(true);
    expect(variantCollision).toMatchObject({ conflict: 'VARIANT_ID' });
    const problem = mapCreateProductActionProblem(variantCollision);
    expect(problem).toMatchObject({ code: 'product_persistence_conflict', status: 409 });
    expect(problem).not.toHaveProperty('retryable');
    expect(JSON.stringify(problem)).not.toContain(diagnostic);
  });

  it('does not turn non-identity persistence conflicts into Product identity conflicts', () => {
    const invocationCollision = new CatalogPersistenceConflict({
      code: 'catalog_persistence_conflict',
      conflict: 'ACTION_INVOCATION_ID',
      reason: 'Invocation collision',
    });
    expect(mapCreateProductPersistenceConflict(invocationCollision)).toBe(invocationCollision);
  });

  it('reports known persistence conflicts as non-retryable conflicts on every public Action', () => {
    const mappers = [
      mapCorrectProductActionProblem,
      mapCreateProductActionProblem,
      mapReactivateProductActionProblem,
      mapRetireProductActionProblem,
      mapUpdateProductActionProblem,
    ] as const;
    for (const mapProblem of mappers) {
      for (const failure of [
        new CatalogPersistenceConflict({
          code: 'catalog_persistence_conflict',
          conflict: 'ACTION_INVOCATION_ID',
          reason: 'Known invocation collision',
        }),
        new ProductPersistenceConflict({
          code: 'product_persistence_conflict',
          conflict: 'PRODUCT_ID',
          reason: 'Known Product collision',
        }),
      ]) {
        const problem = mapProblem(failure);
        expect(problem.status).toBe(409);
        expect(problem).not.toHaveProperty('retryable');
      }
    }
  });

  it('keeps denial, authorization outage, stale intent, and indeterminate commit distinct', () => {
    const denied = mapCreateProductActionProblem(
      new ActionPermissionDenied({ code: 'action_permission_denied', reason: 'Denied' }),
    );
    const checkUnavailable = mapCreateProductActionProblem(
      new ActionPermissionCheckError({ code: 'action_permission_check_failed', reason: 'Unavailable' }),
    );
    const staleIntent = mapCreateProductActionProblem(
      new ActionRequestHashConflict({ code: 'action_request_hash_conflict', reason: 'Different payload' }),
    );
    const persistenceUnavailable = mapCreateProductActionProblem(
      new CatalogPersistenceUnavailable({
        code: 'catalog_persistence_unavailable',
        reason: 'Unavailable',
      }),
    );
    const indeterminate = mapCreateProductActionProblem(
      new ActionCommitIndeterminate({
        code: 'action_commit_indeterminate',
        invocationId: '44444444-4444-4444-8444-444444444444',
        reason: 'Commit unconfirmed',
      }),
    );

    expect(denied.status).toBe(403);
    expect(checkUnavailable.status).toBe(503);
    expect(staleIntent.status).toBe(409);
    expect(persistenceUnavailable.status).toBe(503);
    expect(indeterminate).toMatchObject({
      resolution: 'RECOVER_CREATE_PRODUCT',
      retryCommand: false,
      status: 503,
    });
    expect(JSON.stringify(denied)).not.toContain(productRef.resourceId);
  });

  it('exposes five explicitly provisioned tenant Actions with no legal-entity scope', () => {
    for (const action of [
      createProductAction,
      updateProductAction,
      retireProductAction,
      reactivateProductAction,
      correctProductAction,
    ]) {
      expect(action.descriptor.entrypoint.authorization).toEqual({
        kind: 'action_execution',
        provisioning: 'explicit',
      });
      expect(action.descriptor.entrypoint.scope).toBe('tenant');
      expect(action.descriptor.legalEntityScope).toBe('forbidden');
      expect(action.descriptor.idempotency).toBe('required');
      expect(action.descriptor.resourcePermission).toBeUndefined();
    }
  });

  it('requires a reason, stable target reference, and optimistic revision for mutations', () => {
    const create = Schema.decodeUnknownSync(CreateProductPayloadSchema);
    const update = Schema.decodeUnknownSync(UpdateProductPayloadSchema);
    const retire = Schema.decodeUnknownSync(RetireProductPayloadSchema);
    const reactivate = Schema.decodeUnknownSync(ReactivateProductPayloadSchema);
    const correct = Schema.decodeUnknownSync(CorrectProductPayloadSchema);

    expect(create({ classification: { kind: 'INDEPENDENT_PRODUCT' }, reason: 'Create Product' }).reason).toBe(
      'Create Product',
    );
    expect(
      update({ expectedRevision: 1, productRef, reason: 'Activate Product', targetLifecycle: 'ACTIVE' }).productRef,
    ).toEqual(productRef);
    expect(() =>
      Schema.decodeUnknownSync(UpdateProductPayloadSchema, { onExcessProperty: 'error' })({
        expectedRevision: 1,
        name: 'Material rename',
        productRef,
        reason: 'Bypass correction',
      }),
    ).toThrow();
    expect(
      update({
        activateVariantRef: variantRef,
        expectedRevision: 1,
        productRef,
        reason: 'Activate Variant',
        targetLifecycle: 'ACTIVE',
      }).activateVariantRef,
    ).toEqual(variantRef);
    expect(retire({ expectedRevision: 1, productRef, reason: 'Retire Product' }).expectedRevision).toBe(1);
    expect(reactivate({ expectedRevision: 2, productRef, reason: 'Reactivate Product' }).expectedRevision).toBe(2);
    expect(
      correct({ classification, expectedRevision: 1, name: 'Corrected', productRef, reason: 'Correct Product' }).name,
    ).toBe('Corrected');
    expect(() => update({ expectedRevision: 0, productRef, reason: 'Invalid' })).toThrow();
    expect(() => correct({ expectedRevision: 1, name: 'Corrected', productRef, reason: 'Correct Product' })).toThrow();
    expect(
      correct({
        classification,
        expectedRevision: 1,
        name: 'Corrected',
        productRef,
        reason: 'Correct Product',
      }).classification.evidenceRefs,
    ).toEqual(['urn:evidence:correction-1']);
  });

  it('separates Product Editor from Product lifecycle authority', () => {
    expect(catalogAuthorityBundles.PRODUCT_EDITOR).toContain(createProductAction.descriptor.actionKey);
    expect(catalogAuthorityBundles.PRODUCT_EDITOR).toContain(correctProductAction.descriptor.actionKey);
    expect(catalogAuthorityBundles.PRODUCT_EDITOR).toContain(updateProductAction.descriptor.actionKey);
    expect(catalogAuthorityBundles.CATALOG_LIFECYCLE_MANAGER).not.toContain(updateProductAction.descriptor.actionKey);
    for (const lifecycleAction of [retireProductAction, reactivateProductAction]) {
      expect(catalogAuthorityBundles.PRODUCT_EDITOR).not.toContain(lifecycleAction.descriptor.actionKey);
      expect(catalogAuthorityBundles.CATALOG_LIFECYCLE_MANAGER).toContain(lifecycleAction.descriptor.actionKey);
    }
  });

  it('publishes an exact typed #479 revalidation handoff for material open-selection impact', () => {
    const handoff = Schema.decodeUnknownSync(ProductSelectionRevalidationRequiredSchema)({
      affectedVariantProductRef: productRef,
      affectedVariantRef: variantRef,
      evidenceRefs: ['urn:evidence:correction-1'],
      kind: 'REVALIDATION_REQUIRED',
      productRef,
      reason: 'Correct Product',
      sourceRevision: 2,
    });
    expect(handoff.affectedVariantRef).toEqual(variantRef);
    expect(() =>
      Schema.decodeUnknownSync(ProductSelectionRevalidationRequiredSchema)({
        affectedVariantProductRef: productRef,
        affectedVariantRef: { ...variantRef, tenantId: '99999999-9999-4999-8999-999999999999' },
        evidenceRefs: ['urn:evidence:correction-1'],
        kind: 'REVALIDATION_REQUIRED',
        productRef,
        reason: 'Cross-tenant Variant',
        sourceRevision: 2,
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(ProductSelectionRevalidationRequiredSchema)({
        affectedVariantProductRef: { ...productRef, resourceId: '99999999-9999-4999-8999-999999999999' },
        affectedVariantRef: variantRef,
        evidenceRefs: ['urn:evidence:correction-1'],
        kind: 'REVALIDATION_REQUIRED',
        productRef,
        reason: 'Wrong Product owner',
        sourceRevision: 2,
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(ProductSelectionRevalidationRequiredSchema)({
        kind: 'REVALIDATION_REQUIRED',
        productRef,
        reason: 'Missing evidence',
        sourceRevision: 2,
      }),
    ).toThrow();
    expect(correctProductAction.descriptor.domainEvents).toHaveProperty(
      'commerce.catalog.selection-revalidation-required.v1',
    );
  });
});
