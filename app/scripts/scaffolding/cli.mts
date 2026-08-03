#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CodeSmith, FsMaterial, GeneratorCore } from '@modern-js/codesmith';
import type { GeneratorContext } from '@modern-js/codesmith';
import actionGenerator from './action/scaffold.mts';
import actionBoundaryGenerator from './microvertical-action-boundary/scaffold.mts';
import microverticalPageGenerator from './microvertical-page/scaffold.mts';
import outboxMessageGenerator from './outbox-message/scaffold.mts';
import policyGenerator from './policy/scaffold.mts';
import type {
  ActionScaffoldConfig,
  ActionScaffoldResult,
  ActionBoundaryScaffoldConfig,
  ActionBoundaryScaffoldResult,
  OutboxScaffoldConfig,
  OutboxScaffoldResult,
  PageScaffoldConfig,
  PageScaffoldResult,
  PolicyScaffoldConfig,
  PolicyScaffoldResult,
} from './shared.mts';

export type ScaffoldCommand =
  | 'action'
  | 'microvertical-action-boundary'
  | 'microvertical-page'
  | 'outbox-message'
  | 'policy';

type GeneratorResult =
  | ActionBoundaryScaffoldResult
  | ActionScaffoldResult
  | OutboxScaffoldResult
  | PageScaffoldResult
  | PolicyScaffoldResult;

type GeneratorConfig =
  | ActionBoundaryScaffoldConfig
  | ActionScaffoldConfig
  | OutboxScaffoldConfig
  | PageScaffoldConfig
  | PolicyScaffoldConfig;

type LocalGenerator<Result extends GeneratorResult> = (
  context: GeneratorContext,
  core: GeneratorCore,
) => Promise<Result>;

export interface RouteRefreshInput {
  readonly appId: string;
  readonly workspaceRoot: string;
}

export type RouteRefreshExecutor = (input: RouteRefreshInput) => void | Promise<void>;

export interface RunScaffoldOptions {
  readonly routeRefresh?: RouteRefreshExecutor;
  readonly workspaceRoot?: string;
}

interface CommandDefinition {
  readonly afterGenerate?: (
    result: GeneratorResult,
    options: RunScaffoldOptions,
    workspaceRoot: string,
  ) => void | Promise<void>;
  readonly flags: readonly string[];
  readonly generator: LocalGenerator<GeneratorResult>;
  readonly help: string;
  readonly requiredFlags: readonly string[];
  readonly toConfig: (flags: Readonly<Record<string, string>>) => GeneratorConfig;
}

export type RunScaffoldResult =
  | { readonly help: string; readonly kind: 'help' }
  | { readonly kind: 'generated'; readonly result: GeneratorResult };

const defaultRouteRefresh: RouteRefreshExecutor = ({ appId, workspaceRoot }) => {
  const script = path.join(workspaceRoot, 'scripts', 'generate-tanstack-routes.mts');
  const result = spawnSync(process.execPath, [script, '--app', appId], {
    cwd: workspaceRoot,
    stdio: 'inherit',
  });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(
      `route refresh failed for ${appId}: ${result.error?.message ?? `exit ${result.status ?? 'unknown'}`}`,
    );
  }
};

