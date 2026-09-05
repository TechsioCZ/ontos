/* eslint-disable max-classes-per-file, no-await-in-loop -- Distinct typed failures and sequential bounded stream reads are deliberate. */
// @effect-diagnostics asyncFunction:off instanceOfSchema:off preferSchemaOverJson:off
import {
  ONTOS_MODULE_CONTRACT_MAX_BYTES,
  ONTOS_MODULE_CONTRACT_TIMEOUT_MS,
  resolveInstalledModuleCatalog,
} from '@app/core-runtime';
import type {
  InstalledDeploymentFailureReason,
  InstalledDeploymentResolutionInput,
  InstalledModuleCatalog,
} from '@app/core-runtime';
import { Context, Duration, Effect, Exit, Layer, Schema } from 'effect';
import type { DeploymentAllowlist } from './deployment-allowlist.ts';
import { deploymentAllowlist } from './deployment-allowlist.ts';

export class InstalledModuleCatalogUnavailableError extends Schema.TaggedError<InstalledModuleCatalogUnavailableError>()(
  'InstalledModuleCatalogUnavailableError',
  {
    code: Schema.Literal('installed_module_catalog_unavailable'),
    reason: Schema.String,
  },
) {}

export class InstalledModuleCatalogInvalidError extends Schema.TaggedError<InstalledModuleCatalogInvalidError>()(
  'InstalledModuleCatalogInvalidError',
  {
    code: Schema.Literal('installed_module_catalog_invalid'),
    reason: Schema.String,
  },
) {}

export type InstalledModuleCatalogError =
  | InstalledModuleCatalogInvalidError
  | InstalledModuleCatalogUnavailableError;

export type ModuleContractFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface InstalledModuleCatalogLoaderOptions {
  readonly maxBytes?: number;
  readonly timeoutMs?: number;
}

export interface ShellInstalledModuleCatalogService {
  readonly load: Effect.Effect<InstalledModuleCatalog, InstalledModuleCatalogError>;
}

export class ShellInstalledModuleCatalog extends Context.Service<
  ShellInstalledModuleCatalog,
  ShellInstalledModuleCatalogService
>()('@app/shell-super-app/api/modules/installed-module-catalog/ShellInstalledModuleCatalog') {}

const unavailable = () =>
  new InstalledModuleCatalogUnavailableError({
    code: 'installed_module_catalog_unavailable',
    reason: 'An allowlisted module deployment is temporarily unavailable',
  });

const invalid = () =>
  new InstalledModuleCatalogInvalidError({
    code: 'installed_module_catalog_invalid',
    reason: 'The installed module catalog is contradictory or malformed',
  });

type JsonValue = Schema.Schema.Type<typeof Schema.Json>;

