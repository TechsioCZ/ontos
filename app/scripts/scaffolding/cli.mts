#!/usr/bin/env node
import { NodeServices } from '@effect/platform-node';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CodeSmith, FsMaterial, GeneratorCore } from '@modern-js/codesmith';
import type { GeneratorContext } from '@modern-js/codesmith';
import { Console, Effect, Option, Predicate, Schema } from 'effect';
import { Argument, CliConfig, Command, Flag, GlobalFlag } from 'effect/unstable/cli';
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process';
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
import resourceGenerator from './resource/scaffold.mts';
import retireContributionGenerator from './retire-contribution/scaffold.mts';
import searchProviderGenerator from './search-provider/scaffold.mts';
import searchProviderAccessGenerator from './search-provider-access/generator.mts';
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
  ResourceScaffoldConfig,
  ResourceScaffoldResult,
  RetireContributionScaffoldConfig,
  RetireContributionScaffoldResult,
  GovernedContributionScaffoldConfig,
  GovernedContributionScaffoldResult,
  SearchProviderAccessScaffoldConfig,
  SearchProviderAccessScaffoldResult,
} from './shared.mts';

const scaffoldCommandValues = [
  'action',
  'action-service',
  'external-http-adapter',
  'microvertical-action-boundary',
  'microvertical-page',
  'module-contract',
  'module-api',
  'outbox-message',
  'outbox-worker',
  'policy',
  'public-component',
  'report',
  'resource',
  'retire-contribution',
  'search-provider-access',
  'search-provider',
] as const;

const ACCESS_FILTERING_FLAG = 'access-filtering';
const LEGAL_ENTITY_SCOPE_FLAG = 'legal-entity-scope';
const REQUEST_FILTERS_FLAG = 'request-filters';
const TENANT_PERMISSION_FLAG = 'tenant-permission';

export const ScaffoldCommandSchema = Schema.Literals(scaffoldCommandValues);
export type ScaffoldCommand = typeof ScaffoldCommandSchema.Type;

export class ScaffoldingError extends Schema.TaggedError<ScaffoldingError>()('ScaffoldingError', {
  cause: Schema.optional(Schema.Defect()),
  message: Schema.String,
}) {}

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
  | PolicyScaffoldResult
  | ResourceScaffoldResult
  | RetireContributionScaffoldResult
  | SearchProviderAccessScaffoldResult;

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
  | PolicyScaffoldConfig
  | ResourceScaffoldConfig
  | RetireContributionScaffoldConfig
  | SearchProviderAccessScaffoldConfig;

type TypedGeneratorContext<Config> = Omit<GeneratorContext, 'config'> & {
  readonly config: Config;
};

type LocalGenerator<Config, Result extends GeneratorResult> = (
  context: TypedGeneratorContext<Config>,
  core: GeneratorCore,
) => Effect.Effect<Result, unknown, NodeServices.NodeServices>;

export interface RouteRefreshInput {
  readonly appId: string;
  readonly workspaceRoot: string;
}

export type RouteRefreshExecutor = (
  input: RouteRefreshInput,
) => Effect.Effect<void, ScaffoldingError>;

export interface RunScaffoldOptions {
  readonly routeRefresh?: RouteRefreshExecutor;
  readonly workspaceRoot?: string;
}

interface ParsedScaffoldFlags {
  readonly accessFiltering: string | undefined;
  readonly action: string | undefined;
  readonly authorizationMode: string | undefined;
  readonly kind: string | undefined;
  readonly legalEntityScope: string | undefined;
  readonly module: string | undefined;
  readonly name: string | undefined;
  readonly operation: string | undefined;
  readonly page: string | undefined;
  readonly permission: string | undefined;
  readonly policy: string | undefined;
  readonly producer: string | undefined;
  readonly provider: string | undefined;
  readonly provisioning: string | undefined;
  readonly requestFilters: string | undefined;
  readonly resource: string | undefined;
  readonly scope: string | undefined;
  readonly service: string | undefined;
  readonly tenantPermission: string | undefined;
  readonly topic: string | undefined;
  readonly url: string | undefined;
  readonly vertical: string | undefined;
  readonly worker: string | undefined;
}

interface CommandDefinition {
  readonly afterGenerate:
    | ((
        result: GeneratorResult,
        options: RunScaffoldOptions,
        workspaceRoot: string,
      ) => Effect.Effect<void, ScaffoldingError, ChildProcessSpawner.ChildProcessSpawner>)
    | undefined;
  readonly flags: readonly string[];
  readonly generate: (
    flags: ParsedScaffoldFlags,
    workspaceRoot: string,
  ) => Effect.Effect<GeneratorResult, ScaffoldingError, NodeServices.NodeServices>;
  readonly help: string;
  readonly requiredFlags: readonly string[];
}