const commandDefinitions: Readonly<Record<ScaffoldCommand, CommandDefinition>> = {
  action: {
    flags: ['action', 'module', 'scope', 'vertical'],
    generator: actionGenerator,
    help: `Usage:
  pnpm scaffold:action -- --vertical <vertical> --action <action>
  pnpm scaffold:action -- --scope core --module <core.module> --action <action>

Generate one typed, fail-closed Action registration for an existing MicroVertical or Core.

Required flags:
  --action <action>      Action name (lower-kebab-case)
  --vertical <vertical>  Existing generated vertical folder; exclusive with Core ownership
  --scope core           Required only for Core ownership; forbidden with --vertical
  --module <core.module> Stable core.* module key; required only with --scope core

Options:
  --help                 Show this help without writing
`,
    requiredFlags: ['action'],
    toConfig: (flags) => {
      const action = flags['action'] ?? '';
      const { module, scope, vertical } = flags;
      if (vertical !== undefined) {
        if (scope !== undefined || module !== undefined) {
          throw new Error('--vertical is mutually exclusive with --scope and --module');
        }
        return { action, vertical };
      }
      if (scope !== 'core') {
        throw new Error('--scope core is required when --vertical is not supplied');
      }
      if (module === undefined) {
        throw new Error('--module is required for Core Action ownership');
      }
      return { action, module, scope };
    },
  },
  'microvertical-action-boundary': {
    flags: ['vertical'],
    generator: actionBoundaryGenerator,
    help: `Usage: pnpm scaffold:microvertical-action-boundary -- --vertical <vertical>

Generate one Shell-user Action identity boundary in an existing MicroVertical.

Required flags:
  --vertical <vertical>  Existing generated vertical folder (lower-kebab-case)

Options:
  --help                 Show this help without writing
`,
    requiredFlags: ['vertical'],
    toConfig: (flags) => ({ vertical: flags['vertical'] ?? '' }),
  },
  'microvertical-page': {
    afterGenerate: async (result, options, workspaceRoot) => {
      const pageResult = result as PageScaffoldResult;
      await (options.routeRefresh ?? defaultRouteRefresh)({
        appId: pageResult.appId,
        workspaceRoot,
      });
    },
    flags: ['page', 'vertical'],
    generator: microverticalPageGenerator,
    help: `Usage: pnpm scaffold:microvertical-page -- --vertical <vertical> --page <page>

Generate one localized, private-first page in an existing MicroVertical.

Required flags:
  --vertical <vertical>  Existing generated vertical folder (lower-kebab-case)
  --page <page>          Page route segment (lower-kebab-case)

Options:
  --help                 Show this help without writing
`,
    requiredFlags: ['page', 'vertical'],
    toConfig: (flags) => ({ page: flags['page'] ?? '', vertical: flags['vertical'] ?? '' }),
  },
  'outbox-message': {
    flags: ['action', 'topic', 'vertical'],
    generator: outboxMessageGenerator,
    help: `Usage: pnpm scaffold:outbox-message -- --vertical <vertical> --action <action> --topic <topic>

Generate one typed Outbox Message factory owned by a generated Action.

Required flags:
  --vertical <vertical>  Existing generated vertical folder (lower-kebab-case)
  --action <action>      Existing generated Action name (lower-kebab-case)
  --topic <topic>        Stable lowercase dot-separated topic

Options:
  --help                 Show this help without writing
`,
    requiredFlags: ['action', 'topic', 'vertical'],
    toConfig: (flags) => ({
      action: flags['action'] ?? '',
      topic: flags['topic'] ?? '',
      vertical: flags['vertical'] ?? '',
    }),
  },
  policy: {
    flags: ['policy', 'scope', 'vertical'],
    generator: policyGenerator,
    help: `Usage:
  pnpm scaffold:policy -- --scope global --policy <policy>
  pnpm scaffold:policy -- --scope microvertical --policy <policy> --vertical <vertical>

Generate one typed, fail-closed global or owner-local Policy.

Required flags:
  --scope <scope>        global or microvertical
  --policy <policy>      Policy name (lower-kebab-case)
  --vertical <vertical>  Required only for microvertical scope; forbidden for global

Options:
  --help                 Show this help without writing
`,
    requiredFlags: ['policy', 'scope'],
    toConfig: (flags) => {
      const { scope, vertical } = flags;
      if (scope !== 'global' && scope !== 'microvertical') {
        throw new Error('--scope must be global or microvertical');
      }
      return {
        policy: flags['policy'] ?? '',
        scope,
        ...(vertical === undefined ? {} : { vertical }),
      };
    },
  },
};

export const isScaffoldCommand = (value: string): value is ScaffoldCommand =>
  Object.hasOwn(commandDefinitions, value);

