/* eslint-disable max-classes-per-file, no-await-in-loop -- Distinct typed failures and sequential bounded stream reads are deliberate. */
// @effect-diagnostics asyncFunction:off globalTimers:off instanceOfSchema:off preferSchemaOverJson:off
import {
  ONTOS_MODULE_CONTRACT_MAX_BYTES,
  ONTOS_MODULE_CONTRACT_TIMEOUT_MS,
  buildInstalledModuleCatalog,
} from '@app/core-runtime';
import type { InstalledModuleCatalog } from '@app/core-runtime';
import { Context, Effect, Layer, Schema } from 'effect';
import type { DeploymentAllowlist } from './deployment-allowlist.ts';
import { deploymentAllowlist } from './deployment-allowlist.ts';

export class InstalledModuleCatalogUnavailableError extends Schema.TaggedErrorClass<InstalledModuleCatalogUnavailableError>()(
  'InstalledModuleCatalogUnavailableError',
  {
    code: Schema.Literal('installed_module_catalog_unavailable'),
    reason: Schema.String,
  },
) {}

export class InstalledModuleCatalogInvalidError extends Schema.TaggedErrorClass<InstalledModuleCatalogInvalidError>()(
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

const readBoundedJson = async (response: Response, maxBytes: number): Promise<JsonValue> => {
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
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const next = await reader.read();
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
};

const fetchContract = async (
  appId: string,
  contractUrl: string,
  fetchContractDocument: ModuleContractFetch,
  options: Required<InstalledModuleCatalogLoaderOptions>,
): Promise<{ readonly contract: JsonValue; readonly expectedAppId: string }> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const response = await fetchContractDocument(contractUrl, {
      headers: { accept: 'application/json' },
      redirect: 'manual',
      signal: controller.signal,
    });
    return { contract: await readBoundedJson(response, options.maxBytes), expectedAppId: appId };
  } catch (error) {
    if (
      error instanceof InstalledModuleCatalogInvalidError ||
      error instanceof InstalledModuleCatalogUnavailableError
    ) {
      throw error;
    }
    throw unavailable();
  } finally {
    clearTimeout(timeout);
  }
};

/** Creates one lazy, all-or-nothing cache for one injected allowlist revision. */
export const makeInstalledModuleCatalogLoader = (
  allowlist: DeploymentAllowlist,
  fetchContractDocument: ModuleContractFetch = globalThis.fetch,
  inputOptions: InstalledModuleCatalogLoaderOptions = {},
): Effect.Effect<InstalledModuleCatalog, InstalledModuleCatalogError> => {
  const options = {
    maxBytes: inputOptions.maxBytes ?? ONTOS_MODULE_CONTRACT_MAX_BYTES,
    timeoutMs: inputOptions.timeoutMs ?? ONTOS_MODULE_CONTRACT_TIMEOUT_MS,
  };
  let cached: InstalledModuleCatalog | undefined;
  let loading: Promise<InstalledModuleCatalog> | undefined;
  return Effect.tryPromise({
    catch: (error) => (error instanceof InstalledModuleCatalogUnavailableError ? error : invalid()),
    try: () => {
      if (cached !== undefined) {
        return Promise.resolve(cached);
      }
      loading ??= (async () => {
        try {
          const contracts = await Promise.all(
            allowlist.entries.map(({ appId, contractUrl }) =>
              fetchContract(appId, contractUrl, fetchContractDocument, options),
            ),
          );
          const catalog = buildInstalledModuleCatalog(contracts);
          cached = catalog;
          return catalog;
        } finally {
          loading = undefined;
        }
      })();
      return loading;
    },
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