const readBoundedJson = async (
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<JsonValue> => {
  if (response.status < 200 || response.status >= 300 || response.redirected) {
    throw unavailable();
  }
  const contentType = response.headers.get('content-type')?.trim() ?? '';
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(contentType)) {
    throw invalid();
  }
  const declaredLength = response.headers.get('content-length');
  if (declaredLength !== null && Number(declaredLength) > maxBytes) {
    throw unavailable();
  }
  const reader = response.body?.getReader();
  if (reader === undefined) {
    throw unavailable();
  }
  let aborted = false;
  const cancelOnAbort = () => {
    aborted = true;
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener('abort', cancelOnAbort, { once: true });
  try {
    if (signal.aborted) {
      cancelOnAbort();
      throw unavailable();
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const next = await reader.read();
      if (aborted || signal.aborted) {
        throw unavailable();
      }
      if (next.done) {
        break;
      }
      size += next.value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw unavailable();
      }
      chunks.push(next.value);
    }
    if (aborted || signal.aborted) {
      throw unavailable();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    try {
      return Schema.decodeUnknownSync(Schema.Json)(JSON.parse(new TextDecoder().decode(bytes)));
    } catch {
      throw invalid();
    }
  } finally {
    signal.removeEventListener('abort', cancelOnAbort);
  }
};

const failedContract = (
  expectedAppId: string,
  reason: InstalledDeploymentFailureReason,
): InstalledDeploymentResolutionInput => ({
  expectedAppId,
  outcome: 'failed',
  reason,
});

const fetchContract = (
  appId: string,
  contractUrl: string,
  fetchContractDocument: ModuleContractFetch,
  options: Required<InstalledModuleCatalogLoaderOptions>,
): Effect.Effect<InstalledDeploymentResolutionInput> =>
  Effect.tryPromise({
    catch: (error) => (error instanceof InstalledModuleCatalogInvalidError ? error : unavailable()),
    // Effect owns the signal; a fetcher that cannot cancel its Promise may settle later,
    // but tryPromise discards that settlement after this fiber has been interrupted.
    try: async (signal) => {
      const response = await fetchContractDocument(contractUrl, {
        headers: { accept: 'application/json' },
        redirect: 'manual',
        signal,
      });
      return {
        contract: await readBoundedJson(response, options.maxBytes, signal),
        expectedAppId: appId,
        outcome: 'fetched',
      } as const;
    },
  }).pipe(
    Effect.timeout(options.timeoutMs),
    Effect.catchTags({
      TimeoutError: () => Effect.succeed(failedContract(appId, 'timeout')),
      InstalledModuleCatalogInvalidError: () =>
        Effect.succeed(failedContract(appId, 'incompatible')),
      InstalledModuleCatalogUnavailableError: () =>
        Effect.succeed(failedContract(appId, 'unavailable')),
    }),
  );

const isHealthy = (catalog: InstalledModuleCatalog): boolean =>
  catalog.deploymentStatuses.every(({ status }) => status === 'available');

/** Creates one lazy cache for a fully healthy allowlist revision; degraded reads retry. */
export const makeInstalledModuleCatalogLoader = (
  allowlist: DeploymentAllowlist,
  fetchContractDocument: ModuleContractFetch = globalThis.fetch,
  inputOptions: InstalledModuleCatalogLoaderOptions = {},
): Effect.Effect<InstalledModuleCatalog, InstalledModuleCatalogError> => {
  const options = {
    maxBytes: inputOptions.maxBytes ?? ONTOS_MODULE_CONTRACT_MAX_BYTES,
    timeoutMs: inputOptions.timeoutMs ?? ONTOS_MODULE_CONTRACT_TIMEOUT_MS,
  };
  const loadCatalog = Effect.gen(function* () {
    const contracts = yield* Effect.forEach(
      allowlist.entries,
      ({ appId, contractUrl }) => fetchContract(appId, contractUrl, fetchContractDocument, options),
      { concurrency: 4 },
    );
    return yield* Effect.try({
      catch: (error) =>
        error instanceof InstalledModuleCatalogUnavailableError ? error : invalid(),
      try: () => resolveInstalledModuleCatalog(contracts),
    });
  });
  let loading: Effect.Effect<InstalledModuleCatalog, InstalledModuleCatalogError> | undefined;
  let invalidate: Effect.Effect<void> | undefined;
  return Effect.gen(function* () {
    if (loading === undefined || invalidate === undefined) {
      [loading, invalidate] = yield* Effect.cachedInvalidateWithTTL(loadCatalog, Duration.infinity);
    }
    if (loading === undefined || invalidate === undefined) {
      return yield* Effect.die('Installed module catalog cache was not initialized');
    }
    const currentLoading = loading;
    const currentInvalidate = invalidate;
    return yield* Effect.onExit(currentLoading, (exit) =>
      Exit.isSuccess(exit) && isHealthy(exit.value) ? Effect.void : currentInvalidate,
    );
  });
};

export const makeInstalledModuleCatalogLayer = (
  allowlist: DeploymentAllowlist,
  fetchContractDocument: ModuleContractFetch = globalThis.fetch,
  options: InstalledModuleCatalogLoaderOptions = {},
): Layer.Layer<ShellInstalledModuleCatalog> =>
  Layer.succeed(ShellInstalledModuleCatalog, {
    load: makeInstalledModuleCatalogLoader(allowlist, fetchContractDocument, options),
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
        Effect.mapError(invalid),
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
