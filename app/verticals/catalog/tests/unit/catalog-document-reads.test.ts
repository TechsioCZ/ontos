import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { Effect, Option, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { CatalogDocumentOwnerRevisionSchema } from '../../shared/domain/catalog-media-assignment.ts';
import {
  catalogMediaAssignments,
  catalogMediaAssignmentSets,
  products,
  productVariants,
} from '../../src/database/schema.ts';
import { catalogDocumentReadsForScope } from '../../src/persistence/catalog-document-reads.ts';

const tenantId = '00000000-0000-4000-8000-000000000001';
const productId = '00000000-0000-4000-8000-000000000002';
const variantId = '00000000-0000-4000-8000-000000000003';
const scope = {
  ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    authContextRef: 'job:document-reads-test:run:1',
    authMethod: 'system',
    principalId: '00000000-0000-4000-8000-000000000004',
    tenantId,
  }),
  correlationId: 'document-reads-test',
};
const productRef = {
  moduleId: 'commerce.catalog',
  resourceId: productId,
  resourceType: 'commerce.catalog.product',
  tenantId,
} as const;
const variantRef = {
  moduleId: 'commerce.catalog',
  resourceId: variantId,
  resourceType: 'commerce.catalog.variant',
  tenantId,
} as const;
const set = {
  assignmentSetId: '00000000-0000-4000-8000-000000000010',
  currentRevision: 4,
  productId,
  tenantId,
  variantId: null,
};
type SetFixture = Omit<typeof set, 'variantId'> & { readonly variantId: string | null };
const document = {
  assignmentId: '00000000-0000-4000-8000-000000000020',
  assignmentSetId: set.assignmentSetId,
  currentRevision: 2,
  ownerModuleId: 'documents.center',
  ownerResourceId: '00000000-0000-4000-8000-000000000030',
  ownerResourceType: 'documents.center.resource',
  ownerTenantId: tenantId,
  position: 1,
  purpose: 'instruction manual',
  resourceKind: 'DOCUMENT',
  state: 'ACTIVE',
  tenantId,
};

const serviceWith = (
  sets: (readonly SetFixture[])[],
  assignments: (readonly (typeof document)[])[],
  subject = [{ productId }],
) => {
  const queried: unknown[] = [];
  const transaction = {
    select: () => ({
      from: (
        table:
          | typeof products
          | typeof productVariants
          | typeof catalogMediaAssignmentSets
          | typeof catalogMediaAssignments,
      ) => {
        queried.push(table);
        return {
          where: () => {
            if (table === products || table === productVariants) {
              return Effect.succeed(subject);
            }
            if (table === catalogMediaAssignmentSets) {
              return Effect.succeed(sets.shift() ?? []);
            }
            if (table === catalogMediaAssignments) {
              return Effect.succeed(assignments.shift() ?? []);
            }
            return Effect.succeed([]);
          },
        };
      },
    }),
  };
  // @ts-expect-error Mock exposes only the exercised Drizzle chains.
  return { queried, service: catalogDocumentReadsForScope(transaction, scope) };
};

