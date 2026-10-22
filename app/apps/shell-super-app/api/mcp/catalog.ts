/**
 * MCP tool catalog of the active Application Composition: the `publicSurface.mcp` contribution of every admitted
 * MicroVertical's deployment contract. The Shell knows no vertical, tool or schema; everything here comes from the
 * contracts, so a module that is not composed contributes nothing.
 */
import type { ApplicationComposition } from '@app/core-runtime';
import { OntosMcpContributionSchema } from '@app/core-runtime/modules/mcp-contribution';
import type { OntosMcpContribution, OntosMcpText, OntosMcpTool } from '@app/core-runtime/modules/mcp-contribution';
import { Option, Schema } from 'effect';

export type JsonObject = { readonly [key: string]: Schema.Json };

export interface McpCatalogTool extends Omit<OntosMcpTool, 'inputSchema'> {
  readonly appId: string;
  /** Self-contained JSON Schema (the referenced shared definitions are attached as `$defs`). */
  readonly inputSchema: JsonObject;
  readonly moduleId: string;
}

export interface McpCatalogModule {
  readonly appId: string;
  readonly approvals: boolean;
  readonly description: OntosMcpText;
  readonly keywords: string;
  readonly label: OntosMcpText;
  readonly moduleId: string;
  readonly page: string | undefined;
  readonly revision: OntosMcpContribution['revision'];
  readonly tools: readonly McpCatalogTool[];
}

export interface McpCatalog {
  readonly compositionRevision: string;
  readonly modules: readonly McpCatalogModule[];
  /** Contracts whose MCP contribution could not be read (module id and reason). */
  readonly warnings: readonly string[];
}

const ContractMcpSchema = Schema.Struct({
  manifest: Schema.Struct({
    publicSurface: Schema.Struct({ mcp: Schema.optionalKey(OntosMcpContributionSchema) }),
  }),
});
const decodeContractMcp = Schema.decodeUnknownOption(Schema.fromJsonString(ContractMcpSchema));

const isObject = (value: Schema.Json | undefined): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const REF = /^#\/\$defs\/(.+)$/u;

/** The tool schema plus exactly the shared definitions it references (transitively). */
export const selfContainedSchema = (schema: JsonObject, definitions: JsonObject): JsonObject => {
  const needed = new Map<string, Schema.Json>();
  const visit = (node: Schema.Json): void => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (!isObject(node)) {
      return;
    }
    const ref = node['$ref'];
    const name = typeof ref === 'string' ? REF.exec(ref)?.[1] : undefined;
    if (name !== undefined && !needed.has(name)) {
      const definition = definitions[name];
      if (definition !== undefined) {
        needed.set(name, definition);
        visit(definition);
      }
    }
    Object.values(node).forEach(visit);
  };
  visit(schema);
  return needed.size === 0 ? schema : { ...schema, $defs: Object.fromEntries(needed) };
};

/** Tool names stay unique across modules: repeats get `_2`, `_3`, ... (trimmed to 64 characters). */
const uniqueNames = (modules: readonly McpCatalogModule[]): McpCatalogModule[] => {
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
    tools: module.tools.map((tool) => ({ ...tool, name: claim(tool.name) })),
  }));
};

type ComposedModule = Pick<ApplicationComposition['modules'][number], 'contractDocument' | 'deployment' | 'moduleId'>;

export const buildMcpCatalog = (composition: {
  readonly modules: readonly ComposedModule[];
  readonly revision: string;
}): McpCatalog => {
  const warnings: string[] = [];
  const modules = composition.modules
    .flatMap((module): McpCatalogModule[] => {
      const decoded = decodeContractMcp(module.contractDocument);
      if (Option.isNone(decoded)) {
        warnings.push(`${module.moduleId}: MCP contribution is invalid`);
        return [];
      }
      const contribution = decoded.value.manifest.publicSurface.mcp;
      if (contribution === undefined) {
        return [];
      }
      const { appId } = module.deployment;
      return [
        {
          appId,
          approvals: contribution.approvals,
          description: contribution.description,
          keywords: contribution.keywords,
          label: contribution.label,
          moduleId: module.moduleId,
          page: contribution.page,
          revision: contribution.revision,
          tools: contribution.tools.map((tool) => ({
            ...tool,
            appId,
            inputSchema: selfContainedSchema(tool.inputSchema, contribution.definitions),
            moduleId: module.moduleId,
          })),
        },
      ];
    })
    .sort((left, right) => left.moduleId.localeCompare(right.moduleId));
  return { compositionRevision: composition.revision, modules: uniqueNames(modules), warnings };
};

let cached: McpCatalog | undefined;

/** One catalog per composition revision (contracts of a revision never change). */
export const mcpCatalogOf = (composition: Parameters<typeof buildMcpCatalog>[0]): McpCatalog => {
  if (cached?.compositionRevision !== composition.revision) {
    cached = buildMcpCatalog(composition);
  }
  return cached;
};

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
