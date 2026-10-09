import { createHash } from 'node:crypto';

import { Config, DateTime, Effect, FileSystem, Path, Schema } from 'effect';

import { validateNativeCompositionSourceUrl } from './configure-runtime-composition-source.mts';

import {
  InitialCutoverProviderError,
  quiesceInitialCutoverProviderInventory,
  verifyInitialCutoverProviderInventory,
} from './initial-composition-cutover-provider.mts';

const ExecutionRoleSchema = Schema.Literals(['ingress', 'producer', 'matcher', 'worker', 'hosted_job']);
const RolesSchema = Schema.Array(ExecutionRoleSchema);
const EnvironmentSchema = Schema.Literals(['stage', 'production']);
const AccountIdSchema = Schema.String.check(Schema.isPattern(/^[a-f0-9]{32}$/u)).pipe(
  Schema.brand('CompositionCutoverAccountId'),
);
const NamespaceIdSchema = Schema.String.check(Schema.isPattern(/^[a-f0-9]{32}$/u)).pipe(
  Schema.brand('CompositionCutoverNamespaceId'),
);
const ServiceIdSchema = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9]{22}$/u)).pipe(
  Schema.brand('CompositionCutoverServiceId'),
);
const LegacyApplicationSchema = Schema.NonEmptyString.pipe(Schema.brand('CompositionCutoverApplicationId'));
const ApplicationIdsSchema = Schema.Array(LegacyApplicationSchema);
const WorkerNameSchema = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,62}$/u));

/** Reviewed legacy execution placement. It has no role in installed module selection. */
export const InitialCompositionExecutionInventorySchema = Schema.Struct({
  applicationIds: ApplicationIdsSchema,
  cloudflare: Schema.Struct({
    accountId: AccountIdSchema,
    compositionPointer: Schema.Struct({
      namespaceId: NamespaceIdSchema,
      sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
    }),
    workers: Schema.Array(
      Schema.Struct({ appId: LegacyApplicationSchema, name: WorkerNameSchema, roles: RolesSchema }),
    ),
  }),
  environment: EnvironmentSchema,
  schemaVersion: Schema.Literal('2'),
  sourceRevision: Schema.String.check(Schema.isPattern(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u)),
  zerops: Schema.Array(
    Schema.Struct({
      appId: LegacyApplicationSchema,
      kind: Schema.Literal('node-runtime'),
      roles: RolesSchema,
      serviceId: ServiceIdSchema,
    }),
  ),
});
export type InitialCompositionExecutionInventory = typeof InitialCompositionExecutionInventorySchema.Type;

export const InitialCompositionCutoverReceiptSchema = Schema.Struct({
  environment: EnvironmentSchema,
  inventorySha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
  schemaVersion: Schema.Literal('2'),
  verifiedAt: Schema.DateTimeUtcFromString,
});

const invalid = (reason: string) =>
  new InitialCutoverProviderError({ operation: 'verify', provider: 'inventory', reason });
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** Missing targets in another account do not establish quiescence of this environment. */
export const validateConfiguredInitialCompositionInventory = (inventory: InitialCompositionExecutionInventory) =>
  Effect.gen(function* bindExecutionInventoryToProviderAccount() {
    const source = yield* Config.String('ONTOS_ACTIVE_APPLICATION_COMPOSITION_URL').pipe(
      Effect.flatMap(validateNativeCompositionSourceUrl),
      Effect.mapError(() => invalid('The native composition source configuration is required for cutover')),
    );
    const accountId = new URL(source).pathname.split('/').at(4);
    if (accountId !== inventory.cloudflare.accountId) {
      return yield* invalid('The execution inventory belongs to another provider account');
    }
    const namespaceId = new URL(source).pathname.split('/').at(8);
    if (namespaceId !== inventory.cloudflare.compositionPointer.namespaceId) {
      return yield* invalid('The obsolete composition pointer belongs to another provider namespace');
    }
    return yield* Effect.void;
  });

/** Every declared legacy application and every execution category needs a concrete provider target. */
export const validateInitialCompositionExecutionInventory = (inventory: InitialCompositionExecutionInventory) =>
  Effect.gen(function* validateExecutionInventory() {
    const applications = new Set(inventory.applicationIds);
    const targets = [...inventory.zerops, ...inventory.cloudflare.workers];
    const covered = new Set(targets.map(({ appId }) => appId));
    const roles = new Set(targets.flatMap((target) => target.roles));
    if (
      applications.size === 0 ||
      applications.size !== inventory.applicationIds.length ||
      !inventory.applicationIds.some((appId) => appId === 'shell-super-app') ||
      !inventory.applicationIds.some((appId) => appId === 'commerce-customer-context') ||
      covered.size !== applications.size ||
      [...covered].some((appId) => !applications.has(appId)) ||
      ExecutionRoleSchema.literals.some((role) => !roles.has(role)) ||
      !targets.some((target) => target.appId === 'commerce-customer-context' && target.roles.includes('hosted_job')) ||
      targets.some((target) => target.roles.length === 0 || new Set(target.roles).size !== target.roles.length) ||
      new Set(inventory.zerops.map(({ serviceId }) => serviceId)).size !== inventory.zerops.length ||
      new Set(inventory.cloudflare.workers.map(({ name }) => name)).size !== inventory.cloudflare.workers.length
    ) {
      return yield* invalid('The reviewed legacy execution inventory is incomplete or ambiguous');
    }
    return inventory;
  });