describe('Catalog private document reads', () => {
  it.effect('projects the exact Product assignment and revision without claiming Current or access', () =>
    Effect.gen(function* current() {
      const result = Option.getOrThrow(yield* serviceWith([[set]], [[document]]).service.current(productRef));
      expect(result.setRevision).toBe(4);
      expect(result.assignments).toHaveLength(1);
      expect(result.assignments[0]?.kind).toBe('OWNER_CHECK_REQUIRED');
      expect(result.assignments[0]?.assignment.resourceRef.resourceId).toBe(document.ownerResourceId);
      expect(result.assignments[0]?.assignment.assignmentRevision).toBe(2);
      expect(result.assignments[0]?.assignment.target).toEqual(productRef);
      expect(result.assignments[0]).not.toHaveProperty('version');
    }),
  );

  it.effect('keeps Variant assignments exact and never inherits a Product document', () =>
    Effect.gen(function* variant() {
      const result = Option.getOrThrow(yield* serviceWith([[]], []).service.current(variantRef));
      expect(result).toEqual({ assignments: [], setRevision: 0 });
      const own = Option.getOrThrow(
        yield* serviceWith([[{ ...set, variantId }]], [[document]]).service.current(variantRef),
      );
      expect(own.assignments[0]?.assignment.target).toEqual(variantRef);
    }),
  );

  it.effect('ignores media and removed documents without substituting another Resource', () =>
    Effect.gen(function* removed() {
      const result = Option.getOrThrow(
        yield* serviceWith(
          [[set]],
          [
            [
              { ...document, state: 'REMOVED' },
              { ...document, resourceKind: 'MEDIA' },
            ],
          ],
        ).service.current(productRef),
      );
      expect(result.assignments).toEqual([]);
    }),
  );

  it.effect('fails closed on foreign Tenant targets and corrupt owner references', () =>
    Effect.gen(function* invalid() {
      const { queried, service } = serviceWith([], []);
      const foreign = yield* service
        .current({ ...productRef, tenantId: variantId })
        .pipe(Effect.catchTag('CatalogPersistenceUnavailable', () => Effect.succeed('unavailable' as const)));
      expect(foreign).toBe('unavailable');
      expect(queried).toEqual([]);
      const corrupt = yield* serviceWith([[set]], [[{ ...document, ownerTenantId: variantId }]])
        .service.current(productRef)
        .pipe(Effect.catchTag('CatalogPersistenceUnavailable', () => Effect.succeed('unavailable' as const)));
      expect(corrupt).toBe('unavailable');
    }),
  );

  it.effect('resolves a live reference from owner evidence without pinning or approving a version', () =>
    Effect.gen(function* liveReference() {
      const resourceRef = {
        moduleId: document.ownerModuleId,
        resourceId: document.ownerResourceId,
        resourceType: document.ownerResourceType,
        tenantId,
      } as const;
      const current = Schema.decodeUnknownSync(CatalogDocumentOwnerRevisionSchema)({
        resourceRef,
        revision: 2,
        revisionId: '00000000-0000-4000-8000-000000000040',
      });
      const result = Option.getOrThrow(
        yield* serviceWith([[set]], [[document]]).service.current(productRef, [
          { current, kind: 'AVAILABLE', resourceRef },
        ]),
      );
      expect(result.assignments[0]).toMatchObject({ current: { revision: 2 }, kind: 'AVAILABLE' });
      expect(result.assignments[0]?.assignment.resourceRef).toEqual(resourceRef);
    }),
  );

  it.effect('never substitutes evidence for a different Resource and preserves distinct owner outcomes', () =>
    Effect.gen(function* outcomes() {
      const result = Option.getOrThrow(yield* serviceWith([[set]], [[document]]).service.current(productRef));
      expect(result.assignments[0]?.kind).toBe('OWNER_CHECK_REQUIRED');
      const foreignResource = {
        moduleId: document.ownerModuleId,
        resourceId: variantId,
        resourceType: document.ownerResourceType,
        tenantId,
      } as const;
      const mismatched = Option.getOrThrow(
        yield* serviceWith([[set]], [[document]]).service.current(productRef, [
          { kind: 'ABSENT', resourceRef: foreignResource },
        ]),
      );
      expect(mismatched.assignments[0]?.kind).toBe('OWNER_CHECK_REQUIRED');
      for (const kind of ['ABSENT', 'FORBIDDEN', 'UNAVAILABLE', 'CURRENT_UNVERIFIED'] as const) {
        const resourceRef = {
          moduleId: document.ownerModuleId,
          resourceId: document.ownerResourceId,
          resourceType: document.ownerResourceType,
          tenantId,
        } as const;
        const observed = Option.getOrThrow(
          yield* serviceWith([[set]], [[document]]).service.current(productRef, [{ kind, resourceRef }]),
        );
        expect(observed.assignments[0]?.kind).toBe(kind);
      }
    }),
  );
});