interface CommandDefinitionInput<Config, Result extends GeneratorResult> {
  readonly afterGenerate?: (
    result: GeneratorResult,
    options: RunScaffoldOptions,
    workspaceRoot: string,
  ) => Effect.Effect<void, ScaffoldingError, ChildProcessSpawner.ChildProcessSpawner>;
  readonly flags: readonly string[];
  readonly generator: LocalGenerator<Config, Result>;
  readonly help: string;
  readonly requiredFlags: readonly string[];
  readonly toConfig: (flags: ParsedScaffoldFlags) => Effect.Effect<Config, ScaffoldingError>;
}

export type RunScaffoldResult =
  | { readonly help: string; readonly kind: 'help' }
  | { readonly kind: 'generated'; readonly result: GeneratorResult };

const failScaffolding = (
  message: string,
  cause?: unknown,
): Effect.Effect<never, ScaffoldingError> =>
  Effect.fail(new ScaffoldingError(cause === undefined ? { message } : { cause, message }));

const runCodesmithGenerator = Effect.fn('runCodesmithGenerator')(
  function* runCodesmithGeneratorEffect<
    Config extends GeneratorConfig,
    Result extends GeneratorResult,
  >(
    generator: LocalGenerator<Config, Result>,
    workspaceRoot: string,
    config: Config,
  ): Effect.fn.Return<Result, ScaffoldingError, NodeServices.NodeServices> {
    const prepared = yield* Effect.try({
      catch: (cause) =>
        new ScaffoldingError({ cause, message: 'failed to prepare the Codesmith generator' }),
      try: () => {
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
        const generatorContext = { ...core._context, config };
        return { core, generatorContext };
      },
    });
    const result = yield* generator(prepared.generatorContext, prepared.core).pipe(
      Effect.catchDefect((cause) =>
        Effect.fail(
          new ScaffoldingError({
            cause,
            message: Predicate.isError(cause) ? cause.message : 'Codesmith generation failed',
          }),
        ),
      ),
      Effect.mapError(
        (cause) =>
          new ScaffoldingError({
            cause,
            message: Predicate.isError(cause) ? cause.message : 'Codesmith generation failed',
          }),
      ),
      Effect.ensuring(Effect.sync(() => (prepared.core._context.current = null))),
    );
    return result;
  },
);

const defineCommand = <Config extends GeneratorConfig, Result extends GeneratorResult>(
  definition: CommandDefinitionInput<Config, Result>,
): CommandDefinition => ({
  afterGenerate: definition.afterGenerate,
  flags: definition.flags,
  generate: (flags, workspaceRoot) =>
    Effect.flatMap(definition.toConfig(flags), (config) =>
      runCodesmithGenerator(definition.generator, workspaceRoot, config),
    ),
  help: definition.help,
  requiredFlags: definition.requiredFlags,
});

const defaultRouteRefresh = ({ appId, workspaceRoot }: RouteRefreshInput) =>
  Effect.gen(function* defaultRouteRefreshEffect() {
    const script = path.join(workspaceRoot, 'scripts', 'generate-tanstack-routes.mts');
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const exitCode = yield* spawner
      .exitCode(
        ChildProcess.make(process.execPath, [script, '--app', appId], {
          cwd: workspaceRoot,
          stderr: 'inherit',
          stdin: 'inherit',
          stdout: 'inherit',
        }),
      )
      .pipe(
        Effect.mapError(
          (cause) => new ScaffoldingError({ cause, message: `route refresh failed for ${appId}` }),
        ),
      );
    if (exitCode !== ChildProcessSpawner.ExitCode(0)) {
      return yield* failScaffolding(`route refresh failed for ${appId}: exit ${exitCode}`);
    }
    return yield* Effect.void;
  });

const LegalEntityScope = Schema.Literals(['required', 'optional', 'forbidden']);
const isLegalEntityScope = Schema.is(LegalEntityScope);

const ReadAuthorization = Schema.Literals([
  'authenticated_principal',
  'context_permission',
  'public',
]);
const isReadAuthorization = Schema.is(ReadAuthorization);
const RequestFilter = Schema.Literals(['includeArchived', 'role']);
const isRequestFilter = Schema.is(RequestFilter);

const requireReadAuthorization = (
  flags: ParsedScaffoldFlags,
): Effect.Effect<
  Pick<GovernedContributionScaffoldConfig, 'authorization' | 'permission'>,
  ScaffoldingError
> =>
  Effect.gen(function* requireReadAuthorizationEffect() {
    if (!isReadAuthorization(flags.authorizationMode)) {
      return yield* failScaffolding(
        '--authorization must be public, authenticated_principal, or context_permission',
      );
    }
    if (flags.authorizationMode === 'context_permission') {
      if (flags.permission === undefined) {
        return yield* failScaffolding(
          '--permission is required for context_permission authorization',
        );
      }
      return { authorization: flags.authorizationMode, permission: flags.permission };
    }
    if (flags.permission !== undefined) {
      return yield* failScaffolding(
        '--permission is valid only for context_permission authorization',
      );
    }
    return { authorization: flags.authorizationMode };
  });

