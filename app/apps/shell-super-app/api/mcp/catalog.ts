/**
 * MCP catalog of the active Application Composition. Each admitted MicroVertical's deployment contract carries its
 * `publicSurface.mcp` contribution (module texts, approvals, revision read) and pins its tools as a separate artifact
 * of the same release by SHA-256. Every runtime reads only the small contribution; the Shell loads a module's tools
 * from its approved release (service binding on Workers, URL on Node) when the MCP endpoint needs them, verifies
 * the digest and keeps them per isolate by digest. The Shell knows no vertical, tool or schema; a module that is not
 * composed contributes nothing.
 */
import type { ApplicationComposition } from '@app/core-runtime';
import { moduleReleaseFetch } from '@app/core-runtime/unit-service-fetch';
import { OntosMcpContributionSchema, OntosMcpToolCatalogJsonSchema } from '@app/core-runtime/modules/mcp-contribution';
import type {
  OntosMcpCommandFieldLabels,
  OntosMcpContribution,
  OntosMcpText,
  OntosMcpTool,
  OntosMcpToolCatalog,
} from '@app/core-runtime/modules/mcp-contribution';
import { Array as Arr, Data, Duration, Effect, Option, Ref, Result, Schema } from 'effect';

export type JsonObject = Readonly<Record<string, Schema.Json>>;

export interface McpCatalogTool extends Omit<OntosMcpTool, 'inputSchema'> {
  readonly appId: string;
  /** Self-contained JSON Schema (the referenced shared definitions are attached as `$defs`). */
  readonly inputSchema: JsonObject;
  readonly moduleId: string;
}

/** A module's MCP contribution as its contract states it: everything but the tools. */
export interface McpModule {
  readonly agentAdministrationPage?: OntosMcpContribution['agentAdministrationPage'];
  readonly appId: string;
  /** The module's agent review read the approval platform asks (undefined: generic handling). */
  readonly approvalReview: OntosMcpContribution['approvalReview'];
  readonly approvals: boolean;
  /** Shell page where people review the module's own AI changes (undefined: none). */
  readonly approvalsPage: OntosMcpContribution['approvalsPage'];
  /** Czech names of the module's command fields, by wire key (empty: the module names none). */
  readonly commandFieldLabels: OntosMcpCommandFieldLabels;
  readonly description: OntosMcpText;
  readonly keywords: string;
  readonly label: OntosMcpText;
  readonly moduleId: string;
  /** The module keeps its own AI change engine the approval queue reads (legacy `aiChanges`). */
  readonly ownProposalEngine: boolean;
  readonly page: string | undefined;
  readonly recordLinks?: OntosMcpContribution['recordLinks'];
  readonly revision: OntosMcpContribution['revision'];
  /** Where the module's release serves its tools (path on its origin) and the digest the contract pins. */
  readonly toolCatalog: { readonly path: string; readonly sha256: string; readonly toolCount: number };
}

export interface McpCatalogModule extends McpModule {
  readonly tools: readonly McpCatalogTool[];
}

export interface McpModules {
  readonly compositionRevision: string;
  readonly modules: readonly McpModule[];
  /** Contracts whose MCP contribution could not be read (module id and reason). */
  readonly warnings: readonly string[];
}

export interface McpCatalog {
  readonly compositionRevision: string;
  readonly modules: readonly McpCatalogModule[];
  /** Contracts whose MCP contribution or tools could not be read (module id and reason). */
  readonly warnings: readonly string[];
}

const ContractMcpSchema = Schema.Struct({
  manifest: Schema.Struct({
    publicSurface: Schema.Struct({ mcp: Schema.optionalKey(OntosMcpContributionSchema) }),
  }),
});
const decodeContractMcp = Schema.decodeUnknownOption(Schema.fromJsonString(ContractMcpSchema));

const isObject = Schema.is(Schema.JsonObject);

const REF = /^#\/\$defs\/(?<name>.+)$/u;

/** The tool schema plus exactly the shared definitions it references (transitively). */
export const selfContainedSchema = (schema: JsonObject, definitions: JsonObject): JsonObject => {
  const needed = new Map<string, Schema.Json>();
  const visit = (node: Schema.Json): void => {
    if (Arr.isArray<Schema.Json>(node)) {
      for (const child of node) {
        visit(child);
      }
      return;
    }
    if (!isObject(node)) {
      return;
    }
    const ref = node['$ref'];
    const name = Schema.is(Schema.String)(ref) ? REF.exec(ref)?.groups?.['name'] : undefined;
    if (name !== undefined && !needed.has(name)) {
      const definition = definitions[name];
      if (definition !== undefined) {
        needed.set(name, definition);
        visit(definition);
      }
    }
    for (const child of Object.values(node)) {
      visit(child);
    }
  };
  visit(schema);
  return needed.size === 0 ? schema : { ...schema, $defs: Object.fromEntries(needed) };
};

