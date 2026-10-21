/**
 * Capability catalog: the active composition (GET /active) joined with each vertical's generated HttpApi contracts.
 * Contracts are extracted in a child process (extract-contracts.ts) so vertical code never loads in this process.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { Catalog, CatalogAction, CatalogModule, CatalogRead } from '../capabilities/types.ts';
import { getEndpoints } from '../config.ts';
import type { ExtractedEndpoint, ExtractedModule, ExtractRequest, ExtractResponse } from './extract-contracts.ts';
import { commandInputSchema, isRecord, proposableTags, resolveRef, taggedVariants, toolNameOf } from './json-schema.ts';

/** Platform-internal modules: generic tools only, no typed tools. */
export const GENERIC_ONLY_MODULES: ReadonlySet<string> = new Set(['commerce.customer-context']);

export interface CompositionModule {
  readonly moduleId: string;
  readonly appId: string;
  readonly displayName: string;
  readonly apiKeys: ReadonlySet<string>;
  readonly actionKeys: ReadonlySet<string>;
}

export interface ParsedComposition {
  readonly revision: string;
  readonly modules: readonly CompositionModule[];
}

const compositionSchema = z.object({
  composition: z.object({
    revision: z.string(),
    modules: z.array(
      z.object({
        moduleId: z.string(),
        deployment: z.object({ appId: z.string() }),
        contractDocument: z.string(),
      }),
    ),
  }),
});

const manifestSchema = z.object({
  manifest: z.object({
    module: z.object({ displayName: z.string() }),
    publicSurface: z.object({
      api: z.array(z.object({ key: z.string() })),
      actions: z.array(z.object({ actionKey: z.string() })),
    }),
  }),
});

const extractResponseSchema = z.object({
  modules: z.array(
    z.object({
      moduleId: z.string(),
      appId: z.string(),
      endpoints: z.array(z.object({ path: z.string(), schema: z.record(z.string(), z.unknown()) })),
    }),
  ),
  warnings: z.array(z.string()),
});

export const parseComposition = (value: unknown): ParsedComposition => {
  const { composition } = compositionSchema.parse(value);
  return {
    revision: composition.revision,
    modules: composition.modules.map((module) => {
      const { manifest } = manifestSchema.parse(JSON.parse(module.contractDocument));
      return {
        moduleId: module.moduleId,
        appId: module.deployment.appId,
        displayName: manifest.module.displayName,
        apiKeys: new Set(manifest.publicSurface.api.map((entry) => entry.key)),
        actionKeys: new Set(manifest.publicSurface.actions.map((entry) => entry.actionKey)),
      };
    }),
  };
};

const READ_PATH = /^\/reads\/([a-z0-9-]+)$/u;

/** Reads of one module: `/reads/<slug>` endpoints that the manifest publishes, sorted by slug. */
const buildReads = (module: CompositionModule, endpoints: readonly ExtractedEndpoint[]): CatalogRead[] =>
  endpoints
    .flatMap((endpoint): CatalogRead[] => {
      const match = READ_PATH.exec(endpoint.path);
      const slug = match?.[1];
      if (slug === undefined || !module.apiKeys.has(`${module.moduleId}.${slug}`)) {
        return [];
      }
      return [
        {
          kind: 'read',
          id: `${module.moduleId}/read/${slug}`,
          moduleId: module.moduleId,
          appId: module.appId,
          slug,
          inputSchema: endpoint.schema,
          toolName: toolNameOf(module.appId, `read_${slug}`),
        },
      ];
    })
    .sort((a, b) => a.slug.localeCompare(b.slug));

/** Actions of one module: apply-command yields one entry per command variant, other Actions one entry each. */
const buildActions = (
  module: CompositionModule,
  endpoints: readonly ExtractedEndpoint[],
  warnings: string[],
): { actions: CatalogAction[]; supportsAiProposals: boolean } => {
  const actionPrefix = `/${module.appId}/actions/`;
  const actions: CatalogAction[] = [];
  const matchedSlugs = new Set<string>();
  let supportsAiProposals = false;

  for (const endpoint of endpoints) {
    if (!endpoint.path.startsWith(actionPrefix)) {
      continue;
    }
    const slug = endpoint.path.slice(actionPrefix.length);
    if (slug.includes('/') || !module.actionKeys.has(`${module.moduleId}.${slug}`)) {
      continue;
    }
    matchedSlugs.add(slug);
    const defs = isRecord(endpoint.schema['$defs']) ? endpoint.schema['$defs'] : {};

    if (slug === 'apply-command') {
      const root = resolveRef(endpoint.schema, defs);
      const properties = isRecord(root) && isRecord(root['properties']) ? root['properties'] : {};
      const variants = taggedVariants(resolveRef(properties['command'], defs), defs);
      const proposable = proposableTags(variants, defs);
      supportsAiProposals ||= variants.some((variant) => variant.tag === 'AiProposeChanges');
      for (const variant of variants) {
        actions.push({
          kind: 'action',
          id: `${module.moduleId}/command/${variant.tag}`,
          moduleId: module.moduleId,
          appId: module.appId,
          actionSlug: 'apply-command',
          commandTag: variant.tag,
          inputSchema: commandInputSchema(variant.schema, defs),
          toolName: toolNameOf(module.appId, variant.tag),
          proposable: proposable.has(variant.tag),
        });
      }
    } else {
      actions.push({
        kind: 'action',
        id: `${module.moduleId}/action/${slug}`,
        moduleId: module.moduleId,
        appId: module.appId,
        actionSlug: slug,
        commandTag: undefined,
        inputSchema: endpoint.schema,
        toolName: toolNameOf(module.appId, slug),
        proposable: false,
      });
    }
  }

  for (const key of module.actionKeys) {
    const slug = key.startsWith(`${module.moduleId}.`) ? key.slice(module.moduleId.length + 1) : key;
    if (!matchedSlugs.has(slug)) {
      warnings.push(`${module.moduleId}: akce ${slug} nemá kontrakt v shared/apis`);
    }
  }

  return { actions, supportsAiProposals };
};

