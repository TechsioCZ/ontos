import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { Array as EffectArray, Order, Result, Schema } from 'effect';

export const PROTECTED_ENTRYPOINT_INVENTORY_SCHEMA_VERSION = 1 as const;

const PermissionSchema = Schema.String.check(
  Schema.isPattern(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u),
);

const InventoryAuthorizationSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('public') }),
  Schema.Struct({ kind: Schema.Literal('authenticated_principal') }),
  Schema.Struct({
    kind: Schema.Literal('context_permission'),
    permission: PermissionSchema,
  }),
  Schema.Struct({
    kind: Schema.Literal('action_execution'),
    provisioning: Schema.Literals(['explicit', 'tenant_membership_default']),
  }),
  Schema.Struct({ kind: Schema.Literal('owner_local_background') }),
  Schema.Struct({
    credential: Schema.Literals(['api_key', 'session']),
    kind: Schema.Literal('capability_issuance'),
  }),
]);

export type InventoryAuthorization = typeof InventoryAuthorizationSchema.Type;

const ProtectedEntrypointSurfaceSchema = Schema.Literals([
  'action',
  'capability_issuance',
  'route',
  'worker',
]);

type ProtectedEntrypointSurface = typeof ProtectedEntrypointSurfaceSchema.Type;

const StableIdentifierSchema = Schema.String.check(
  Schema.isPattern(/^[a-z][a-z0-9]*(?:[./_-][a-z0-9]+)*$/u),
);

const EntrypointKeySchema = StableIdentifierSchema.pipe(Schema.brand('EntrypointKey'));

const SourceRevisionSchema = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9._-]{1,100}$/u));

const ProtectedEntrypointInventoryEntrySchema = Schema.Struct({
  authorization: InventoryAuthorizationSchema,
  deployment: StableIdentifierSchema,
  entrypointKey: EntrypointKeySchema,
  owner: StableIdentifierSchema,
  surface: ProtectedEntrypointSurfaceSchema,
});

const ProtectedEntrypointInventorySchema = Schema.Struct({
  entries: Schema.Array(ProtectedEntrypointInventoryEntrySchema),
  inventoryHash: Schema.String,
  schemaVersion: Schema.Literal(PROTECTED_ENTRYPOINT_INVENTORY_SCHEMA_VERSION),
  sourceRevision: SourceRevisionSchema,
});

export type ProtectedEntrypointInventoryEntry =
  typeof ProtectedEntrypointInventoryEntrySchema.Encoded;

export type ProtectedEntrypointInventory = typeof ProtectedEntrypointInventorySchema.Encoded;

const encodeJsonResult = Schema.encodeResult(Schema.fromJsonString(Schema.Unknown));

const encodePrettyJsonResult = Schema.encodeResult(
  Schema.fromJsonString(Schema.Unknown, { space: 2 }),
);

class ProtectedEntrypointInventoryError extends Schema.TaggedError<ProtectedEntrypointInventoryError>()(
  'ProtectedEntrypointInventoryError',
  { message: Schema.String },
) {}

const invalidInventory = (message: string): ProtectedEntrypointInventoryError =>
  new ProtectedEntrypointInventoryError({ message });

const toTypeError = (error: ProtectedEntrypointInventoryError): TypeError =>
  new TypeError(error.message);

// Compatibility boundary for the established synchronous, TypeError-throwing public API.
const getOrThrowTypeError = <A,>(result: Result.Result<A, ProtectedEntrypointInventoryError>): A =>
  Result.getOrThrowWith(result, toTypeError);

const encodingFailure = (): ProtectedEntrypointInventoryError =>
  invalidInventory('protected entrypoint inventory encoding failed');

const stableValue = (
  value: string,
  field: string,
): Result.Result<string, ProtectedEntrypointInventoryError> =>
  Schema.is(StableIdentifierSchema)(value)
    ? Result.succeed(value)
    : Result.fail(invalidInventory(`${field} must be a stable, non-sensitive identifier`));

const normalizeAuthorization = (
  raw: InventoryAuthorization,
): Result.Result<InventoryAuthorization, ProtectedEntrypointInventoryError> =>
  Schema.decodeUnknownResult(InventoryAuthorizationSchema, {
    onExcessProperty: 'error',
  })(raw).pipe(
    Result.mapError(() =>
      invalidInventory('inventory authorization classification is invalid or contains excess data'),
    ),
  );

