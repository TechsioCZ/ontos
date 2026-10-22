/**
 * The modules of the active composition as the approval platform sees them: label, whether they accept proposals,
 * whether they keep their own AI change engine, and how their command revision is read. Everything comes from the
 * modules' own MCP contributions; the platform names no module.
 */
import { Effect } from 'effect';

import { mcpCatalogOf } from '../mcp/catalog.ts';
import type { McpCatalog, McpCatalogModule } from '../mcp/catalog.ts';
import { ShellInstalledModuleCatalog } from '../modules/installed-module-catalog.ts';
import { AgentStoreUnavailable } from './proposal-store.ts';

export interface ComposedModules {
  readonly all: readonly McpCatalogModule[];
  readonly byAppId: (appId: string) => McpCatalogModule | undefined;
  readonly byModuleId: (moduleId: string) => McpCatalogModule | undefined;
  /** Czech label of a module key; the key itself when the module is not composed; `Platforma` for none. */
  readonly labelOf: (moduleKey: string | null | undefined) => string;
}

export const composedModulesOf = (catalog: McpCatalog): ComposedModules => ({
  all: catalog.modules,
  byAppId: (appId) => catalog.modules.find((module) => module.appId === appId),
  byModuleId: (moduleId) => catalog.modules.find((module) => module.moduleId === moduleId),
  labelOf: (moduleKey) =>
    moduleKey === null || moduleKey === undefined
      ? 'Platforma'
      : (catalog.modules.find((module) => module.moduleId === moduleKey)?.label.cs ?? moduleKey),
});

export const loadComposedModules = Effect.gen(function* loadComposedModulesEffect() {
  const installed = yield* (yield* ShellInstalledModuleCatalog).load.pipe(
    Effect.mapError((cause) => new AgentStoreUnavailable({ cause })),
  );
  return composedModulesOf(mcpCatalogOf(installed.composition));
});

/** Query of the module's revision read, `{}` when the module declares none. */
export const revisionQueryOf = (module: McpCatalogModule | undefined): Readonly<Record<string, unknown>> =>
  module?.revision?.query ?? {};

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The revision a command must carry, read from the module's revision read answer as its contribution says. */
export const commandRevisionFrom = (
  module: McpCatalogModule | undefined,
  body: unknown,
  command: Readonly<Record<string, unknown>>,
): number | undefined => {
  const revision = module?.revision;
  const tag = command['_tag'];
  const field =
    revision?.fieldsByCommandPrefix.find((entry) => typeof tag === 'string' && tag.startsWith(entry.prefix))?.field ??
    revision?.field ??
    'revision';
  let current: unknown = body;
  for (const segment of field.split('.')) {
    current = isRecord(current) ? current[segment] : undefined;
  }
  return typeof current === 'number' ? current : undefined;
};
