#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CodeSmith, FsMaterial, GeneratorCore } from '@modern-js/codesmith';
import type { GeneratorContext } from '@modern-js/codesmith';
import { Predicate } from 'effect';
import actionGenerator from './action/scaffold.mts';
import actionServiceGenerator from './action-service/scaffold.mts';
import externalHttpAdapterGenerator from './external-http-adapter/scaffold.mts';
import actionBoundaryGenerator from './microvertical-action-boundary/scaffold.mts';
import microverticalPageGenerator from './microvertical-page/scaffold.mts';
import moduleContractGenerator from './module-contract/scaffold.mts';
import outboxMessageGenerator from './outbox-message/scaffold.mts';
import outboxWorkerGenerator from './outbox-worker/scaffold.mts';
import policyGenerator from './policy/scaffold.mts';
import publicComponentGenerator from './public-component/scaffold.mts';
import moduleApiGenerator from './module-api/scaffold.mts';
import reportGenerator from './report/scaffold.mts';
import searchProviderGenerator from './search-provider/scaffold.mts';
import type {
  ActionScaffoldConfig,
  ActionScaffoldResult,
  ActionServiceScaffoldConfig,
  ActionServiceScaffoldResult,
  ExternalHttpAdapterScaffoldConfig,
  ExternalHttpAdapterScaffoldResult,
  ModuleContractScaffoldConfig,
  ModuleContractScaffoldResult,
  ActionBoundaryScaffoldConfig,
  ActionBoundaryScaffoldResult,
  OutboxScaffoldConfig,
  OutboxScaffoldResult,
  OutboxWorkerScaffoldConfig,
  OutboxWorkerScaffoldResult,
  PageScaffoldConfig,
  PageScaffoldResult,
  PolicyScaffoldConfig,
  PolicyScaffoldResult,
  GovernedContributionScaffoldConfig,
  GovernedContributionScaffoldResult,
} from './shared.mts';

export type ScaffoldCommand =
  | 'action'
  | 'action-service'
  | 'external-http-adapter'
  | 'microvertical-action-boundary'
  | 'microvertical-page'
  | 'module-contract'
  | 'module-api'
  | 'outbox-message'
  | 'outbox-worker'
  | 'policy'
  | 'public-component'
  | 'report'
  | 'search-provider';

type GeneratorResult =
  | ActionBoundaryScaffoldResult
  | ActionScaffoldResult
  | ActionServiceScaffoldResult
  | ExternalHttpAdapterScaffoldResult
  | ModuleContractScaffoldResult
  | GovernedContributionScaffoldResult
  | OutboxScaffoldResult
  | OutboxWorkerScaffoldResult
  | PageScaffoldResult
  | PolicyScaffoldResult;

type GeneratorConfig =
  | ActionBoundaryScaffoldConfig
  | ActionScaffoldConfig
  | ActionServiceScaffoldConfig
  | ExternalHttpAdapterScaffoldConfig
  | ModuleContractScaffoldConfig
  | GovernedContributionScaffoldConfig
  | OutboxScaffoldConfig
  | OutboxWorkerScaffoldConfig
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