const normalizeSurface = (
  surface: ProtectedEntrypointSurface,
): Result.Result<ProtectedEntrypointSurface, ProtectedEntrypointInventoryError> =>
  Schema.decodeUnknownResult(ProtectedEntrypointSurfaceSchema)(surface).pipe(
    Result.mapError(() => invalidInventory(`unsupported inventory surface: ${surface}`)),
  );

const normalizeEntry = (
  entry: ProtectedEntrypointInventoryEntry,
): Result.Result<ProtectedEntrypointInventoryEntry, ProtectedEntrypointInventoryError> =>
  Result.gen(function* normalizeEntryResult() {
    const authorization = yield* normalizeAuthorization(entry.authorization);
    const deployment = yield* stableValue(entry.deployment, 'deployment');
    const entrypointKey = yield* stableValue(entry.entrypointKey, 'entrypointKey');
    const owner = yield* stableValue(entry.owner, 'owner');
    const surface = yield* normalizeSurface(entry.surface);
    return { authorization, deployment, entrypointKey, owner, surface };
  });

const compareInventoryEntries = (
  left: ProtectedEntrypointInventoryEntry,
  right: ProtectedEntrypointInventoryEntry,
): -1 | 0 | 1 => {
  const surfaceOrder = left.surface.localeCompare(right.surface);
  const order =
    surfaceOrder === 0 ? left.entrypointKey.localeCompare(right.entrypointKey) : surfaceOrder;
  if (order < 0) {
    return -1;
  }
  if (order > 0) {
    return 1;
  }
  return 0;
};

const InventoryEntryOrder = Order.make(compareInventoryEntries);

const normalizeProtectedEntrypointInventoryResult = (
  entries: readonly ProtectedEntrypointInventoryEntry[],
): Result.Result<readonly ProtectedEntrypointInventoryEntry[], ProtectedEntrypointInventoryError> =>
  Result.gen(function* normalizeInventoryResult() {
    const normalized = yield* Result.all(entries.map(normalizeEntry));
    const seen = new Set<string>();
    for (const entry of normalized) {
      if (seen.has(entry.entrypointKey)) {
        return yield* Result.fail(
          invalidInventory(`duplicate protected entrypoint: ${entry.entrypointKey}`),
        );
      }
      seen.add(entry.entrypointKey);
    }
    return EffectArray.sort(normalized, InventoryEntryOrder);
  });

export const normalizeProtectedEntrypointInventory = (
  entries: readonly ProtectedEntrypointInventoryEntry[],
): readonly ProtectedEntrypointInventoryEntry[] =>
  getOrThrowTypeError(normalizeProtectedEntrypointInventoryResult(entries));

export const hashProtectedEntrypointInventory = (
  entries: readonly ProtectedEntrypointInventoryEntry[],
): string => {
  const encodedEntries = getOrThrowTypeError(
    encodeJsonResult(entries).pipe(Result.mapError(encodingFailure)),
  );
  const source = `${encodedEntries}\n`;
  return bytesToHex(sha256(utf8ToBytes(source)));
};

export const makeProtectedEntrypointInventory = (
  sourceRevision: string,
  entries: readonly ProtectedEntrypointInventoryEntry[],
): ProtectedEntrypointInventory =>
  getOrThrowTypeError(
    Result.gen(function* makeInventoryResult() {
      if (!Schema.is(SourceRevisionSchema)(sourceRevision)) {
        return yield* Result.fail(
          invalidInventory('sourceRevision must be a stable revision identifier'),
        );
      }
      const normalized = yield* normalizeProtectedEntrypointInventoryResult(entries);
      return {
        entries: normalized,
        inventoryHash: hashProtectedEntrypointInventory(normalized),
        schemaVersion: PROTECTED_ENTRYPOINT_INVENTORY_SCHEMA_VERSION,
        sourceRevision,
      };
    }),
  );

export const serializeProtectedEntrypointInventory = (
  inventory: ProtectedEntrypointInventory,
): string =>
  `${getOrThrowTypeError(
    encodePrettyJsonResult(inventory).pipe(Result.mapError(encodingFailure)),
  )}\n`;