const buildModule = (
  module: CompositionModule,
  extracted: ExtractedModule | undefined,
  warnings: string[],
): CatalogModule => {
  const endpoints = extracted?.endpoints ?? [];
  const reads = buildReads(module, endpoints);
  const { actions, supportsAiProposals } = buildActions(module, endpoints, warnings);
  const probeReadSlug =
    reads.find((read) => read.slug === 'records')?.slug ??
    reads.find((read) => {
      const required: unknown = read.inputSchema['required'];
      return !Array.isArray(required) || required.length === 0;
    })?.slug;

  return {
    moduleId: module.moduleId,
    appId: module.appId,
    displayName: module.displayName,
    reads,
    actions,
    probeReadSlug,
    supportsAiProposals,
    typedTools: !GENERIC_ONLY_MODULES.has(module.moduleId),
  };
};

/** Keeps tool names unique across the catalog: repeats get `_2`, `_3`, ... (base trimmed to 64 chars). */
const withUniqueToolNames = (modules: readonly CatalogModule[]): CatalogModule[] => {
  const used = new Set<string>();
  const claim = (name: string): string => {
    let candidate = name;
    for (let n = 2; used.has(candidate); n += 1) {
      const suffix = `_${n}`;
      candidate = `${name.slice(0, 64 - suffix.length)}${suffix}`;
    }
    used.add(candidate);
    return candidate;
  };
  return modules.map((module) => ({
    ...module,
    reads: module.reads.map((read) => ({ ...read, toolName: claim(read.toolName) })),
    actions: module.actions.map((action) => ({ ...action, toolName: claim(action.toolName) })),
  }));
};

export const buildCatalog = (composition: ParsedComposition, extracted: ExtractResponse): Catalog => {
  const extractedById = new Map(extracted.modules.map((module) => [module.moduleId, module]));
  const warnings = [...extracted.warnings];
  const modules = [...composition.modules]
    .sort((a, b) => a.moduleId.localeCompare(b.moduleId))
    .map((module) => buildModule(module, extractedById.get(module.moduleId), warnings));
  return {
    compositionRevision: composition.revision,
    modules: withUniqueToolNames(modules),
    warnings,
  };
};

export interface DiscoverOptions {
  readonly composition?: unknown;
  readonly verticalsRoot?: string;
  readonly extractScript?: string;
  readonly extract?: (request: ExtractRequest) => Promise<ExtractResponse>;
}

const EXTRACT_TIMEOUT_MS = 90_000;

/** Runs extract-contracts.ts in a child process: request JSON on stdin, one ExtractResponse JSON on stdout. */
const runExtractor = (request: ExtractRequest, options: DiscoverOptions): Promise<ExtractResponse> => {
  const script = options.extractScript ?? fileURLToPath(new URL('./extract-contracts.ts', import.meta.url));
  const root = options.verticalsRoot ?? fileURLToPath(new URL('../../../../verticals/', import.meta.url));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--no-warnings', script, root], { stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timer = setTimeout(() => child.kill('SIGKILL'), EXTRACT_TIMEOUT_MS);
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.stdin.on('error', () => undefined);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`Načtení kontraktů selhalo (kód ${code}): ${Buffer.concat(stderr).toString('utf-8').slice(-400)}`));
        return;
      }
      try {
        resolve(extractResponseSchema.parse(JSON.parse(Buffer.concat(stdout).toString('utf-8'))));
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.end(JSON.stringify(request));
  });
};

const fetchComposition = async (): Promise<unknown> => {
  const url = getEndpoints().compositionUrl;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Kompozice není dostupná (${url}): HTTP ${response.status}`);
  }
  return response.json();
};

export const discoverCatalog = async (options: DiscoverOptions = {}): Promise<Catalog> => {
  const compositionJson = options.composition ?? (await fetchComposition());
  const parsed = parseComposition(compositionJson);
  const request: ExtractRequest = {
    modules: parsed.modules.map(({ moduleId, appId }) => ({ moduleId, appId })),
  };
  const extracted = await (options.extract ?? ((input: ExtractRequest) => runExtractor(input, options)))(request);
  return buildCatalog(parsed, extracted);
};

const CATALOG_TTL_MS = 60_000;

let cachedCatalog: { readonly at: number; readonly catalog: Catalog } | undefined;
let inFlightCatalog: Promise<Catalog> | undefined;

/** Cached catalog (60 s TTL, one shared in-flight load). `refresh` bypasses the cache. */
export const getCatalog = async (options: { readonly refresh?: boolean } = {}): Promise<Catalog> => {
  if (!options.refresh) {
    if (cachedCatalog !== undefined && Date.now() - cachedCatalog.at < CATALOG_TTL_MS) {
      return cachedCatalog.catalog;
    }
    if (inFlightCatalog !== undefined) {
      return inFlightCatalog;
    }
  }
  const load = discoverCatalog().then((catalog) => {
    cachedCatalog = { at: Date.now(), catalog };
    return catalog;
  });
  inFlightCatalog = load;
  try {
    return await load;
  } finally {
    if (inFlightCatalog === load) {
      inFlightCatalog = undefined;
    }
  }
};
