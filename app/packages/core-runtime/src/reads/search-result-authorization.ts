import { Effect, Schema } from 'effect';

import type { OperationalScope } from '../operations/context.ts';
import type { ContextAccessResult, ResourceAccessTarget } from '../permissions/context-access.ts';
import { ReadHandlerExecutionError, ReadPermissionUnavailable } from './errors.ts';

const searchCollectionMarker: unique symbol = Symbol('@app/core-runtime/reads/search-collection');

interface SearchCollectionSelection {
  readonly retain: (allowedKeys: ReadonlySet<string>) => Readonly<{ result: unknown; resultCount: number }>;
  readonly targets: readonly ResourceAccessTarget[];
}

/** Explicit owner adapter, not a heuristic over arbitrary Read result shapes. */
export interface ReadSearchCollectionResultAuthorization {
  readonly kind: 'search-collection';
  /** Keeps the existing owner-ledger declaration's public discriminated union compatible. */
  readonly requiredModuleAccess?: never;
  readonly [searchCollectionMarker]: true;
  readonly select: <Candidate>(
    candidate: Candidate,
    scope: OperationalScope,
  ) => Effect.Effect<SearchCollectionSelection, ReadHandlerExecutionError>;
}

class SearchCollectionDeclaration implements ReadSearchCollectionResultAuthorization {
  readonly kind = 'search-collection';
  readonly [searchCollectionMarker] = true;
  readonly select: ReadSearchCollectionResultAuthorization['select'];

  constructor(select: ReadSearchCollectionResultAuthorization['select']) {
    this.select = select;
    Object.freeze(this);
  }
}

const resourceKey = (resource: ResourceAccessTarget): string =>
  `${resource.moduleId}:${resource.resourceType}:${resource.resourceId}`;

const invalidAdapter = (cause?: unknown) => {
  const failure = new ReadHandlerExecutionError({
    code: 'read_handler_execution_failed',
    reason: 'The search collection authorization adapter is invalid',
  });
  return cause === undefined
    ? failure
    : Object.defineProperty(failure, 'cause', {
        configurable: false,
        enumerable: false,
        value: cause,
        writable: false,
      });
};

interface SearchCollectionAdapter<Result, Item> {
  readonly items: (result: Result) => readonly Item[];
  readonly resource: (item: Item, scope: OperationalScope) => ResourceAccessTarget;
  readonly withItems: (result: Result, items: readonly Item[]) => Result;
}

const snapshotResource = (target: ResourceAccessTarget): ResourceAccessTarget =>
  Object.freeze({ moduleId: target.moduleId, resourceId: target.resourceId, resourceType: target.resourceType });

const selectCollection = <Result, Item>(
  adapter: SearchCollectionAdapter<Result, Item>,
  result: Result,
  candidates: readonly Item[],
  scope: OperationalScope,
): SearchCollectionSelection => {
  const items = Object.freeze([...candidates]);
  const targets = Object.freeze(items.map((item) => snapshotResource(adapter.resource(item, scope))));
  return {
    retain: (allowedKeys) => {
      const retained = items.filter((_item, index) => {
        const target = targets[index];
        return target !== undefined && allowedKeys.has(resourceKey(target));
      });
      const rebuilt = adapter.withItems(result, Object.freeze(retained));
      const actual = adapter.items(rebuilt);
      const retainedTargets = targets.filter((target) => allowedKeys.has(resourceKey(target)));
      let unchanged = Array.isArray(actual) && actual.length === retained.length;
      if (unchanged) {
        for (const [index, item] of actual.entries()) {
          const expected = retainedTargets[index];
          const current = adapter.resource(item, scope);
          if (
            item !== retained[index] ||
            expected === undefined ||
            current.moduleId !== expected.moduleId ||
            current.resourceType !== expected.resourceType ||
            current.resourceId !== expected.resourceId
          ) {
            unchanged = false;
            break;
          }
        }
      }
      return {
        result: rebuilt,
        // Reconstruction must not restore denied rows or change authorized targets/order.
        resultCount: unchanged ? retained.length : -1,
      };
    },
    targets,
  };
};

