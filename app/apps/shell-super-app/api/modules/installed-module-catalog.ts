import {
  ONTOS_MODULE_CONTRACT_MAX_BYTES,
  ONTOS_MODULE_CONTRACT_TIMEOUT_MS,
  OntosModuleDeploymentContractSchema,
  resolveInstalledModuleCatalog,
} from '@app/core-runtime';
import type {
  InstalledDeploymentFailureReason,
  InstalledDeploymentResolutionInput,
  InstalledModuleCatalog,
} from '@app/core-runtime';
import {
  Cause,
  Chunk,
  Context,
  Duration,
  Effect,
  Function as Fn,
  Layer,
  Schema,
  Semaphore,
} from 'effect';
import type { DeploymentAllowlist } from './deployment-allowlist.ts';
import { deploymentAllowlist } from './deployment-allowlist.ts';

const unavailableErrorFields = {
  cause: Schema.optionalKey(Schema.Defect()),
  code: Schema.Literal('installed_module_catalog_unavailable'),
  reason: Schema.String,
};

const InstalledModuleCatalogUnavailableErrorSchema = Schema.TaggedStruct(
  'InstalledModuleCatalogUnavailableError',
  unavailableErrorFields,
);
type InstalledModuleCatalogUnavailableFailure =
  typeof InstalledModuleCatalogUnavailableErrorSchema.Type;
export const InstalledModuleCatalogUnavailableError =
  Schema.TaggedError<InstalledModuleCatalogUnavailableFailure>()(
    'InstalledModuleCatalogUnavailableError',
    unavailableErrorFields,
  );

const invalidErrorFields = {
  cause: Schema.optionalKey(Schema.Defect()),
  code: Schema.Literal('installed_module_catalog_invalid'),
  reason: Schema.String,
};
const InstalledModuleCatalogInvalidErrorSchema = Schema.TaggedStruct(
  'InstalledModuleCatalogInvalidError',
  invalidErrorFields,
);
type InstalledModuleCatalogInvalidFailure = typeof InstalledModuleCatalogInvalidErrorSchema.Type;
export const InstalledModuleCatalogInvalidError =
  Schema.TaggedError<InstalledModuleCatalogInvalidFailure>()(
    'InstalledModuleCatalogInvalidError',
    invalidErrorFields,
  );

export type InstalledModuleCatalogError =
  | InstalledModuleCatalogInvalidFailure
  | InstalledModuleCatalogUnavailableFailure;

export type ModuleContractFetch = typeof globalThis.fetch;

export interface InstalledModuleCatalogLoaderOptions {
  readonly maxBytes?: number;
  readonly timeoutMs?: number;
}

type InstalledModuleCatalogLoaderArguments = readonly [
  fetchContractDocument?: ModuleContractFetch,
  inputOptions?: InstalledModuleCatalogLoaderOptions,
];

export interface ShellInstalledModuleCatalogService {
  readonly load: Effect.Effect<InstalledModuleCatalog, InstalledModuleCatalogError>;
}

export class ShellInstalledModuleCatalog extends Context.Service<
  ShellInstalledModuleCatalog,
  ShellInstalledModuleCatalogService
>()('@app/shell-super-app/api/modules/installed-module-catalog/ShellInstalledModuleCatalog') {}

const unavailable = (cause?: unknown) => {
  const error = new InstalledModuleCatalogUnavailableError({
    code: 'installed_module_catalog_unavailable',
    reason: 'An allowlisted module deployment is temporarily unavailable',
  });
  if (cause !== undefined) {
    Object.defineProperty(error, 'cause', { configurable: true, value: cause });
  }
  return error;
};

const invalid = (cause?: unknown) => {
  const error = new InstalledModuleCatalogInvalidError({
    code: 'installed_module_catalog_invalid',
    reason: 'The installed module catalog is contradictory or malformed',
  });
  if (cause !== undefined) {
    Object.defineProperty(error, 'cause', { configurable: true, value: cause });
  }
  return error;
};

const isInvalid = Schema.is(InstalledModuleCatalogInvalidErrorSchema);
const decodeContractDocument = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OntosModuleDeploymentContractSchema),
  { onExcessProperty: 'error' },
);