interface ParsedScaffoldFlags {
  readonly action: string | undefined;
  readonly 'legal-entity-scope': string | undefined;
  readonly module: string | undefined;
  readonly name: string | undefined;
  readonly operation: string | undefined;
  readonly page: string | undefined;
  readonly policy: string | undefined;
  readonly producer: string | undefined;
  readonly provider: string | undefined;
  readonly resource: string | undefined;
  readonly scope: string | undefined;
  readonly service: string | undefined;
  readonly topic: string | undefined;
  readonly url: string | undefined;
  readonly vertical: string | undefined;
  readonly worker: string | undefined;
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
  readonly toConfig: (flags: ParsedScaffoldFlags) => GeneratorConfig;
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

const isLegalEntityScope = (
  value: string | undefined,
): value is ActionScaffoldConfig['legalEntityScope'] =>
  value === 'required' || value === 'optional' || value === 'forbidden';

// eslint-disable-next-line sort-keys -- Preserve the established user-facing command order.
const commandDefinitions = {
  action: {
    flags: ['action', 'legal-entity-scope', 'module', 'scope', 'vertical'],
    generator: actionGenerator,
    help: `Usage:
  pnpm scaffold:action -- --vertical <vertical> --action <action> --legal-entity-scope <required|optional|forbidden>
  pnpm scaffold:action -- --scope core --module <core.module> --action <action> --legal-entity-scope <required|optional|forbidden>

Generate one typed, fail-closed Action registration with a governed write entrypoint.
MicroVertical Actions are tenant-scoped; Core Actions are explicitly system-scoped.

Required flags:
  --action <action>      Action name (lower-kebab-case)
  --legal-entity-scope   Required legal-entity behavior: required, optional, or forbidden
  --vertical <vertical>  Existing generated vertical folder; exclusive with Core ownership
  --scope core           Required only for Core ownership; forbidden with --vertical
  --module <core.module> Stable core.* module key; required only with --scope core

Options:
  --help                 Show this help without writing
`,
    requiredFlags: ['action', 'legal-entity-scope'],
    toConfig: (flags) => {
      const action = flags['action'] ?? '';
      const legalEntityScope = flags['legal-entity-scope'];
      if (!isLegalEntityScope(legalEntityScope)) {
        throw new Error('--legal-entity-scope must be required, optional, or forbidden');
      }
      const { module, scope, vertical } = flags;
      if (vertical !== undefined) {
        if (scope !== undefined || module !== undefined) {
          throw new Error('--vertical is mutually exclusive with --scope and --module');
        }
        return {
          action,
          legalEntityScope,
          vertical,
        };
      }
      if (scope !== 'core') {
        throw new Error('--scope core is required when --vertical is not supplied');
      }
      if (module === undefined) {
        throw new Error('--module is required for Core Action ownership');
      }
      return {
        action,
        legalEntityScope,
        module,
        scope,
      };
    },
  },
  'action-service': {
    flags: ['service', 'vertical'],
    generator: actionServiceGenerator,
    help: `Usage: pnpm scaffold:action-service -- --vertical <vertical> --service <service>

Generate one owner-local Effect service used by generated Actions to access scoped persistence.

Required flags:
  --service <service>    Service name (lower-kebab-case)
  --vertical <vertical> Existing generated vertical folder (lower-kebab-case)

Options:
  --help                 Show this help without writing
`,
    requiredFlags: ['service', 'vertical'],
    toConfig: (flags) => ({
      service: flags['service'] ?? '',
      vertical: flags['vertical'] ?? '',
    }),
  },
  'external-http-adapter': {
    flags: ['operation', 'provider', 'vertical'],
    generator: externalHttpAdapterGenerator,
    help: `Usage: pnpm scaffold:external-http-adapter -- --vertical <vertical> --provider <provider> --operation <operation>

Generate one private, owner-local Effect HTTP adapter starting point without publishing it.

Required flags:
  --vertical <vertical>  Existing generated vertical folder (lower-kebab-case)
  --provider <provider>  External provider name (lower-kebab-case)
  --operation <operation> Adapter operation name (lower-kebab-case)

Options:
  --help                 Show this help without writing

Example:
  mise exec -- pnpm scaffold:external-http-adapter -- --vertical contacts --provider ares --operation subject
`,
    requiredFlags: ['operation', 'provider', 'vertical'],
    toConfig: (flags) => ({
      operation: flags['operation'] ?? '',
      provider: flags['provider'] ?? '',
      vertical: flags['vertical'] ?? '',
    }),
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
      if (!('appId' in result) || !Predicate.isString(result.appId)) {
        throw new Error('microvertical-page generator returned an invalid result');
      }
      const refresh = options.routeRefresh ?? defaultRouteRefresh;
      await refresh({ appId: result.appId, workspaceRoot });
      await refresh({ appId: 'shell-super-app', workspaceRoot });
    },
    flags: ['page', 'url', 'vertical'],
    generator: microverticalPageGenerator,
    help: `Usage: pnpm scaffold:microvertical-page -- --vertical <vertical> --page <page> [--url <url>]

Generate one localized, private-first page with a governed tenant page/read entrypoint.

Required flags:
  --vertical <vertical>  Existing generated vertical folder (lower-kebab-case)
  --page <page>          Stable page name (lower-kebab-case)

Options:
  --url <url>            Root-relative canonical template of lowercase kebab segments and unique named :parameters; defaults to /<vertical>/<page>
  --help                 Show this help without writing

Example:
  mise exec -- pnpm scaffold:microvertical-page -- --vertical contacts --page customer-edit --url /contacts/customers/:id/edit
`,
    requiredFlags: ['page', 'vertical'],
    toConfig: (flags) => {
      const page = flags['page'] ?? '';
      const vertical = flags['vertical'] ?? '';
      const { url } = flags;
      return url === undefined ? { page, vertical } : { page, url, vertical };
    },
  },
  'module-contract': {
    flags: ['module', 'vertical'],
    generator: moduleContractGenerator,
    help: `Usage: pnpm scaffold:module-contract -- --vertical <vertical> --module <dotted.module-id>

Generate the mandatory typed OntOS Module Manifest and private owner-local runtime registration.

Required flags:
  --vertical <vertical>       Existing generated vertical folder (lower-kebab-case)
  --module <dotted.module-id> Stable dotted non-core OntOS business module ID

Options:
  --help                      Show this help without writing
`,
    requiredFlags: ['module', 'vertical'],
    toConfig: (flags) => ({
      module: flags['module'] ?? '',
      vertical: flags['vertical'] ?? '',
    }),
  },
  'module-api': {
    flags: ['name', 'vertical'],
    generator: moduleApiGenerator,
    help: `Usage: pnpm scaffold:module-api -- --vertical <vertical> --name <name>

Generate one typed owner-local module API contract and generated Effect client adapter.

Required flags:
  --vertical <vertical>  Existing generated vertical folder (lower-kebab-case)
  --name <name>          API name (lower-kebab-case)

Options:
  --help                 Show this help without writing
`,
    requiredFlags: ['name', 'vertical'],
    toConfig: (flags) => ({ name: flags['name'] ?? '', vertical: flags['vertical'] ?? '' }),
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
  'outbox-worker': {
    flags: ['producer', 'topic', 'vertical', 'worker'],
    generator: outboxWorkerGenerator,
    help: `Usage: pnpm scaffold:outbox-worker -- --vertical <vertical> --worker <worker> --producer <producer> --topic <topic>

Generate one typed, owner-local Outbox Worker with a governed tenant worker/background entrypoint.

Required flags:
  --vertical <vertical>  Existing consumer vertical folder (lower-kebab-case)
  --worker <worker>      Worker name (lower-kebab-case)
  --producer <producer>  Existing producer vertical folder (lower-kebab-case)
  --topic <topic>        Exact published lowercase dot-separated topic

Options:
  --help                 Show this help without writing
`,
    requiredFlags: ['producer', 'topic', 'vertical', 'worker'],
    toConfig: (flags) => ({
      producer: flags['producer'] ?? '',
      topic: flags['topic'] ?? '',
      vertical: flags['vertical'] ?? '',
      worker: flags['worker'] ?? '',
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
      const policy = flags['policy'] ?? '';
      return vertical === undefined ? { policy, scope } : { policy, scope, vertical };
    },
  },
  'public-component': {
    flags: ['name', 'vertical'],
    generator: publicComponentGenerator,
    help: `Usage: pnpm scaffold:public-component -- --vertical <vertical> --name <name>

Generate one owner-local public component with safe Shell contribution and lazy registration.

Required flags:
  --vertical <vertical>  Existing generated vertical folder (lower-kebab-case)
  --name <name>          Component name (lower-kebab-case)

Options:
  --help                 Show this help without writing
`,
    requiredFlags: ['name', 'vertical'],
    toConfig: (flags) => ({ name: flags['name'] ?? '', vertical: flags['vertical'] ?? '' }),
  },
  report: {
    flags: ['name', 'resource', 'vertical'],
    generator: reportGenerator,
    help: `Usage: pnpm scaffold:report -- --vertical <vertical> --name <name> --resource <resource>

Generate one owner-local report provider with a generated Effect adapter and safe Shell binding.

Required flags:
  --vertical <vertical>  Existing generated vertical folder (lower-kebab-case)
  --name <name>          Report name (lower-kebab-case)
  --resource <resource>  Existing owner-local resource key (lower-kebab-case)

Options:
  --help                 Show this help without writing
`,
    requiredFlags: ['name', 'resource', 'vertical'],
    toConfig: (flags) => ({
      name: flags['name'] ?? '',
      resource: flags['resource'] ?? '',
      vertical: flags['vertical'] ?? '',
    }),
  },
  'search-provider': {
    flags: ['name', 'resource', 'vertical'],
    generator: searchProviderGenerator,
    help: `Usage: pnpm scaffold:search-provider -- --vertical <vertical> --name <name> --resource <resource>

Generate one owner-local search provider with a generated Effect adapter and safe Shell binding.

Required flags:
  --vertical <vertical>  Existing generated vertical folder (lower-kebab-case)
  --name <name>          Provider name (lower-kebab-case)
  --resource <resource>  Existing owner-local resource key (lower-kebab-case)

Options:
  --help                 Show this help without writing
`,
    requiredFlags: ['name', 'resource', 'vertical'],
    toConfig: (flags) => ({
      name: flags['name'] ?? '',
      resource: flags['resource'] ?? '',
      vertical: flags['vertical'] ?? '',
    }),
  },
} satisfies Readonly<Record<ScaffoldCommand, CommandDefinition>>;

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
): ParsedScaffoldFlags => {
  const definition = commandDefinitions[command];
  const allowed = new Set(definition.flags);
  const parsed = new Map<string, string>();
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
    if (parsed.has(name)) {
      throw new Error(`flag --${name} may be supplied only once`);
    }
    if (value === undefined || value.startsWith('--') || value.trim().length === 0) {
      throw new Error(`flag --${name} requires one non-empty value`);
    }
    parsed.set(name, value);
  }
  for (const required of definition.requiredFlags) {
    if (!parsed.has(required)) {
      throw new Error(`missing required flag --${required}`);
    }
  }
  return {
    action: parsed.get('action'),
    'legal-entity-scope': parsed.get('legal-entity-scope'),
    module: parsed.get('module'),
    name: parsed.get('name'),
    operation: parsed.get('operation'),
    page: parsed.get('page'),
    policy: parsed.get('policy'),
    producer: parsed.get('producer'),
    provider: parsed.get('provider'),
    resource: parsed.get('resource'),
    scope: parsed.get('scope'),
    service: parsed.get('service'),
    topic: parsed.get('topic'),
    url: parsed.get('url'),
    vertical: parsed.get('vertical'),
    worker: parsed.get('worker'),
  };
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

const errorMessage = <ErrorValue,>(error: ErrorValue): string =>
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