const commandDefinitions = {
  action: defineCommand({
    flags: [
      'action',
      'authorization',
      LEGAL_ENTITY_SCOPE_FLAG,
      'module',
      'provisioning',
      'scope',
      'vertical',
    ],
    generator: actionGenerator,
    help: `Usage:
  pnpm scaffold:action -- --vertical <vertical> --action <action> --legal-entity-scope <required|optional|forbidden> --authorization action_execution --provisioning <tenant_membership_default|explicit>
  pnpm scaffold:action -- --scope core --module <core.module> --action <action> --legal-entity-scope <required|optional|forbidden> --authorization action_execution --provisioning <tenant_membership_default|explicit>

Generate one typed, fail-closed Action registration with a governed write entrypoint.
MicroVertical Actions are tenant-scoped; Core Actions are explicitly system-scoped.

Required flags:
  --action <action>      Action name (lower-kebab-case)
  --legal-entity-scope   Required legal-entity behavior: required, optional, or forbidden
  --vertical <vertical>  Existing generated vertical folder; exclusive with Core ownership
  --scope core           Required only for Core ownership; forbidden with --vertical
  --module <core.module> Stable core.* module key; required only with --scope core
  --authorization       Must be action_execution
  --provisioning        tenant_membership_default or explicit

Options:
  --help                 Show this help without writing
`,
    requiredFlags: ['action', 'authorization', LEGAL_ENTITY_SCOPE_FLAG, 'provisioning'],
    toConfig: (flags) =>
      Effect.gen(function* actionConfigEffect() {
        const action = flags.action ?? '';
        const { legalEntityScope } = flags;
        if (!isLegalEntityScope(legalEntityScope)) {
          return yield* failScaffolding(
            '--legal-entity-scope must be required, optional, or forbidden',
          );
        }
        if (flags.authorizationMode !== 'action_execution') {
          return yield* failScaffolding('--authorization must be action_execution for Actions');
        }
        if (
          flags.provisioning !== 'tenant_membership_default' &&
          flags.provisioning !== 'explicit'
        ) {
          return yield* failScaffolding(
            '--provisioning must be tenant_membership_default or explicit',
          );
        }
        const { module, scope, vertical } = flags;
        if (vertical !== undefined) {
          if (scope !== undefined || module !== undefined) {
            return yield* failScaffolding(
              '--vertical is mutually exclusive with --scope and --module',
            );
          }
          return {
            action,
            authorization: 'action_execution',
            legalEntityScope,
            provisioning: flags.provisioning,
            vertical,
          };
        }
        if (scope !== 'core') {
          return yield* failScaffolding('--scope core is required when --vertical is not supplied');
        }
        if (module === undefined) {
          return yield* failScaffolding('--module is required for Core Action ownership');
        }
        return {
          action,
          authorization: 'action_execution',
          legalEntityScope,
          module,
          provisioning: flags.provisioning,
          scope,
        };
      }),
  }),
  'action-service': defineCommand({
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
    toConfig: (flags) =>
      Effect.succeed({
        service: flags.service ?? '',
        vertical: flags.vertical ?? '',
      }),
  }),
  'external-http-adapter': defineCommand({
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
    toConfig: (flags) =>
      Effect.succeed({
        operation: flags.operation ?? '',
        provider: flags.provider ?? '',
        vertical: flags.vertical ?? '',
      }),
  }),
  'microvertical-action-boundary': defineCommand({
    flags: ['vertical'],
    generator: actionBoundaryGenerator,
    help: `Usage: pnpm scaffold:microvertical-action-boundary -- --vertical <vertical>

Generate one Shell-user Action identity boundary and fail-closed assertion-redemption seam.

Required flags:
  --vertical <vertical>  Existing generated vertical folder (lower-kebab-case)

Options:
  --help                 Show this help without writing
`,
    requiredFlags: ['vertical'],
    toConfig: (flags) => Effect.succeed({ vertical: flags.vertical ?? '' }),
  }),
  'microvertical-page': defineCommand({
    afterGenerate: (result, options, workspaceRoot) =>
      Effect.gen(function* refreshGeneratedPagesEffect() {
        if (!('appId' in result) || !Predicate.isString(result.appId)) {
          return yield* failScaffolding('microvertical-page generator returned an invalid result');
        }
        const refresh = (input: RouteRefreshInput) => {
          if (options.routeRefresh === undefined) {
            return defaultRouteRefresh(input);
          }
          return options.routeRefresh(input);
        };
        yield* refresh({ appId: result.appId, workspaceRoot });
        yield* refresh({ appId: 'shell-super-app', workspaceRoot });
        return yield* Effect.void;
      }),
    flags: ['authorization', 'page', 'permission', 'url', 'vertical'],
    generator: microverticalPageGenerator,
    help: `Usage: pnpm scaffold:microvertical-page -- --vertical <vertical> --page <page> --authorization <public|authenticated_principal|context_permission> [--permission <permission>] [--url <url>]

Generate one localized, private-first page with a governed tenant page/read entrypoint.

Required flags:
  --vertical <vertical>  Existing generated vertical folder (lower-kebab-case)
  --page <page>          Stable page name (lower-kebab-case)
  --authorization       Explicit route authorization classification

Options:
  --url <url>            Root-relative canonical template of lowercase kebab segments and unique named :parameters; defaults to /<vertical>/<page>
  --permission <value>   Required only with context_permission
  --help                 Show this help without writing

Example:
  mise exec -- pnpm scaffold:microvertical-page -- --vertical contacts --page customer-edit --url /contacts/customers/:id/edit
`,
    requiredFlags: ['authorization', 'page', 'vertical'],
    toConfig: (flags) =>
      Effect.gen(function* pageConfigEffect() {
        const page = flags.page ?? '';
        const vertical = flags.vertical ?? '';
        const { url } = flags;
        const authorization = yield* requireReadAuthorization(flags);
        return url === undefined
          ? { ...authorization, page, vertical }
          : { ...authorization, page, url, vertical };
      }),
  }),
  'module-api': defineCommand({
    flags: ['authorization', 'name', 'permission', 'vertical'],
    generator: moduleApiGenerator,
    help: `Usage: pnpm scaffold:module-api -- --vertical <vertical> --name <name> --authorization <public|authenticated_principal|context_permission> [--permission <permission>]

Generate one typed owner-local module API contract and generated Effect client adapter.

Required flags:
  --vertical <vertical>  Existing generated vertical folder (lower-kebab-case)
  --name <name>          API name (lower-kebab-case)
  --authorization       Explicit API authorization classification
  --permission <value>  Required only with context_permission

Options:
  --help                 Show this help without writing
`,
    requiredFlags: ['authorization', 'name', 'vertical'],
    toConfig: (flags) =>
      Effect.gen(function* moduleApiConfigEffect() {
        const authorization = yield* requireReadAuthorization(flags);
        return {
          ...authorization,
          name: flags.name ?? '',
          vertical: flags.vertical ?? '',
        };
      }),
  }),
  'module-contract': defineCommand({
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
    toConfig: (flags) =>
      Effect.succeed({
        module: flags.module ?? '',
        vertical: flags.vertical ?? '',
      }),
  }),
  'outbox-message': defineCommand({
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
    toConfig: (flags) =>
      Effect.succeed({
        action: flags.action ?? '',
        topic: flags.topic ?? '',
        vertical: flags.vertical ?? '',
      }),
  }),
  'outbox-worker': defineCommand({
    flags: ['authorization', 'producer', 'topic', 'vertical', 'worker'],
    generator: outboxWorkerGenerator,
    help: `Usage: pnpm scaffold:outbox-worker -- --vertical <vertical> --worker <worker> --producer <producer> --topic <topic> --authorization owner_local_background

Generate one typed, owner-local Outbox Worker with a governed tenant worker/background entrypoint.

Required flags:
  --vertical <vertical>  Existing consumer vertical folder (lower-kebab-case)
  --worker <worker>      Worker name (lower-kebab-case)
  --producer <producer>  Existing producer vertical folder (lower-kebab-case)
  --topic <topic>        Exact published lowercase dot-separated topic
  --authorization       Must be owner_local_background

Options:
  --help                 Show this help without writing
`,
    requiredFlags: ['authorization', 'producer', 'topic', 'vertical', 'worker'],
    toConfig: (flags) =>
      Effect.gen(function* outboxWorkerConfigEffect() {
        if (flags.authorizationMode !== 'owner_local_background') {
          return yield* failScaffolding(
            '--authorization must be owner_local_background for Outbox Workers',
          );
        }
        return {
          authorization: 'owner_local_background',
          producer: flags.producer ?? '',
          topic: flags.topic ?? '',
          vertical: flags.vertical ?? '',
          worker: flags.worker ?? '',
        };
      }),
  }),
  policy: defineCommand({
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
    toConfig: (flags) =>
      Effect.gen(function* policyConfigEffect() {
        const { scope, vertical } = flags;
        if (scope !== 'global' && scope !== 'microvertical') {
          return yield* failScaffolding('--scope must be global or microvertical');
        }
        const policy = flags.policy ?? '';
        return vertical === undefined ? { policy, scope } : { policy, scope, vertical };
      }),
  }),
  'public-component': defineCommand({
    flags: ['authorization', 'name', 'permission', 'vertical'],
    generator: publicComponentGenerator,
    help: `Usage: pnpm scaffold:public-component -- --vertical <vertical> --name <name> --authorization <public|authenticated_principal|context_permission> [--permission <permission>]

Generate one owner-local public component with safe Shell contribution and lazy registration.

Required flags:
  --vertical <vertical>  Existing generated vertical folder (lower-kebab-case)
  --name <name>          Component name (lower-kebab-case)
  --authorization       Explicit authorization classification
  --permission <value>  Required only with context_permission

Options:
  --help                 Show this help without writing
`,
    requiredFlags: ['authorization', 'name', 'vertical'],
    toConfig: (flags) =>
      Effect.gen(function* publicComponentConfigEffect() {
        const authorization = yield* requireReadAuthorization(flags);
        return {
          ...authorization,
          name: flags.name ?? '',
          vertical: flags.vertical ?? '',
        };
      }),
  }),
  report: defineCommand({
    flags: ['authorization', 'name', 'permission', 'resource', 'vertical'],
    generator: reportGenerator,
    help: `Usage: pnpm scaffold:report -- --vertical <vertical> --name <name> --resource <resource> --authorization <authenticated_principal|context_permission> [--permission <permission>]

Generate one owner-local report provider with a generated Effect adapter and safe Shell binding.

Required flags:
  --vertical <vertical>  Existing generated vertical folder (lower-kebab-case)
  --name <name>          Report name (lower-kebab-case)
  --resource <resource>  Existing owner-local resource key (lower-kebab-case)
  --authorization       Explicit authorization classification
  --permission <value>  Required only with context_permission

Options:
  --help                 Show this help without writing
`,
    requiredFlags: ['authorization', 'name', 'resource', 'vertical'],
    toConfig: (flags) =>
      Effect.gen(function* reportConfigEffect() {
        const authorization = yield* requireReadAuthorization(flags);
        return {
          ...authorization,
          name: flags.name ?? '',
          resource: flags.resource ?? '',
          vertical: flags.vertical ?? '',
        };
      }),
  }),
  resource: defineCommand({
    flags: ['resource', 'vertical'],
    generator: resourceGenerator,
    help: `Usage: pnpm scaffold:resource -- --vertical <vertical> --resource <resource>

Generate one public Effect Schema-backed ResourceRef and register its conservative descriptor.

Required flags:
  --vertical <vertical>  Existing generated vertical folder (lower-kebab-case)
  --resource <resource>  Stable resource name (lower-kebab-case)

Options:
  --help                 Show this help without writing
`,
    requiredFlags: ['resource', 'vertical'],
    toConfig: (flags) =>
      Effect.succeed({
        resource: flags.resource ?? '',
        vertical: flags.vertical ?? '',
      }),
  }),
  'retire-contribution': defineCommand({
    flags: ['kind', 'name', 'vertical'],
    generator: retireContributionGenerator,
    help: `Usage: pnpm scaffold:retire-contribution -- --vertical <vertical> --kind <action|api|page> --name <name>

Retire one exact generated Action, module API, or page contribution atomically.

Required flags:
  --vertical <vertical>  Existing generated vertical folder (lower-kebab-case)
  --kind <action|api|page> Generated contribution category
  --name <name>          Stable contribution name (lower-kebab-case)

Options:
  --help                 Show this help without writing
`,
    requiredFlags: ['kind', 'name', 'vertical'],
    toConfig: (flags) =>
      Effect.gen(function* retireContributionConfigEffect() {
        const { kind } = flags;
        if (kind !== 'action' && kind !== 'api' && kind !== 'page') {
          return yield* failScaffolding('--kind must be action, api, or page');
        }
        return { kind, name: flags.name ?? '', vertical: flags.vertical ?? '' };
      }),
  }),
  'search-provider': defineCommand({
    flags: ['authorization', 'name', 'permission', 'resource', 'vertical'],
    generator: searchProviderGenerator,
    help: `Usage: pnpm scaffold:search-provider -- --vertical <vertical> --name <name> --resource <resource> --authorization <authenticated_principal|context_permission> [--permission <permission>]

Generate one owner-local search provider with a generated Effect adapter and safe Shell binding.

Required flags:
  --vertical <vertical>  Existing generated vertical folder (lower-kebab-case)
  --name <name>          Provider name (lower-kebab-case)
  --resource <resource>  Existing owner-local resource key (lower-kebab-case)
  --authorization       Explicit authorization classification
  --permission <value>  Required only with context_permission

Options:
  --help                 Show this help without writing
`,
    requiredFlags: ['authorization', 'name', 'resource', 'vertical'],
    toConfig: (flags) =>
      Effect.gen(function* searchProviderConfigEffect() {
        const authorization = yield* requireReadAuthorization(flags);
        return {
          ...authorization,
          name: flags.name ?? '',
          resource: flags.resource ?? '',
          vertical: flags.vertical ?? '',
        };
      }),
  }),
  'search-provider-access': defineCommand({
    flags: [
      ACCESS_FILTERING_FLAG,
      LEGAL_ENTITY_SCOPE_FLAG,
      'name',
      REQUEST_FILTERS_FLAG,
      TENANT_PERMISSION_FLAG,
      'vertical',
    ],
    generator: searchProviderAccessGenerator,
    help: `Usage: pnpm scaffold:search-provider-access -- --vertical <vertical> --name <name> --legal-entity-scope <required|optional> --access-filtering <resource_permission|tenant_scope> --request-filters <includeArchived[,role]> [--tenant-permission read_party_identity]

Safely update only Codesmith-owned access metadata and request filters for an existing search provider.

Required flags:
  --vertical <vertical>          Existing generated vertical folder (lower-kebab-case)
  --name <name>                  Existing generated provider name (lower-kebab-case)
  --legal-entity-scope <scope>   required or optional
  --access-filtering <mode>      resource_permission or tenant_scope
  --request-filters <filters>    Comma-separated includeArchived and role allowlist

Options:
  --tenant-permission read_party_identity  Required exactly for tenant_scope
  --help                                  Show this help without writing
`,
    requiredFlags: [
      ACCESS_FILTERING_FLAG,
      LEGAL_ENTITY_SCOPE_FLAG,
      'name',
      REQUEST_FILTERS_FLAG,
      'vertical',
    ],
    toConfig: (flags) =>
      Effect.gen(function* searchProviderAccessConfigEffect() {
        const { accessFiltering, legalEntityScope, tenantPermission } = flags;
        const filters = (flags.requestFilters ?? '').split(',').filter((value) => value !== '');
        if (accessFiltering !== 'resource_permission' && accessFiltering !== 'tenant_scope') {
          return yield* failScaffolding(
            '--access-filtering must be resource_permission or tenant_scope',
          );
        }
        if (legalEntityScope !== 'required' && legalEntityScope !== 'optional') {
          return yield* failScaffolding('--legal-entity-scope must be required or optional');
        }
        if (filters.some((filter) => filter !== 'includeArchived' && filter !== 'role')) {
          return yield* failScaffolding(
            '--request-filters may contain only includeArchived and role',
          );
        }
        if (tenantPermission !== undefined && tenantPermission !== 'read_party_identity') {
          return yield* failScaffolding('--tenant-permission must be read_party_identity');
        }
        const validatedFilters = filters.filter(isRequestFilter);
        const config: SearchProviderAccessScaffoldConfig = {
          accessFiltering,
          legalEntityScope,
          name: flags.name ?? '',
          requestFilters: validatedFilters,
          vertical: flags.vertical ?? '',
        };
        if (tenantPermission !== undefined) {
          return { ...config, tenantPermission };
        }
        return config;
      }),
  }),
} satisfies Readonly<Record<ScaffoldCommand, CommandDefinition>>;