interface ResponseBodyState {
  readonly chunks: Chunk.Chunk<Uint8Array>;
  readonly size: number;
}
const emptyResponseBodyState: ResponseBodyState = { chunks: Chunk.empty(), size: 0 };

const concatenateChunks = (chunks: Iterable<Uint8Array>, size: number): Uint8Array => {
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
};

const readResponseChunks = (
  reader: ReadableStreamDefaultReader<Uint8Array>,
  maxBytes: number,
  timeout: Duration.Duration,
  state: ResponseBodyState,
): Effect.Effect<
  ResponseBodyState,
  InstalledModuleCatalogUnavailableFailure | Cause.TimeoutError
> =>
  Effect.tryPromise({
    catch: unavailable,
    // oxlint-disable-next-line typescript/promise-function-async -- Effect owns this foreign stream Promise boundary.
    try: () => reader.read(),
  }).pipe(
    Effect.timeout(timeout),
    Effect.flatMap((next) => {
      if (next.done) {
        return Effect.succeed(state);
      }
      const size = state.size + next.value.byteLength;
      if (size > maxBytes) {
        return Effect.fail(unavailable());
      }
      return readResponseChunks(reader, maxBytes, timeout, {
        chunks: Chunk.append(state.chunks, next.value),
        size,
      });
    }),
  );

const collectResponseBody = Effect.fn('ShellInstalledModuleCatalog.collectResponseBody')(
  function* collectResponseBodyEffect(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    maxBytes: number,
    timeout: Duration.Duration,
  ) {
    const { chunks, size } = yield* readResponseChunks(
      reader,
      maxBytes,
      timeout,
      emptyResponseBodyState,
    );
    return new TextDecoder().decode(concatenateChunks(chunks, size));
  },
);

const readBoundedContract = Effect.fn('ShellInstalledModuleCatalog.readBoundedContract')(
  function* readBoundedContractEffect(
    response: Response,
    maxBytes: number,
    timeout: Duration.Duration,
  ) {
    if (response.status < 200 || response.status >= 300 || response.redirected) {
      return yield* unavailable();
    }
    const contentType = response.headers.get('content-type')?.trim() ?? '';
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(contentType)) {
      return yield* invalid();
    }
    const declaredLength = response.headers.get('content-length');
    if (declaredLength !== null && Number(declaredLength) > maxBytes) {
      return yield* unavailable();
    }
    const reader = response.body?.getReader();
    if (reader === undefined) {
      return yield* unavailable();
    }
    const text = yield* Effect.acquireUseRelease(
      Effect.succeed(reader),
      (bodyReader) => collectResponseBody(bodyReader, maxBytes, timeout),
      // oxlint-disable-next-line typescript/promise-function-async -- Effect owns this foreign stream Promise boundary.
      (bodyReader) => Effect.promise(() => bodyReader.cancel()).pipe(Effect.ignore),
    );
    return yield* decodeContractDocument(text).pipe(Effect.mapError((cause) => invalid(cause)));
  },
);

const fetchContract = Effect.fn('ShellInstalledModuleCatalog.fetchContract')(
  function* fetchContractEffect(
    appId: string,
    contractUrl: string,
    fetchContractDocument: ModuleContractFetch,
    options: Required<InstalledModuleCatalogLoaderOptions>,
  ) {
    const timeout = Duration.millis(options.timeoutMs);
    const requestContractDocument = Fn.flow(
      (signal: AbortSignal): RequestInit => ({
        headers: { accept: 'application/json' },
        redirect: 'manual',
        signal,
      }),
      fetchContractDocument.bind(undefined, contractUrl),
    );
    const attempt = Effect.gen(function* fetchContractAttempt() {
      const response = yield* Effect.tryPromise({
        catch: unavailable,
        try: requestContractDocument,
      }).pipe(Effect.timeout(timeout));
      const contract = yield* readBoundedContract(response, options.maxBytes, timeout);
      return {
        contract,
        expectedAppId: appId,
        outcome: 'fetched' as const,
      } satisfies InstalledDeploymentResolutionInput;
    }).pipe(Effect.timeout(timeout));
    return yield* attempt.pipe(
      Effect.catch((error) => {
        let reason: InstalledDeploymentFailureReason = 'unavailable';
        if (Cause.isTimeoutError(error)) {
          reason = 'timeout';
        } else if (isInvalid(error)) {
          reason = 'incompatible';
        }
        return Effect.succeed({
          expectedAppId: appId,
          outcome: 'failed',
          reason,
        } satisfies InstalledDeploymentResolutionInput);
      }),
    );
  },
);