const selectCollectionEffect = <Result, Item>(
  adapter: SearchCollectionAdapter<Result, Item>,
  result: Result,
  scope: OperationalScope,
) =>
  Effect.try({ catch: invalidAdapter, try: () => adapter.items(result) }).pipe(
    Effect.filterOrFail(Array.isArray, invalidAdapter),
    Effect.flatMap((candidates) =>
      Effect.try({ catch: invalidAdapter, try: () => selectCollection(adapter, result, candidates, scope) }),
    ),
  );

/**
 * The owner must rebuild ALL response metadata from retained items: no candidate totals, hidden match
 * evidence, or candidate cursors. This adapter does not paginate, overfetch, or claim completeness.
 * Current owner-state/evidence revalidation still belongs in the owner's Read finish step.
 * The runtime validates the result against `resultSchema` before `select`, so the adapter does not decode it again.
 */
export const defineReadSearchCollectionAuthorization = <ResultSchema extends Schema.ConstraintDecoder<unknown>, Item>(
  adapter: SearchCollectionAdapter<ResultSchema['Type'], Item> & {
    readonly resultSchema: ResultSchema;
  },
): ReadSearchCollectionResultAuthorization => {
  const { items, resource, withItems } = adapter;
  const snapshot = Object.freeze({ items, resource, withItems });
  // SAFETY: authorizeReadSearchCollection is reached only with the value ReadRuntime decoded against resultSchema just before select runs.
  return new SearchCollectionDeclaration((validated, scope) =>
    selectCollectionEffect(snapshot, validated as ResultSchema['Type'], scope),
  );
};

const adapterSchema = Schema.instanceOf(SearchCollectionDeclaration).check(
  Schema.makeFilter((value) => Object.isFrozen(value)),
);
export const isReadSearchCollectionAuthorization = Schema.is(adapterSchema);

const targetPartSchema = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300));
const TargetModuleIdSchema = targetPartSchema.pipe(Schema.brand('SearchAuthorizationModuleId'));
const TargetResourceIdSchema = targetPartSchema.pipe(Schema.brand('SearchAuthorizationResourceId'));
const targetsSchema = Schema.Array(
  Schema.Struct({ moduleId: TargetModuleIdSchema, resourceId: TargetResourceIdSchema, resourceType: targetPartSchema }),
);
const decisionsSchema = Schema.Array(
  Schema.Struct({ decision: Schema.Literals(['allowed', 'denied', 'unavailable']), key: Schema.String }),
);
const unavailable = () =>
  new ReadPermissionUnavailable({
    code: 'read_permission_unavailable',
    reason: 'Search result authorization is temporarily unavailable',
  });

/** Core-only execution seam. Definite denied items disappear; uncertainty never becomes an empty success. */
export const authorizeReadSearchCollection = Effect.fn('ReadRuntime.authorizeSearchCollection')(function* authorize<
  Result,
>(
  adapter: ReadSearchCollectionResultAuthorization,
  result: Result,
  scope: OperationalScope,
  check: (
    targets: readonly ResourceAccessTarget[],
  ) => Effect.Effect<readonly ContextAccessResult[], ReadPermissionUnavailable>,
) {
  const selection = yield* adapter.select(result, scope);
  if (!Schema.is(targetsSchema)(selection.targets)) {
    return yield* invalidAdapter();
  }
  const uniqueKeys = new Set(selection.targets.map(resourceKey));
  if (uniqueKeys.size !== selection.targets.length) {
    return yield* invalidAdapter();
  }
  const allowedKeys = new Set<string>();
  if (selection.targets.length > 0) {
    const decisions = yield* check(selection.targets);
    if (
      !Schema.is(decisionsSchema)(decisions) ||
      decisions.length !== uniqueKeys.size ||
      decisions.some((decision) => Reflect.ownKeys(decision).length !== 2)
    ) {
      return yield* unavailable();
    }
    const seen = new Set<string>();
    for (const { decision, key } of decisions) {
      if (!uniqueKeys.has(key) || seen.has(key) || decision === 'unavailable') {
        return yield* unavailable();
      }
      seen.add(key);
      if (decision === 'allowed') {
        allowedKeys.add(key);
      }
    }
  }
  const filtered = yield* Effect.try({ catch: invalidAdapter, try: () => selection.retain(allowedKeys) });
  if (filtered.resultCount !== allowedKeys.size) {
    return yield* invalidAdapter();
  }
  return filtered;
});