/** Tool names stay unique across modules: repeats get `_2`, `_3`, ... (trimmed to 64 characters). */
const uniqueNames = (modules: readonly McpCatalogModule[]): McpCatalogModule[] => {
  const used = new Set<string>();
  const claim = (name: string): string => {
    let candidate = name;
    let suffixNumber = 2;
    while (used.has(candidate)) {
      const suffix = `_${suffixNumber}`;
      candidate = `${name.slice(0, 64 - suffix.length)}${suffix}`;
      suffixNumber += 1;
    }
    used.add(candidate);
    return candidate;
  };
  return modules.map((module) => ({
    ...module,
    tools: module.tools.map((tool) => ({ ...tool, name: claim(tool.name) })),
  }));
};

type ComposedModule = ApplicationComposition['modules'][number];
interface ComposedRevision {
  readonly modules: readonly ComposedModule[];
  readonly revision: string;
}

/** The MCP contributions of a composition, from the contracts alone (no tool is loaded). */
export const buildMcpModules = (composition: ComposedRevision): McpModules => {
  const warnings: string[] = [];
  const modules = composition.modules
    .flatMap((module): McpModule[] => {
      const decoded = decodeContractMcp(module.contractDocument);
      if (Option.isNone(decoded)) {
        warnings.push(`${module.moduleId}: MCP contribution is invalid`);
        return [];
      }
      const contribution = decoded.value.manifest.publicSurface.mcp;
      if (contribution === undefined) {
        return [];
      }
      return [
        {
          agentAdministrationPage: contribution.agentAdministrationPage,
          appId: module.deployment.appId,
          approvalReview: contribution.approvalReview,
          approvals: contribution.approvals,
          approvalsPage: contribution.approvalsPage,
          commandFieldLabels: contribution.commandFieldLabels ?? {},
          description: contribution.description,
          keywords: contribution.keywords,
          label: contribution.label,
          moduleId: module.moduleId,
          ownProposalEngine: contribution.ownProposalEngine === true,
          page: contribution.page,
          recordLinks: contribution.recordLinks,
          revision: contribution.revision,
          toolCatalog: contribution.toolCatalog,
        },
      ];
    })
    .toSorted((left, right) => left.moduleId.localeCompare(right.moduleId));
  return { compositionRevision: composition.revision, modules, warnings };
};

/** Build the small module directory from the request's admitted composition; tool releases have their own cache. */
export const mcpModulesOf = (composition: ComposedRevision): McpModules => buildMcpModules(composition);

/**
 * The complete catalog from the contributions and the tool catalogs loaded for them (by module id); `unavailable`
 * names why a module's tools could not be loaded.
 */
export const buildMcpCatalog = (
  directory: McpModules,
  loaded: {
    readonly toolCatalogs: ReadonlyMap<string, OntosMcpToolCatalog>;
    readonly unavailable?: ReadonlyMap<string, string>;
  },
): McpCatalog => {
  const { toolCatalogs, unavailable = new Map<string, string>() } = loaded;
  const warnings = [...directory.warnings];
  const modules = directory.modules.flatMap((module): McpCatalogModule[] => {
    const toolCatalog = toolCatalogs.get(module.moduleId);
    if (toolCatalog === undefined) {
      warnings.push(
        `${module.moduleId}: MCP tools are unavailable (${unavailable.get(module.moduleId) ?? 'not loaded'})`,
      );
      return [];
    }
    return [
      {
        ...module,
        tools: toolCatalog.tools.map((tool) => ({
          ...tool,
          appId: module.appId,
          inputSchema: selfContainedSchema(tool.inputSchema, toolCatalog.definitions),
          moduleId: module.moduleId,
        })),
      },
    ];
  });
  return { compositionRevision: directory.compositionRevision, modules: uniqueNames(modules), warnings };
};

class McpToolCatalogUnavailable extends Data.TaggedError('McpToolCatalogUnavailable')<{
  readonly cause?: unknown;
  readonly reason: string;
}> {}