/** Creates one lazy cache for a fully healthy allowlist revision; degraded reads retry. */
export const makeInstalledModuleCatalogLoader = (
  allowlist: DeploymentAllowlist,
  ...[
    fetchContractDocument = globalThis.fetch,
    inputOptions = {},
  ]: InstalledModuleCatalogLoaderArguments
): Effect.Effect<InstalledModuleCatalog, InstalledModuleCatalogError> => {
  const options = {
    maxBytes: inputOptions.maxBytes ?? ONTOS_MODULE_CONTRACT_MAX_BYTES,
    timeoutMs: inputOptions.timeoutMs ?? ONTOS_MODULE_CONTRACT_TIMEOUT_MS,
  };
  const cacheLock = Semaphore.makeUnsafe(1);
  let cached: InstalledModuleCatalog | undefined;
  let loading: Effect.Effect<InstalledModuleCatalog, InstalledModuleCatalogError> | undefined;
  const loadCatalog = Effect.all(
    allowlist.entries.map(({ appId, contractUrl }) =>
      fetchContract(appId, contractUrl, fetchContractDocument, options),
    ),
    { concurrency: 8 },
  ).pipe(
    Effect.flatMap((contracts) =>
      Effect.try({
        catch: invalid,
        try: () => resolveInstalledModuleCatalog(contracts),
      }),
    ),
    Effect.tap((catalog) =>
      catalog.deploymentStatuses.every(({ status }) => status === 'available')
        ? Effect.sync(() => {
            cached = catalog;
          })
        : Effect.void,
    ),
    Effect.ensuring(
      Effect.sync(() => {
        loading = undefined;
      }),
    ),
  );
  const resolveCachedCatalog = Effect.suspend(() => {
    if (cached !== undefined) {
      return Effect.succeed(Effect.succeed(cached));
    }
    if (loading !== undefined) {
      return Effect.succeed(loading);
    }
    return Effect.cached(loadCatalog).pipe(
      Effect.tap((memoizedLoad) =>
        Effect.sync(() => {
          loading = memoizedLoad;
        }),
      ),
    );
  });
  return cacheLock.withPermit(resolveCachedCatalog).pipe(Effect.flatten);
};

export const makeInstalledModuleCatalogLayer = (
  allowlist: DeploymentAllowlist,
  ...loaderArguments: InstalledModuleCatalogLoaderArguments
): Layer.Layer<ShellInstalledModuleCatalog> =>
  Layer.succeed(ShellInstalledModuleCatalog, {
    load: makeInstalledModuleCatalogLoader(allowlist, ...loaderArguments),
  });

export const installedModuleCatalog: Effect.Effect<
  InstalledModuleCatalog,
  InstalledModuleCatalogError,
  ShellInstalledModuleCatalog
> = ShellInstalledModuleCatalog.pipe(Effect.flatMap(({ load }) => load));

export const ShellInstalledModuleCatalogLive = Layer.sync(
  ShellInstalledModuleCatalog,
  (): ShellInstalledModuleCatalogService => {
    let loader: Effect.Effect<InstalledModuleCatalog, InstalledModuleCatalogError> | undefined;
    return {
      load: deploymentAllowlist.pipe(
        Effect.mapError((cause) => invalid(cause)),
        Effect.flatMap((allowlist) => {
          // Build-time injection is immutable for one runtime Layer. A deployment revision
          // creates a new build/runtime Layer instead of mutating a live catalog entry-by-entry.
          loader ??= makeInstalledModuleCatalogLoader(allowlist);
          return loader;
        }),
      ),
    };
  },
);