export const isScaffoldCommand = Schema.is(ScaffoldCommandSchema);

export const getHelpText = (command: ScaffoldCommand): string => commandDefinitions[command].help;

const normalizeForwardedArguments = (argumentsList: readonly string[]): readonly string[] => {
  if (argumentsList[0] === '--') {
    return argumentsList.slice(1);
  }
  return argumentsList;
};

const parseFlags = (
  command: ScaffoldCommand,
  argumentsList: readonly string[],
): Effect.Effect<ParsedScaffoldFlags, ScaffoldingError> =>
  Effect.gen(function* parseFlagsEffect() {
    const definition = commandDefinitions[command];
    const allowed = new Set(definition.flags);
    const parsed = new Map<string, string>();
    for (let index = 0; index < argumentsList.length; index += 2) {
      const flag = argumentsList[index];
      const value = argumentsList[index + 1];
      if (flag === undefined || !flag.startsWith('--') || flag === '--' || flag.includes('=')) {
        return yield* failScaffolding(
          `invalid argument ${flag ?? '<missing>'}; use separate --flag value pairs`,
        );
      }
      const name = flag.slice(2);
      if (!allowed.has(name)) {
        return yield* failScaffolding(`unknown flag --${name} for scaffold:${command}`);
      }
      if (parsed.has(name)) {
        return yield* failScaffolding(`flag --${name} may be supplied only once`);
      }
      if (value === undefined || value.startsWith('--') || value.trim().length === 0) {
        return yield* failScaffolding(`flag --${name} requires one non-empty value`);
      }
      parsed.set(name, value);
    }
    for (const required of definition.requiredFlags) {
      if (!parsed.has(required)) {
        return yield* failScaffolding(`missing required flag --${required}`);
      }
    }
    return {
      accessFiltering: parsed.get(ACCESS_FILTERING_FLAG),
      action: parsed.get('action'),
      authorizationMode: parsed.get('authorization'),
      kind: parsed.get('kind'),
      legalEntityScope: parsed.get(LEGAL_ENTITY_SCOPE_FLAG),
      module: parsed.get('module'),
      name: parsed.get('name'),
      operation: parsed.get('operation'),
      page: parsed.get('page'),
      permission: parsed.get('permission'),
      policy: parsed.get('policy'),
      producer: parsed.get('producer'),
      provider: parsed.get('provider'),
      provisioning: parsed.get('provisioning'),
      requestFilters: parsed.get(REQUEST_FILTERS_FLAG),
      resource: parsed.get('resource'),
      scope: parsed.get('scope'),
      service: parsed.get('service'),
      tenantPermission: parsed.get(TENANT_PERMISSION_FLAG),
      topic: parsed.get('topic'),
      url: parsed.get('url'),
      vertical: parsed.get('vertical'),
      worker: parsed.get('worker'),
    };
  });

