/**
 * The modules of the active composition as the approval platform sees them: label, whether they accept proposals,
 * whether they keep their own AI change engine, and how their command revision is read. Everything comes from the
 * modules' own MCP contributions; the platform names no module.
 */
import { Effect, Match, Schema } from 'effect';

import { mcpModulesOf } from '../mcp/catalog.ts';
import type { McpModule, McpModules } from '../mcp/catalog.ts';
import { ShellInstalledModuleCatalog } from '../modules/installed-module-catalog.ts';
import { AgentStoreUnavailable } from './proposal-store.ts';

export interface ComposedModules {
  readonly all: readonly McpModule[];
  readonly byAppId: (appId: string) => McpModule | undefined;
  readonly byModuleId: (moduleId: string) => McpModule | undefined;
  /** Czech label of a module key; the key itself when the module is not composed; `Platforma` for none. */
  readonly labelOf: (moduleKey: string | null | undefined) => string;
}

export const composedModulesOf = (catalog: McpModules): ComposedModules => ({
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
  return composedModulesOf(mcpModulesOf(installed.composition));
});

/** Query of the module's revision read, `{}` when the module declares none. */
export const revisionQueryOf = (module?: McpModule): Schema.JsonObject => module?.revision?.query ?? {};

const isRecord = Schema.is(Schema.JsonObject);

/** The revision a command must carry, read from the module's revision read answer as its contribution says. */
export const commandRevisionFrom = (
  module: McpModule | undefined,
  body: Schema.Json | undefined,
  command: Schema.JsonObject,
): number | undefined => {
  const revision = module?.revision;
  const field =
    revision?.fieldsByCommandPrefix.find((entry) =>
      Match.value(command['_tag']).pipe(
        Match.when(Match.string, (value) => value.startsWith(entry.prefix)),
        Match.orElse(() => false),
      ),
    )?.field ??
    revision?.field ??
    'revision';
  let current: Schema.Json | undefined = body;
  for (const segment of field.split('.')) {
    current = isRecord(current) ? current[segment] : undefined;
  }
  return Schema.is(Schema.Finite)(current) ? current : undefined;
};