const TOOL_CATALOG_TIMEOUT = Duration.seconds(10);
const hex = (digest: ArrayBuffer) =>
  [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');

/** Reads one module's tool catalog from its approved release and admits it only with the digest its contract pins. */
const fetchToolCatalog = Effect.fn('Mcp.fetchToolCatalog')(
  function* fetchToolCatalog(module: McpModule, release: ComposedModule) {
    const response = yield* moduleReleaseFetch(
      new Request(new URL(module.toolCatalog.path, 'https://module-release.invalid')),
      release,
    ).pipe(
      Effect.catchTags({
        ModuleReleaseIdentityError: (cause) =>
          Effect.fail(new McpToolCatalogUnavailable({ cause, reason: 'release identity is invalid' })),
        ModuleReleaseTransportError: (cause) =>
          Effect.fail(new McpToolCatalogUnavailable({ cause, reason: cause.reason })),
      }),
    );
    if (!response.ok) {
      return yield* new McpToolCatalogUnavailable({ reason: `release answered ${response.status}` });
    }
    const text = yield* Effect.tryPromise({
      catch: (cause) => new McpToolCatalogUnavailable({ cause, reason: 'release answer could not be read' }),
      try: (): PromiseLike<string> => response.text(),
    });
    const digest = yield* Effect.tryPromise({
      catch: (cause) => new McpToolCatalogUnavailable({ cause, reason: 'digest could not be computed' }),
      try: (): PromiseLike<ArrayBuffer> => globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)),
    });
    if (hex(digest) !== module.toolCatalog.sha256) {
      return yield* new McpToolCatalogUnavailable({ reason: 'artifact does not match the pinned digest' });
    }
    return yield* Schema.decodeEffect(OntosMcpToolCatalogJsonSchema, { onExcessProperty: 'error' })(text).pipe(
      Effect.mapError((cause) => new McpToolCatalogUnavailable({ cause, reason: 'artifact is invalid' })),
    );
  },
  Effect.timeoutOrElse({
    duration: TOOL_CATALOG_TIMEOUT,
    orElse: () => Effect.fail(new McpToolCatalogUnavailable({ reason: 'release timed out' })),
  }),
);

// Verified tool catalogs by digest and the last complete catalog: immutable values only, never request-owned I/O
// or failures (a Worker builds a new scoped runtime for each request).
const toolCatalogsByDigest = Ref.makeUnsafe<ReadonlyMap<string, OntosMcpToolCatalog>>(new Map());
const completeCatalog = Ref.makeUnsafe<McpCatalog | null>(null);

/**
 * The complete MCP catalog of a composition revision. Tools are loaded once per digest per isolate; a module whose
 * tools cannot be loaded is left out with a warning and asked again on the next request.
 */
export const loadMcpCatalog = Effect.fn('Mcp.loadCatalog')(function* loadMcpCatalog(composition: ComposedRevision) {
  const cached = yield* Ref.get(completeCatalog);
  if (cached?.compositionRevision === composition.revision) {
    return cached;
  }
  const directory = mcpModulesOf(composition);
  const releases = new Map(composition.modules.map((module) => [module.moduleId, module]));
  const known = yield* Ref.get(toolCatalogsByDigest);
  const loaded = yield* Effect.forEach(
    directory.modules,
    (module) => {
      const verified = known.get(module.toolCatalog.sha256);
      const release = releases.get(module.moduleId);
      let load: Effect.Effect<OntosMcpToolCatalog, McpToolCatalogUnavailable> = Effect.fail(
        new McpToolCatalogUnavailable({ reason: 'module is not composed' }),
      );
      if (verified !== undefined) {
        load = Effect.succeed(verified);
      } else if (release !== undefined) {
        load = fetchToolCatalog(module, release);
      }
      return load.pipe(
        Effect.map((toolCatalog) => ({ module, toolCatalog })),
        Effect.tapError((error) =>
          Effect.logWarning(`MCP tools of ${module.moduleId} are unavailable: ${error.reason}`),
        ),
        Effect.result,
      );
    },
    { concurrency: 8 },
  );
  const available = loaded.flatMap((entry) => (Result.isSuccess(entry) ? [entry.success] : []));
  const unavailable = new Map(
    loaded.flatMap((entry, index) =>
      Result.isFailure(entry) ? [[directory.modules[index]?.moduleId ?? '', entry.failure.reason] as const] : [],
    ),
  );
  // Keep only the digests of this revision, so retired releases do not accumulate in a long-lived isolate.
  yield* Ref.set(
    toolCatalogsByDigest,
    new Map(available.map(({ module, toolCatalog }) => [module.toolCatalog.sha256, toolCatalog])),
  );
  const catalog = buildMcpCatalog(directory, {
    toolCatalogs: new Map(available.map(({ module, toolCatalog }) => [module.moduleId, toolCatalog])),
    unavailable,
  });
  if (available.length === directory.modules.length) {
    yield* Ref.set(completeCatalog, catalog);
  }
  return catalog;
});

export const findTool = (catalog: McpCatalog, idOrName: string): McpCatalogTool | undefined => {
  for (const module of catalog.modules) {
    const tool = module.tools.find((candidate) => candidate.id === idOrName || candidate.name === idOrName);
    if (tool !== undefined) {
      return tool;
    }
  }
  return undefined;
};

export const findModule = (catalog: McpCatalog, moduleId: string): McpCatalogModule | undefined =>
  catalog.modules.find((module) => module.moduleId === moduleId);