export const runScaffoldEffect = Effect.fn('runScaffold')(function* runScaffoldEffectGenerator(
  command: ScaffoldCommand,
  rawArguments: readonly string[],
  options: RunScaffoldOptions = {},
): Effect.fn.Return<RunScaffoldResult, ScaffoldingError, NodeServices.NodeServices> {
  const argumentsList = normalizeForwardedArguments(rawArguments);
  if (argumentsList.length === 1 && argumentsList[0] === '--help') {
    return { help: getHelpText(command), kind: 'help' };
  }
  const flags = yield* parseFlags(command, argumentsList);
  const workspaceRoot = path.resolve(options.workspaceRoot ?? process.cwd());
  const definition = commandDefinitions[command];
  const result = yield* definition.generate(flags, workspaceRoot);
  if (definition.afterGenerate !== undefined) {
    yield* definition.afterGenerate(result, options, workspaceRoot);
  }
  return { kind: 'generated', result };
});

const optionalTextFlag = (name: string) => Flag.string(name).pipe(Flag.optional);
const forwardedArguments = Argument.variadic(Argument.string('forwarded flags'));
const cliFlags = {
  accessFiltering: optionalTextFlag(ACCESS_FILTERING_FLAG),
  action: optionalTextFlag('action'),
  authorization: optionalTextFlag('authorization'),
  kind: optionalTextFlag('kind'),
  legalEntityScope: optionalTextFlag(LEGAL_ENTITY_SCOPE_FLAG),
  module: optionalTextFlag('module'),
  name: optionalTextFlag('name'),
  operation: optionalTextFlag('operation'),
  page: optionalTextFlag('page'),
  permission: optionalTextFlag('permission'),
  policy: optionalTextFlag('policy'),
  producer: optionalTextFlag('producer'),
  provider: optionalTextFlag('provider'),
  provisioning: optionalTextFlag('provisioning'),
  requestFilters: optionalTextFlag(REQUEST_FILTERS_FLAG),
  resource: optionalTextFlag('resource'),
  scope: optionalTextFlag('scope'),
  service: optionalTextFlag('service'),
  tenantPermission: optionalTextFlag(TENANT_PERMISSION_FLAG),
  topic: optionalTextFlag('topic'),
  url: optionalTextFlag('url'),
  vertical: optionalTextFlag('vertical'),
  worker: optionalTextFlag('worker'),
} as const;

