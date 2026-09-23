import type { ActionHandlerContext, DomainEventContractMap } from '@app/core-runtime';
import { ActionTransactionError, TrustedPrincipalContextSchema } from '@app/core-runtime';
import { bindActionTestServices, makeActionTestHarness } from '@app/core-runtime/testing/actions';
import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  AddProductCategoryAssignmentPayloadSchema,
  addProductCategoryAssignmentAction,
  handleAddProductCategoryAssignment,
} from '../../src/actions/add-product-category-assignment.action.ts';
import {
  CreateProductCategoryPayloadSchema,
  createProductCategoryAction,
  handleCreateProductCategory,
} from '../../src/actions/create-product-category.action.ts';
import {
  MoveProductCategoryPayloadSchema,
  handleMoveProductCategory,
  moveProductCategoryAction,
} from '../../src/actions/move-product-category.action.ts';
import {
  handleRemoveProductCategoryAssignment,
  removeProductCategoryAssignmentAction,
} from '../../src/actions/remove-product-category-assignment.action.ts';
import {
  handleRenameProductCategory,
  renameProductCategoryAction,
} from '../../src/actions/rename-product-category.action.ts';
import {
  handleRetireProductCategory,
  retireProductCategoryAction,
} from '../../src/actions/retire-product-category.action.ts';
import type {
  CategoryPersistence,
  CreateCategoryInput,
  RenameCategoryInput,
} from '../../src/persistence/category-persistence.ts';
import { CategoryRevisionConflict } from '../../shared/actions/create-product-category.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const otherTenantId = '99999999-9999-4999-8999-999999999999';
const categoryRef = {
  moduleId: 'commerce.catalog',
  resourceId: '22222222-2222-4222-8222-222222222222',
  resourceType: 'commerce.catalog.product-category',
  tenantId,
} as const;
const productRef = {
  moduleId: 'commerce.catalog',
  resourceId: '33333333-3333-4333-8333-333333333333',
  resourceType: 'commerce.catalog.product',
  tenantId,
} as const;
const category = { categoryRef, lifecycle: 'ACTIVE', name: 'Wall shelves', revision: 1 } as const;
const scope = {
  ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    authContextRef: 'job:category-actions:run:1',
    authMethod: 'system',
    principalId: '55555555-5555-4555-8555-555555555555',
    tenantId,
  }),
  correlationId: 'category-actions-test',
};

const unexpected = () => Effect.die('Unexpected persistence call');
const defaultServices: CategoryPersistence = {
  addAssignment: unexpected,
  createCategory: unexpected,
  moveCategory: unexpected,
  removeAssignment: unexpected,
  renameCategory: unexpected,
  retireCategory: unexpected,
};

const context = <Events extends DomainEventContractMap>(
  overrides: Partial<CategoryPersistence>,
  domainEvents: Events,
) => {
  const declaredEventTypes = new Set(Object.keys(domainEvents));
  const events: string[] = [];
  const reads: string[] = [];
  const value: ActionHandlerContext<Events, CategoryPersistence> = {
    actionInvocationId: '66666666-6666-4666-8666-666666666666',
    addDomainEvent: (event) =>
      Effect.sync(() => {
        if (!declaredEventTypes.has(event.eventType)) {
          throw new Error('Undeclared test event');
        }
        events.push(event.eventType);
        return Object.create(null);
      }),
    addOutboxMessage: () => Effect.void,
    recordAuditEvidence: () => Effect.void,
    recordDataAccess: (access) =>
      Effect.sync(() => {
        reads.push(access.targetResourceId ?? 'unspecified');
      }),
    scope,
    services: { ...defaultServices, ...overrides },
  };
  return { events, reads, value };
};

const createContext = (overrides: Partial<CategoryPersistence>) =>
  context(overrides, createProductCategoryAction.descriptor.domainEvents);
