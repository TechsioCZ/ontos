import type { ActionHandlerContext, DomainEventContractMap } from '@app/core-runtime';
import { Effect, Match, Schema } from 'effect';

import type { ProductCategoryRef } from '../../shared/resources/product-category.ts';
import { CategoryRevisionConflict, CategoryReasonSchema } from '../../shared/actions/create-product-category.ts';
import type { CreateProductCategoryResultSchema as CategoryMutationResultSchema } from '../../shared/actions/create-product-category.ts';
import type { AddProductCategoryAssignmentResultSchema as CategoryAssignmentResultSchema } from '../../shared/actions/add-product-category-assignment.ts';
import type {
  CategoryAssignmentOutcome,
  CategoryMutationOutcome,
  CategoryPersistence,
} from '../persistence/category-persistence.ts';
import { CategoryPersistenceUnavailable } from '../persistence/category-persistence.ts';

export const CategoryAuditEvidenceSchema = Schema.Struct({ reason: CategoryReasonSchema });

export class CategoryActionRejected extends Schema.TaggedError<CategoryActionRejected>()('CategoryActionRejected', {
  code: Schema.Literals([
    'category_not_found',
    'category_conflict',
    'category_revision_conflict',
    'category_reference_conflict',
  ]),
  reason: Schema.String,
}) {}

export { CategoryRevisionConflict } from '../../shared/actions/create-product-category.ts';

export const CategoryActionErrorSchema = Schema.Union([
  CategoryActionRejected,
  CategoryRevisionConflict,
  CategoryPersistenceUnavailable,
]);

/** Build a JSON value without leaking an absent parent as `undefined`. */
export const categoryEventPayload = (
  result: typeof CategoryMutationResultSchema.Type | typeof CategoryAssignmentResultSchema.Type,
): Schema.Schema.Type<typeof Schema.Json> => {
  if ('category' in result) {
    const { category } = result;
    const categoryJson = {
      categoryRef: { ...category.categoryRef },
      lifecycle: category.lifecycle,
      name: category.name,
      revision: category.revision,
    };
    const categoryWithParent =
      category.parentRef === undefined ? categoryJson : { ...categoryJson, parentRef: { ...category.parentRef } };
    return {
      category: categoryWithParent,
      changed: result.changed,
      hierarchyRevision: result.hierarchyRevision,
    };
  }
  return {
    assignmentRevision: result.assignmentRevision,
    categoryRef: { ...result.categoryRef },
    changed: result.changed,
    productRef: { ...result.productRef },
  };
};

const notFound = () =>
  new CategoryActionRejected({
    code: 'category_not_found',
    reason: 'The category was not found in the trusted tenant',
  });
const conflict = () =>
  new CategoryActionRejected({
    code: 'category_conflict',
    reason: 'The category operation conflicts with current Catalog state',
  });
const referenceConflict = () =>
  new CategoryActionRejected({
    code: 'category_reference_conflict',
    reason: 'The category reference conflicts with current Catalog state',
  });

export const mutationFailure = (
  outcome: Exclude<CategoryMutationOutcome, { readonly category: unknown }>,
  basis?: Readonly<{ categoryRef: ProductCategoryRef; expectedRevision: number }>,
): CategoryActionRejected | CategoryRevisionConflict =>
  Match.value(outcome).pipe(
    Match.tag('not_found', notFound),
    Match.tag('lifecycle_conflict', conflict),
    Match.tag('hierarchy_conflict', conflict),
    Match.tag('reference_conflict', referenceConflict),
    Match.tag('revision_conflict', ({ actualRevision }) =>
      basis === undefined
        ? conflict()
        : new CategoryRevisionConflict({
            actualRevision,
            categoryRef: basis.categoryRef,
            code: 'category_revision_conflict',
            expectedRevision: basis.expectedRevision,
            reason: 'The category changed before this Action committed',
          }),
    ),
    Match.exhaustive,
  );

export const assignmentFailure = (
  outcome: Exclude<CategoryAssignmentOutcome, { readonly categoryRef: unknown }>,
): CategoryActionRejected =>
  Match.value(outcome).pipe(
    Match.tag('not_found', notFound),
    Match.tag('lifecycle_conflict', conflict),
    Match.tag('reference_conflict', referenceConflict),
    Match.exhaustive,
  );

export const crossTenantFailure = (): CategoryActionRejected =>
  new CategoryActionRejected({
    code: 'category_not_found',
    reason: 'The reference does not belong to the trusted tenant',
  });

export type CategoryContext<Events extends DomainEventContractMap> = ActionHandlerContext<Events, CategoryPersistence>;

const MODULE_KEY = 'commerce.catalog' as const;
const CATEGORY_RESOURCE_TYPE = 'commerce.catalog.product-category' as const;

export const recordCategoryAccess = Effect.fn('CategoryAction.recordAccess')(function* recordCategoryAccess<
  Events extends DomainEventContractMap,
>(context: CategoryContext<Events>, resourceId: string, resourceType: string = CATEGORY_RESOURCE_TYPE) {
  yield* context.recordDataAccess({
    accessKind: 'read',
    queryHash: `catalog-category:${resourceId}`,
    resultCount: 1,
    servingModuleKey: MODULE_KEY,
    targetModuleKey: MODULE_KEY,
    targetResourceId: resourceId,
    targetResourceType: resourceType,
  });
});

export const recordCategoryEvent = Effect.fn('CategoryAction.recordEvent')(function* recordCategoryEvent<
  Events extends DomainEventContractMap,
>(
  context: CategoryContext<Events>,
  eventType: keyof Events & string,
  resourceId: string,
  payloadJson: Schema.Schema.Type<typeof Schema.Json>,
) {
  yield* context.addDomainEvent({
    eventType,
    payloadJson,
    producerModuleKey: MODULE_KEY,
    subjectModuleKey: MODULE_KEY,
    subjectResourceId: resourceId,
    subjectResourceType: CATEGORY_RESOURCE_TYPE,
  });
});

export { categoryPersistenceForScope as categoryPersistenceServiceFactory } from '../persistence/category-persistence.ts';