const toCliArguments = (
  values: Readonly<Partial<Record<keyof typeof cliFlags, Option.Option<string>>>>,
): readonly string[] => {
  const entries: readonly (readonly [string, Option.Option<string> | undefined])[] = [
    [ACCESS_FILTERING_FLAG, values.accessFiltering],
    ['action', values.action],
    ['authorization', values.authorization],
    ['kind', values.kind],
    [LEGAL_ENTITY_SCOPE_FLAG, values.legalEntityScope],
    ['module', values.module],
    ['name', values.name],
    ['operation', values.operation],
    ['page', values.page],
    ['permission', values.permission],
    ['policy', values.policy],
    ['producer', values.producer],
    ['provider', values.provider],
    ['provisioning', values.provisioning],
    [REQUEST_FILTERS_FLAG, values.requestFilters],
    ['resource', values.resource],
    ['scope', values.scope],
    ['service', values.service],
    [TENANT_PERMISSION_FLAG, values.tenantPermission],
    ['topic', values.topic],
    ['url', values.url],
    ['vertical', values.vertical],
    ['worker', values.worker],
  ];
  return entries.flatMap(([name, value]) =>
    value !== undefined && Option.isSome(value) ? [`--${name}`, value.value] : [],
  );
};

const executeCliCommand =
  (command: ScaffoldCommand) =>
  (
    values: Readonly<Partial<Record<keyof typeof cliFlags, Option.Option<string>>>> & {
      readonly forwarded: readonly string[];
    },
  ) =>
    Effect.gen(function* executeCliCommandEffect() {
      const result = yield* runScaffoldEffect(command, [
        ...toCliArguments(values),
        ...values.forwarded,
      ]);
      if (result.kind === 'help') {
        yield* Console.log(result.help);
      }
    });