const renameContext = (overrides: Partial<CategoryPersistence>) =>
  context(overrides, renameProductCategoryAction.descriptor.domainEvents);
const moveContext = (overrides: Partial<CategoryPersistence>) =>
  context(overrides, moveProductCategoryAction.descriptor.domainEvents);
const retireContext = (overrides: Partial<CategoryPersistence>) =>
  context(overrides, retireProductCategoryAction.descriptor.domainEvents);
const addContext = (overrides: Partial<CategoryPersistence>) =>
  context(overrides, addProductCategoryAssignmentAction.descriptor.domainEvents);
const removeContext = (overrides: Partial<CategoryPersistence>) =>
  context(overrides, removeProductCategoryAssignmentAction.descriptor.domainEvents);

describe('Catalog Product Category Actions', () => {
  it.effect('captures the decoded category result before the Action commit and does not rerun it on replay', () =>
    Effect.gen(function* categoryCaptureTest() {
      const captured: { actionInvocationId: string; result: unknown }[] = [];
      const harness = yield* makeActionTestHarness({
        actionPermission: 'allowed',
        services: [
          bindActionTestServices(createProductCategoryAction, {
            ...defaultServices,
            captureResult: (actionInvocationId, result) =>
              Effect.sync(() => {
                captured.push({ actionInvocationId, result });
              }),
            createCategory: () => Effect.succeed({ _tag: 'created', category, changed: true, hierarchyRevision: 1 }),
          }),
        ],
      });
      const request = {
        payload: { name: 'Wall shelves', reason: 'New classification' },
        principal: {
          authBindingId: '77777777-7777-4777-8777-777777777777',
          authContextRef: 'better-auth-session:category-capture',
          authMethod: 'session' as const,
          principalId: scope.principalId,
          tenantId,
        },
        registration: createProductCategoryAction,
        transport: { correlationId: 'category-capture', idempotencyKey: 'category-capture-once' },
      };
      const result = yield* harness.runtime.runAction(request);
      expect(captured).toEqual([{ actionInvocationId: expect.any(String), result }]);
      expect(harness.snapshot().committed).toHaveLength(1);
      yield* harness.runtime.runAction(request).pipe(Effect.flip);
      expect(captured).toHaveLength(1);
    }),
  );

  it.effect('does not commit a category Action when result capture fails', () =>
    Effect.gen(function* categoryCaptureFailureTest() {
      const harness = yield* makeActionTestHarness({
        actionPermission: 'allowed',
        services: [
          bindActionTestServices(createProductCategoryAction, {
            ...defaultServices,
            captureResult: () =>
              Effect.fail(
                new ActionTransactionError({
                  code: 'action_transaction_failed',
                  reason: 'Catalog result capture failed',
                }),
              ),
            createCategory: () => Effect.succeed({ _tag: 'created', category, changed: true, hierarchyRevision: 1 }),
          }),
        ],
      });
      const failure = yield* harness.runtime
        .runAction({
          payload: { name: 'Wall shelves', reason: 'New classification' },
          principal: {
            authBindingId: '77777777-7777-4777-8777-777777777777',
            authContextRef: 'better-auth-session:category-capture',
            authMethod: 'session',
            principalId: scope.principalId,
            tenantId,
          },
          registration: createProductCategoryAction,
          transport: { correlationId: 'category-capture', idempotencyKey: 'category-capture-failure' },
        })
        .pipe(Effect.flip);
      expect(failure).toMatchObject({ code: 'action_transaction_failed' });
      expect(harness.snapshot().committed).toHaveLength(0);
    }),
  );

  it('keeps six exact tenant Actions idempotent and legal-entity independent', () => {
    for (const action of [
      createProductCategoryAction,
      renameProductCategoryAction,
      moveProductCategoryAction,
      retireProductCategoryAction,
      addProductCategoryAssignmentAction,
      removeProductCategoryAssignmentAction,
    ]) {
      expect(action.descriptor.idempotency).toBe('required');
      expect(action.descriptor.legalEntityScope).toBe('forbidden');
      expect(action.descriptor.entrypoint.authorization.kind).toBe('action_execution');
    }
  });

  it('validates explicit payloads and rejects empty names or reasons', () => {
    expect(() =>
      Schema.decodeUnknownSync(CreateProductCategoryPayloadSchema)({ name: '', reason: 'Create' }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(MoveProductCategoryPayloadSchema)({ categoryRef, expectedRevision: 1, reason: ' ' }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(AddProductCategoryAssignmentPayloadSchema)({ categoryRef, reason: 'Assign' }),
    ).toThrow();
  });

  it.effect('creates in trusted Tenant and emits one fact', () =>
    Effect.gen(function* categoryActionTest() {
      let recorded: CreateCategoryInput | undefined;
      const run = createContext({
        createCategory: (input) =>
          Effect.sync(() => {
            recorded = input;
            return { _tag: 'created', category, changed: true, hierarchyRevision: 1 };
          }),
      });
      const result = yield* handleCreateProductCategory(
        { name: 'Wall shelves', reason: 'New classification' },
        run.value,
      );
      expect(result.category.categoryRef).toEqual(categoryRef);
      expect(recorded).toMatchObject({ name: 'Wall shelves', principalId: scope.principalId, tenantId });
      expect(run.events).toHaveLength(1);
      expect(run.reads).toHaveLength(1);
    }),
  );

  it.effect('rejects a cross-tenant move before persistence', () =>
    Effect.gen(function* categoryActionTest() {
      let called = false;
      const run = moveContext({
        moveCategory: () =>
          Effect.sync(() => {
            called = true;
            return { _tag: 'moved', category, changed: true, hierarchyRevision: 2 };
          }),
      });
      const error = yield* handleMoveProductCategory(
        { categoryRef: { ...categoryRef, tenantId: otherTenantId }, expectedRevision: 1, reason: 'Move' },
        run.value,
      ).pipe(Effect.flip);
      expect(error.code).toBe('category_not_found');
      expect(called).toBe(false);
    }),
  );

  it.effect('treats a duplicate assignment as unchanged with no event', () =>
    Effect.gen(function* categoryActionTest() {
      const run = addContext({
        addAssignment: () => Effect.succeed({ _tag: 'unchanged', assignmentRevision: 1, categoryRef, productRef }),
      });
      const result = yield* handleAddProductCategoryAssignment(
        { categoryRef, productRef, reason: 'Classify' },
        run.value,
      );
      expect(result.changed).toBe(false);
      expect(run.events).toHaveLength(0);
      expect(run.reads).toHaveLength(2);
    }),
  );

  it.effect('renames in place and emits only on change', () =>
    Effect.gen(function* categoryActionTest() {
      let recorded: RenameCategoryInput | undefined;
      const renamed = { ...category, name: 'Shelves for walls', revision: 2 };
      const run = renameContext({
        renameCategory: (input) =>
          Effect.sync(() => {
            recorded = input;
            return { _tag: 'renamed', category: renamed, changed: true, hierarchyRevision: 2 };
          }),
      });
      const result = yield* handleRenameProductCategory(
        { categoryRef, expectedRevision: 1, name: 'Shelves for walls', reason: 'Same meaning' },
        run.value,
      );
      expect(result.category.categoryRef).toEqual(categoryRef);
      expect(recorded).toMatchObject({ categoryId: categoryRef.resourceId, expectedRevision: 1, tenantId });
      expect(run.events).toHaveLength(1);
      const noChange = renameContext({
        renameCategory: () =>
          Effect.succeed({ _tag: 'renamed', category: renamed, changed: false, hierarchyRevision: 2 }),
      });
      expect(
        (yield* handleRenameProductCategory(
          { categoryRef, expectedRevision: 2, name: 'Shelves for walls', reason: 'Same meaning' },
          noChange.value,
        )).changed,
      ).toBe(false);
      expect(noChange.events).toHaveLength(0);
    }),
  );

  it.effect('preserves expected and actual revisions in a stale rename error', () =>
    Effect.gen(function* categoryActionTest() {
      const run = renameContext({
        renameCategory: () => Effect.succeed({ _tag: 'revision_conflict', actualRevision: 3, reason: 'stale' }),
      });
      const error = yield* handleRenameProductCategory(
        { categoryRef, expectedRevision: 1, name: 'Shelves', reason: 'Rename' },
        run.value,
      ).pipe(Effect.flip);
      expect(Schema.is(CategoryRevisionConflict)(error)).toBe(true);
      expect(error).toMatchObject({ actualRevision: 3, categoryRef, expectedRevision: 1 });
      expect(run.events).toHaveLength(0);
    }),
  );

  it.effect('rejects a cycle and dependency-blocked retirement without success events', () =>
    Effect.gen(function* categoryActionTest() {
      const moved = moveContext({
        moveCategory: () => Effect.succeed({ _tag: 'hierarchy_conflict', reason: 'Cycle' }),
      });
      const moveError = yield* handleMoveProductCategory(
        {
          categoryRef,
          expectedRevision: 1,
          parentRef: { ...categoryRef, resourceId: '44444444-4444-4444-8444-444444444444' },
          reason: 'Move',
        },
        moved.value,
      ).pipe(Effect.flip);
      expect(moveError.code).toBe('category_conflict');
      expect(moved.events).toHaveLength(0);
      for (const reason of ['DIRECT_CHILDREN_REMAIN', 'DIRECT_ASSIGNMENTS_REMAIN']) {
        const blocked = retireContext({ retireCategory: () => Effect.succeed({ _tag: 'reference_conflict', reason }) });
        const error = yield* handleRetireProductCategory(
          { categoryRef, expectedRevision: 1, reason: 'Retire' },
          blocked.value,
        ).pipe(Effect.flip);
        expect(error.code).toBe('category_reference_conflict');
        expect(blocked.events).toHaveLength(0);
      }
    }),
  );

  it.effect('retires only after resolution, retaining category identity', () =>
    Effect.gen(function* categoryActionTest() {
      const run = retireContext({
        retireCategory: () =>
          Effect.succeed({
            _tag: 'retired',
            category: { ...category, lifecycle: 'RETIRED', revision: 2 },
            changed: true,
            hierarchyRevision: 2,
          }),
      });
      const result = yield* handleRetireProductCategory(
        { categoryRef, expectedRevision: 1, reason: 'Retire' },
        run.value,
      );
      expect(result.category.categoryRef).toEqual(categoryRef);
      expect(result.category.lifecycle).toBe('RETIRED');
      expect(run.events).toHaveLength(1);
    }),
  );

  it.effect('removes the last assignment without replacement and emits only on change', () =>
    Effect.gen(function* categoryActionTest() {
      const run = removeContext({
        removeAssignment: () => Effect.succeed({ _tag: 'removed', assignmentRevision: 2, categoryRef, productRef }),
      });
      const result = yield* handleRemoveProductCategoryAssignment(
        { categoryRef, productRef, reason: 'Unclassify' },
        run.value,
      );
      expect(result.changed).toBe(true);
      expect(result).not.toHaveProperty('replacementCategoryRef');
      expect(run.events).toHaveLength(1);
      const repeated = removeContext({
        removeAssignment: () => Effect.succeed({ _tag: 'unchanged', assignmentRevision: 2, categoryRef, productRef }),
      });
      expect(
        (yield* handleRemoveProductCategoryAssignment(
          { categoryRef, productRef, reason: 'Unclassify' },
          repeated.value,
        )).changed,
      ).toBe(false);
      expect(repeated.events).toHaveLength(0);
    }),
  );
});