export const getHelpText = (command: ScaffoldCommand): string => commandDefinitions[command].help;

const normalizeForwardedArguments = (arguments_: readonly string[]): readonly string[] => {
  if (arguments_[0] === '--') {
    return arguments_.slice(1);
  }
  return arguments_;
};

const parseFlags = (
  command: ScaffoldCommand,
  arguments_: readonly string[],
): Readonly<Record<string, string>> => {
  const definition = commandDefinitions[command];
  const allowed = new Set(definition.flags);
  const parsed: Record<string, string> = {};
  for (let index = 0; index < arguments_.length; index += 2) {
    const flag = arguments_[index];
    const value = arguments_[index + 1];
    if (flag === undefined || !flag.startsWith('--') || flag === '--' || flag.includes('=')) {
      throw new Error(`invalid argument ${flag ?? '<missing>'}; use separate --flag value pairs`);
    }
    const name = flag.slice(2);
    if (!allowed.has(name)) {
      throw new Error(`unknown flag --${name} for scaffold:${command}`);
    }
    if (parsed[name] !== undefined) {
      throw new Error(`flag --${name} may be supplied only once`);
    }
    if (value === undefined || value.startsWith('--') || value.trim().length === 0) {
      throw new Error(`flag --${name} requires one non-empty value`);
    }
    parsed[name] = value;
  }
  for (const required of definition.requiredFlags) {
    if (parsed[required] === undefined) {
      throw new Error(`missing required flag --${required}`);
    }
  }
  return parsed;
};

const runCodesmithGenerator = async (
  generator: LocalGenerator<GeneratorResult>,
  workspaceRoot: string,
  config: GeneratorConfig,
): Promise<GeneratorResult> => {
  const smith = new CodeSmith({ namespace: 'ontos-scaffolding' });
  const core = new GeneratorCore({
    logger: smith.logger,
    materialsManager: smith.materialsManager,
    outputPath: workspaceRoot,
  });
  const workspaceMaterial = new FsMaterial(workspaceRoot);
  const generatorMaterial = new FsMaterial(path.resolve(import.meta.dirname));
  core.addMaterial('default', workspaceMaterial);
  core.addMaterial('ontos-local-generator', generatorMaterial);
  core._context.config = config;
  core._context.current = { material: generatorMaterial };
  const result = await generator(core._context, core);
  core._context.current = null;
  return result;
};

export const runScaffold = async (
  command: ScaffoldCommand,
  rawArguments: readonly string[],
  options: RunScaffoldOptions = {},
): Promise<RunScaffoldResult> => {
  const arguments_ = normalizeForwardedArguments(rawArguments);
  if (arguments_.length === 1 && arguments_[0] === '--help') {
    return { help: getHelpText(command), kind: 'help' };
  }
  const flags = parseFlags(command, arguments_);
  const workspaceRoot = path.resolve(options.workspaceRoot ?? process.cwd());
  const definition = commandDefinitions[command];
  const result = await runCodesmithGenerator(
    definition.generator,
    workspaceRoot,
    definition.toConfig(flags),
  );
  await definition.afterGenerate?.(result, options, workspaceRoot);
  return { kind: 'generated', result };
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : 'Unknown scaffolding failure';

const [, entryPath, commandArgument] = process.argv;

const execute = async (): Promise<void> => {
  const command = commandArgument;
  if (command === undefined || !isScaffoldCommand(command)) {
    throw new Error(`unknown scaffold command ${command ?? '<missing>'}`);
  }
  const result = await runScaffold(command, process.argv.slice(3));
  if (result.kind === 'help') {
    console.log(result.help);
  }
};

if (entryPath !== undefined && import.meta.url === pathToFileURL(path.resolve(entryPath)).href) {
  try {
    await execute();
  } catch (error: unknown) {
    console.error(`Scaffold failed: ${errorMessage(error)}`);
    process.exitCode = 1;
  }
}