const cliSubcommands = [
  Command.make(
    scaffoldCommandValues[0],
    {
      action: cliFlags.action,
      authorization: cliFlags.authorization,
      forwarded: forwardedArguments,
      legalEntityScope: cliFlags.legalEntityScope,
      module: cliFlags.module,
      provisioning: cliFlags.provisioning,
      scope: cliFlags.scope,
      vertical: cliFlags.vertical,
    },
    executeCliCommand(scaffoldCommandValues[0]),
  ),
  Command.make(
    scaffoldCommandValues[1],
    { forwarded: forwardedArguments, service: cliFlags.service, vertical: cliFlags.vertical },
    executeCliCommand(scaffoldCommandValues[1]),
  ),
  Command.make(
    scaffoldCommandValues[2],
    {
      forwarded: forwardedArguments,
      operation: cliFlags.operation,
      provider: cliFlags.provider,
      vertical: cliFlags.vertical,
    },
    executeCliCommand(scaffoldCommandValues[2]),
  ),
  Command.make(
    scaffoldCommandValues[3],
    { forwarded: forwardedArguments, vertical: cliFlags.vertical },
    executeCliCommand(scaffoldCommandValues[3]),
  ),
  Command.make(
    scaffoldCommandValues[4],
    {
      authorization: cliFlags.authorization,
      forwarded: forwardedArguments,
      page: cliFlags.page,
      permission: cliFlags.permission,
      url: cliFlags.url,
      vertical: cliFlags.vertical,
    },
    executeCliCommand(scaffoldCommandValues[4]),
  ),
  Command.make(
    scaffoldCommandValues[5],
    { forwarded: forwardedArguments, module: cliFlags.module, vertical: cliFlags.vertical },
    executeCliCommand(scaffoldCommandValues[5]),
  ),
  Command.make(
    scaffoldCommandValues[6],
    {
      authorization: cliFlags.authorization,
      forwarded: forwardedArguments,
      name: cliFlags.name,
      permission: cliFlags.permission,
      vertical: cliFlags.vertical,
    },
    executeCliCommand(scaffoldCommandValues[6]),
  ),
  Command.make(
    scaffoldCommandValues[7],
    {
      action: cliFlags.action,
      forwarded: forwardedArguments,
      topic: cliFlags.topic,
      vertical: cliFlags.vertical,
    },
    executeCliCommand(scaffoldCommandValues[7]),
  ),
  Command.make(
    scaffoldCommandValues[8],
    {
      authorization: cliFlags.authorization,
      forwarded: forwardedArguments,
      producer: cliFlags.producer,
      topic: cliFlags.topic,
      vertical: cliFlags.vertical,
      worker: cliFlags.worker,
    },
    executeCliCommand(scaffoldCommandValues[8]),
  ),
  Command.make(
    scaffoldCommandValues[9],
    {
      forwarded: forwardedArguments,
      policy: cliFlags.policy,
      scope: cliFlags.scope,
      vertical: cliFlags.vertical,
    },
    executeCliCommand(scaffoldCommandValues[9]),
  ),
  Command.make(
    scaffoldCommandValues[10],
    {
      authorization: cliFlags.authorization,
      forwarded: forwardedArguments,
      name: cliFlags.name,
      permission: cliFlags.permission,
      vertical: cliFlags.vertical,
    },
    executeCliCommand(scaffoldCommandValues[10]),
  ),
  Command.make(
    scaffoldCommandValues[11],
    {
      authorization: cliFlags.authorization,
      forwarded: forwardedArguments,
      name: cliFlags.name,
      permission: cliFlags.permission,
      resource: cliFlags.resource,
      vertical: cliFlags.vertical,
    },
    executeCliCommand(scaffoldCommandValues[11]),
  ),
  Command.make(
    scaffoldCommandValues[12],
    { forwarded: forwardedArguments, resource: cliFlags.resource, vertical: cliFlags.vertical },
    executeCliCommand(scaffoldCommandValues[12]),
  ),
  Command.make(
    scaffoldCommandValues[13],
    {
      forwarded: forwardedArguments,
      kind: cliFlags.kind,
      name: cliFlags.name,
      vertical: cliFlags.vertical,
    },
    executeCliCommand(scaffoldCommandValues[13]),
  ),
  Command.make(
    scaffoldCommandValues[14],
    {
      accessFiltering: cliFlags.accessFiltering,
      forwarded: forwardedArguments,
      legalEntityScope: cliFlags.legalEntityScope,
      name: cliFlags.name,
      requestFilters: cliFlags.requestFilters,
      tenantPermission: cliFlags.tenantPermission,
      vertical: cliFlags.vertical,
    },
    executeCliCommand(scaffoldCommandValues[14]),
  ),
  Command.make(
    scaffoldCommandValues[15],
    {
      authorization: cliFlags.authorization,
      forwarded: forwardedArguments,
      name: cliFlags.name,
      permission: cliFlags.permission,
      resource: cliFlags.resource,
      vertical: cliFlags.vertical,
    },
    executeCliCommand(scaffoldCommandValues[15]),
  ),
] as const;

const cliRoot = Command.make('scaffold').pipe(Command.withSubcommands(cliSubcommands));

const customHelp = GlobalFlag.action({
  flag: Flag.boolean('help').pipe(Flag.withAlias('h')),
  run: (_enabled, { commandPath }) => {
    const command = commandPath.at(-1);
    return command !== undefined && isScaffoldCommand(command)
      ? Console.log(getHelpText(command))
      : Console.log(`Available scaffold commands:\n${scaffoldCommandValues.join('\n')}`);
  },
});

const [, entryPath] = process.argv;
if (entryPath !== undefined && import.meta.url === pathToFileURL(path.resolve(entryPath)).href) {
  const cliProgram = Effect.updateService(
    Effect.matchEffect(Command.run(cliRoot, { version: '0.1.0' }), {
      onFailure: (error) => Effect.logError(`Scaffold failed: ${String(error)}`),
      onSuccess: () => Effect.void,
    }),
    CliConfig.CliConfig,
    () => CliConfig.make({ builtIns: [customHelp] }),
  );
  await Effect.runPromise(cliProgram.pipe(Effect.provide(NodeServices.layer)));
}