const providerInventory = (inventory: InitialCompositionExecutionInventory) => ({
  cloudflare: {
    accountId: inventory.cloudflare.accountId,
    compositionPointer: inventory.cloudflare.compositionPointer,
    workerNames: inventory.cloudflare.workers.map(({ name }) => name),
  },
  zeropsServiceIds: inventory.zerops.map(({ serviceId }) => serviceId),
});

const readInventory = (input: { readonly environment: string; readonly inventoryFile: string }) =>
  Effect.gen(function* readLegacyExecutionInventory() {
    const filesystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* filesystem.realPath(path.resolve(import.meta.dirname, '..', 'topology'));
    const file = yield* filesystem
      .realPath(path.resolve(input.inventoryFile))
      .pipe(Effect.mapError(() => invalid('The execution inventory cannot be resolved')));
    if (!file.startsWith(`${root}${path.sep}`) || file.split(path.sep).some((segment) => segment.startsWith('.env'))) {
      return yield* invalid('The reviewed execution inventory must be a topology file');
    }
    const bytes = yield* filesystem
      .readFile(file)
      .pipe(Effect.mapError(() => invalid('The execution inventory cannot be read')));
    if (bytes.byteLength > 1024 * 1024) {
      return yield* invalid('The execution inventory exceeds its byte budget');
    }
    const text = yield* Effect.try({
      catch: () => invalid('The execution inventory is not UTF-8'),
      try: () => new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    });
    const inventory = yield* Schema.decodeEffect(Schema.fromJsonString(InitialCompositionExecutionInventorySchema), {
      onExcessProperty: 'error',
    })(text).pipe(Effect.mapError(() => invalid('The execution inventory is invalid')));
    if (inventory.environment !== input.environment) {
      return yield* invalid('The execution inventory belongs to another environment');
    }
    yield* validateInitialCompositionExecutionInventory(inventory);
    yield* validateConfiguredInitialCompositionInventory(inventory);
    return { inventory, inventorySha256: sha256(bytes) };
  });

const receiptPath = (file: string, writing: boolean) =>
  Effect.gen(function* dedicatedReceiptPath() {
    const filesystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const resolved = path.resolve(file);
    const canonical = writing
      ? path.join(yield* filesystem.realPath(path.dirname(resolved)), path.basename(resolved))
      : yield* filesystem
          .realPath(resolved)
          .pipe(
            Effect.mapError(() => invalid('Initial composition publication requires its native quiescence receipt')),
          );
    if (canonical.split(path.sep).some((segment) => segment.startsWith('.env'))) {
      return yield* invalid('The quiescence receipt must be a dedicated artifact file');
    }
    return canonical;
  });

/** Operator-only irreversible cutover. A receipt is written only after native providers verify quiescence. */
export const quiesceInitialCompositionCutover = (input: {
  readonly environment: string;
  readonly inventoryFile: string;
  readonly receiptFile: string;
}) =>
  Effect.gen(function* quiesceLegacyExecution() {
    const output = yield* receiptPath(input.receiptFile, true);
    const { inventory, inventorySha256 } = yield* readInventory(input);
    yield* quiesceInitialCutoverProviderInventory(providerInventory(inventory));
    const receipt: typeof InitialCompositionCutoverReceiptSchema.Type = {
      environment: inventory.environment,
      inventorySha256,
      schemaVersion: '2',
      verifiedAt: yield* DateTime.now,
    };
    const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(InitialCompositionCutoverReceiptSchema))(receipt);
    const filesystem = yield* FileSystem.FileSystem;
    return yield* filesystem.writeFileString(output, encoded, { flag: 'wx' });
  });

/** A receipt is no approval checkbox: absence of every retired executable is rechecked immediately before first promotion. */
export const verifyInitialCompositionCutover = (input: {
  readonly environment: string;
  readonly inventoryFile: string;
  readonly receiptFile: string;
}) =>
  Effect.gen(function* verifyLegacyExecutionQuiescence() {
    const { inventory, inventorySha256 } = yield* readInventory(input);
    const filesystem = yield* FileSystem.FileSystem;
    const file = yield* receiptPath(input.receiptFile, false);
    const receiptBytes = yield* filesystem
      .readFile(file)
      .pipe(Effect.mapError(() => invalid('Initial composition publication requires its native quiescence receipt')));
    if (receiptBytes.byteLength > 1024 * 1024) {
      return yield* invalid('The initial quiescence receipt exceeds its byte budget');
    }
    const encoded = yield* Effect.try({
      catch: () => invalid('The initial quiescence receipt is not UTF-8'),
      try: () => new TextDecoder('utf-8', { fatal: true }).decode(receiptBytes),
    });
    const receipt = yield* Schema.decodeEffect(Schema.fromJsonString(InitialCompositionCutoverReceiptSchema), {
      onExcessProperty: 'error',
    })(encoded).pipe(Effect.mapError(() => invalid('The initial quiescence receipt is invalid')));
    if (
      receipt.inventorySha256 !== inventorySha256 ||
      receipt.environment !== inventory.environment ||
      DateTime.toEpochMillis(receipt.verifiedAt) > DateTime.toEpochMillis(yield* DateTime.now)
    ) {
      return yield* invalid('The initial quiescence receipt does not bind this reviewed execution inventory');
    }
    return yield* verifyInitialCutoverProviderInventory(providerInventory(inventory));
  });
