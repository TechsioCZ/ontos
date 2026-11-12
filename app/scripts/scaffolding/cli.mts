#!/usr/bin/env node
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { CodeSmith, FsMaterial, GeneratorCore } from '@modern-js/codesmith';
import type { GeneratorContext } from '@modern-js/codesmith';
import { Console, Effect, Layer, Option, Predicate, Schema } from 'effect';
import { Argument, CliConfig, Command, Flag, GlobalFlag } from 'effect/cli';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';
import actionHttpGenerator from './action-http/scaffold.mts';
import { actionHttpProposalGenerator } from './action-http/proposal.mts';
import actionServiceGenerator from './action-service/scaffold.mts';
import actionGenerator from './action/scaffold.mts';
import externalHttpAdapterGenerator from './external-http-adapter/scaffold.mts';
import actionBoundaryGenerator from './microvertical-action-boundary/scaffold.mts';
import microverticalPageGenerator from './microvertical-page/scaffold.mts';
import moduleApiGenerator from './module-api/scaffold.mts';
import moduleContractGenerator from './module-contract/scaffold.mts';
import outboxMessageGenerator from './outbox-message/scaffold.mts';
import outboxWorkerGenerator from './outbox-worker/scaffold.mts';
import policyGenerator from './policy/scaffold.mts';
import publicComponentGenerator from './public-component/scaffold.mts';
import reportGenerator from './report/scaffold.mts';
import resourceGenerator from './resource/scaffold.mts';
import retireContributionGenerator from './retire-contribution/scaffold.mts';
import searchProviderAccessGenerator from './search-provider-access/generator.mts';
import searchProviderGenerator from './search-provider/scaffold.mts';
import { ACCESS_DECLARATION_RISKS, ACCESS_DECLARATION_SELECTORS } from './shared.mts';
import type {
  AccessDeclarationRisk,
  AccessDeclarationSelector,
  ActionScaffoldConfig,
  ActionScaffoldResult,
  ActionHttpScaffoldConfig,
  ActionHttpScaffoldResult,
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
  CoreReadScaffoldConfig,
  GovernedContributionScaffoldResult,
  SearchProviderAccessScaffoldConfig,
  SearchProviderAccessScaffoldResult,
} from './shared.mts';

const MODULE_API_COMMAND = 'module-api';
const ACTION_HTTP_COMMAND = 'action-http';

const scaffoldCommandValues = [
  'action',
  ACTION_HTTP_COMMAND,
  'action-service',
  'external-http-adapter',
  'microvertical-action-boundary',
  'microvertical-page',
  'module-contract',
  MODULE_API_COMMAND,
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

const DOMAIN_PROBLEM_FLAG = 'domain-problem';
const SCHEMA_MODULE_FLAG = 'schema-module';
const RESULT_SCHEMA_FLAG = 'result-schema';
const LEGAL_ENTITY_SCOPE_FLAG = 'legal-entity-scope';
const REQUEST_FILTERS_FLAG = 'request-filters';
const ACCESS_RISK_FLAG = 'access-risk';
const ACCESS_SELECTORS_FLAG = 'access-selectors';
const ACCESS_WORKLOAD_FLAG = 'access-workload';
const ACCESS_WORKLOAD_KEYS_FLAG = 'access-workload-keys';
const PROPOSAL_ONLY_FLAG = 'proposal-only';

export const ScaffoldCommandSchema = Schema.Literals(scaffoldCommandValues);
export type ScaffoldCommand = typeof ScaffoldCommandSchema.Type;

export class ScaffoldingError extends Schema.TaggedError<ScaffoldingError>()('ScaffoldingError', {
  cause: Schema.optional(Schema.Defect()),
  message: Schema.String,
}) {}

type GeneratorResult =
  | ActionBoundaryScaffoldResult
  | ActionHttpScaffoldResult
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
  | ActionHttpScaffoldConfig
  | ActionScaffoldConfig
  | ActionServiceScaffoldConfig
  | ExternalHttpAdapterScaffoldConfig
  | ModuleContractScaffoldConfig
  | GovernedContributionScaffoldConfig
  | CoreReadScaffoldConfig
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

export type RouteRefreshExecutor = (input: RouteRefreshInput) => Effect.Effect<void, ScaffoldingError>;

export interface RunScaffoldOptions {
  readonly routeRefresh?: RouteRefreshExecutor;
  readonly workspaceRoot?: string;
}

interface ParsedScaffoldFlags {
  readonly accessRisk: string | undefined;
  readonly accessSelectors: string | undefined;
  readonly accessWorkload: string | undefined;
  readonly accessWorkloadKeys: string | undefined;
  readonly action: string | undefined;
  readonly authorizationMode: string | undefined;
  readonly core: boolean;
  readonly domainProblem: string | undefined;
  readonly kind: string | undefined;
  readonly legalEntityScope: string | undefined;
  readonly module: string | undefined;
  readonly name: string | undefined;
  readonly operation: string | undefined;
  readonly page: string | undefined;
  readonly policy: string | undefined;
  readonly producer: string | undefined;
  readonly proposalOnly: boolean;
  readonly provider: string | undefined;
  readonly requestFilters: string | undefined;
  readonly resource: string | undefined;
  readonly resultSchema: string | undefined;
  readonly schemaModule: string | undefined;
  readonly scope: string | undefined;
  readonly service: string | undefined;
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

const failScaffolding = (message: string, cause?: unknown): Effect.Effect<never, ScaffoldingError> =>
  Effect.fail(new ScaffoldingError(cause === undefined ? { message } : { cause, message }));

const runCodesmithGenerator = Effect.fn('runCodesmithGenerator')(function* runCodesmithGeneratorEffect<
  Config extends GeneratorConfig,
  Result extends GeneratorResult,
>(
  generator: LocalGenerator<Config, Result>,
  workspaceRoot: string,
  config: Config,
): Effect.fn.Return<Result, ScaffoldingError, NodeServices.NodeServices> {
  const prepared = yield* Effect.try({
    catch: (cause) =>
      new ScaffoldingError({
        cause,
        message: 'failed to prepare the Codesmith generator',
      }),
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
});

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

/**
 * `scaffold:action-http` selects its mode explicitly: the full scaffold stays the default for a fresh
 * endpoint, and `--proposal-only` runs the surgical proposal upgrade instead.
 */
const actionHttpGeneratorEntry: LocalGenerator<ActionHttpScaffoldConfig, ActionHttpScaffoldResult> = (context, core) =>
  context.config.proposalOnly === true
    ? actionHttpProposalGenerator(context, core)
    : actionHttpGenerator(context, core);

const defaultRouteRefresh = ({ appId, workspaceRoot }: RouteRefreshInput) =>
  Effect.gen(function* defaultRouteRefreshEffect() {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const exitCode = yield* spawner
      .exitCode(
        ChildProcess.make('pnpm', ['exec', 'ultramodern-create', 'ultramodern', 'routes-generate', '--app', appId], {
          cwd: workspaceRoot,
          shell: path.sep === '\\',
          stderr: 'inherit',
          stdin: 'inherit',
          stdout: 'inherit',
        }),
      )
      .pipe(
        Effect.mapError(
          (cause) =>
            new ScaffoldingError({
              cause,
              message: `route refresh failed for ${appId}`,
            }),
        ),
      );
    if (exitCode !== ChildProcessSpawner.ExitCode(0)) {
      return yield* failScaffolding(`route refresh failed for ${appId}: exit ${exitCode}`);
    }
    return yield* Effect.void;
  });

const LegalEntityScope = Schema.Literals(['required', 'optional', 'forbidden']);
const isLegalEntityScope = Schema.is(LegalEntityScope);

const ReadAuthorization = Schema.Literals(['authenticated_principal', 'protected', 'public']);
const isReadAuthorization = Schema.is(ReadAuthorization);
const RequestFilter = Schema.Literals(['includeArchived', 'role']);
const isRequestFilter = Schema.is(RequestFilter);
const isAccessRisk = Schema.is(Schema.Literals(ACCESS_DECLARATION_RISKS));
const isAccessSelector = Schema.is(Schema.Literals(ACCESS_DECLARATION_SELECTORS));

/** The access carrier flags a generated descriptor may carry; risk and selectors are optional. */
interface AccessCarrierFlags {
  readonly accessRisk?: AccessDeclarationRisk | undefined;
  readonly accessSelectors?: readonly AccessDeclarationSelector[] | undefined;
  readonly accessWorkload?: string | undefined;
  readonly accessWorkloadKeys?: readonly string[] | undefined;
}

/** The registered workload keys a generated marker admits (O73): comma-separated, never empty. */
const parseAccessWorkloadKeys = (
  value: string | undefined,
): Effect.Effect<Option.Option<readonly string[]>, ScaffoldingError> => {
  if (value === undefined) {
    return Effect.succeed(Option.none());
  }
  const keys = value
    .split(',')
    .map((key) => key.trim())
    .filter((key) => key.length > 0);
  return keys.length === 0
    ? Effect.fail(new ScaffoldingError({ message: '--access-workload-keys must name at least one workload key' }))
    : Effect.succeed(Option.some(keys));
};

const parseAccessSelectors = (
  value: string | undefined,
): Effect.Effect<Option.Option<readonly AccessDeclarationSelector[]>, ScaffoldingError> => {
  if (value === undefined) {
    return Effect.succeed(Option.none());
  }
  const selectors = value.split(',').map((selector) => selector.trim());
  if (selectors.length === 0 || selectors.some((selector) => selector.length === 0)) {
    return failScaffolding('--access-selectors must be a comma-separated list of record selectors');
  }
  if (!selectors.every(isAccessSelector)) {
    return failScaffolding(`--access-selectors may contain only ${ACCESS_DECLARATION_SELECTORS.join(', ')}`);
  }
  const parsed = selectors.filter(isAccessSelector);
  if (new Set(parsed).size !== parsed.length) {
    return failScaffolding('--access-selectors may not repeat a selector');
  }
  return Effect.succeed(Option.some(parsed));
};

const requireAccessRisk = (
  value: string | undefined,
): Effect.Effect<Option.Option<AccessDeclarationRisk>, ScaffoldingError> => {
  if (value === undefined) {
    return Effect.succeed(Option.none());
  }
  return isAccessRisk(value)
    ? Effect.succeed(Option.some(value))
    : failScaffolding(`--access-risk must be ${ACCESS_DECLARATION_RISKS.join(', ')}`);
};

const requireAccessCarrierFlags = (flags: ParsedScaffoldFlags): Effect.Effect<AccessCarrierFlags, ScaffoldingError> =>
  Effect.gen(function* requireAccessCarrierFlagsEffect() {
    const accessRisk = Option.getOrUndefined(yield* requireAccessRisk(flags.accessRisk));
    const accessSelectors = Option.getOrUndefined(yield* parseAccessSelectors(flags.accessSelectors));
    if (accessSelectors !== undefined || accessRisk !== undefined) {
      return accessSelectors === undefined ? { accessRisk } : { accessRisk, accessSelectors };
    }
    return {};
  });

const isRecordScopedRead = (command: ScaffoldCommand): boolean => command === MODULE_API_COMMAND;

/**
 * A generated read is either protected (and then carries its own `accessDeclaration`) or one of the
 * two unprotected classifications, which carry no access metadata at all (CUTOVER-PLAN §4.2).
 */
const requireReadAuthorization = (
  flags: ParsedScaffoldFlags,
  command: ScaffoldCommand,
): Effect.Effect<Pick<GovernedContributionScaffoldConfig, 'authorization'> & AccessCarrierFlags, ScaffoldingError> =>
  Effect.gen(function* requireReadAuthorizationEffect() {
    if (!isReadAuthorization(flags.authorizationMode)) {
      return yield* failScaffolding('--authorization must be public, authenticated_principal, or protected');
    }
    const authorization = flags.authorizationMode;
    const carrier = yield* requireAccessCarrierFlags(flags);
    if (authorization !== 'protected') {
      if (carrier.accessRisk !== undefined || carrier.accessSelectors !== undefined) {
        return yield* failScaffolding('--access-risk and --access-selectors require protected authorization');
      }
      return { authorization };
    }
    if (!isRecordScopedRead(command) && carrier.accessSelectors !== undefined) {
      return yield* failScaffolding(
        '--access-selectors require a single-record read: a list, search, report, page or component row is decided per row',
      );
    }
    return { authorization, ...carrier };
  });

const isSearchLegalEntityScope = Schema.is(Schema.Literals(['required', 'optional']));

const commandDefinitions = {
  action: defineCommand({
    flags: [
      ACCESS_RISK_FLAG,
      ACCESS_SELECTORS_FLAG,
      ACCESS_WORKLOAD_FLAG,
      ACCESS_WORKLOAD_KEYS_FLAG,
      'action',
      'authorization',
      LEGAL_ENTITY_SCOPE_FLAG,
      'module',
      'scope',
      'vertical',
    ],
    generator: actionGenerator,
    help: `Usage:
  pnpm scaffold:action -- --vertical <vertical> --action <action> --legal-entity-scope <required|optional|forbidden> --authorization protected [--access-risk <routine|sensitive|critical>] [--access-selectors <all|assigned|entrusted|team>[,...]] [--access-workload <reason>] [--access-workload-keys <key>[,...]]
  pnpm scaffold:action -- --scope core --module <core.module> --action <action> --legal-entity-scope <required|optional|forbidden> --authorization protected [--access-risk <routine|sensitive|critical>] [--access-selectors <all|assigned|entrusted|team>[,...]] [--access-workload <reason>] [--access-workload-keys <key>[,...]]

Generate one typed, fail-closed Action registration with a governed write entrypoint.
MicroVertical Actions are tenant-scoped; Core Actions are explicitly system-scoped.

Required flags:
  --action <action>      Action name (lower-kebab-case)
  --legal-entity-scope   Required legal-entity behavior: required, optional, or forbidden
  --vertical <vertical>  Existing generated vertical folder; exclusive with Core ownership
  --scope core           Required only for Core ownership; forbidden with --vertical
  --module <core.module> Stable core.* module key; required only with --scope core
  --authorization       Must be protected: every Action carries its own access carrier

Options:
  --access-risk <risk>   Declaration risk tier; defaults to sensitive
  --access-selectors <selectors>  Record slots the capability is granted on; defaults to none (scope-wide)
  --access-workload <reason>      Emit a trusted-workload marker instead of a human capability (O29/O59)
  --access-workload-keys <keys>   Registered workload keys the marker admits, comma-separated; required with --access-workload (O73)
  --help                 Show this help without writing
`,
    requiredFlags: ['action', 'authorization', LEGAL_ENTITY_SCOPE_FLAG],
    toConfig: (flags) =>
      Effect.gen(function* actionConfigEffect() {
        const action = flags.action ?? '';
        const { legalEntityScope } = flags;
        if (!isLegalEntityScope(legalEntityScope)) {
          return yield* failScaffolding('--legal-entity-scope must be required, optional, or forbidden');
        }
        if (flags.authorizationMode !== 'protected') {
          return yield* failScaffolding('--authorization must be protected for Actions');
        }
        const accessCarrier = yield* requireAccessCarrierFlags(flags);
        const { accessWorkload } = flags;
        if (
          accessWorkload !== undefined &&
          (accessCarrier.accessRisk !== undefined || accessCarrier.accessSelectors !== undefined)
        ) {
          return yield* failScaffolding('a workload Action declares no access risk or selectors');
        }
        const workloadKeys = Option.getOrUndefined(yield* parseAccessWorkloadKeys(flags.accessWorkloadKeys));
        if (accessWorkload !== undefined && workloadKeys === undefined) {
          return yield* failScaffolding('--access-workload requires --access-workload-keys (O73)');
        }
        const carrier: AccessCarrierFlags =
          accessWorkload === undefined ? accessCarrier : { accessWorkload, accessWorkloadKeys: workloadKeys };
        const { module, scope, vertical } = flags;
        if (vertical !== undefined) {
          if (scope !== undefined || module !== undefined) {
            return yield* failScaffolding('--vertical is mutually exclusive with --scope and --module');
          }
          return {
            action,
            authorization: 'protected' as const,
            legalEntityScope,
            ...carrier,
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
          authorization: 'protected' as const,
          legalEntityScope,
          module,
          ...carrier,
          scope,
        };
      }),
  }),
  'action-http': defineCommand({
    flags: ['action', PROPOSAL_ONLY_FLAG, 'vertical', SCHEMA_MODULE_FLAG, RESULT_SCHEMA_FLAG, DOMAIN_PROBLEM_FLAG],
    generator: actionHttpGeneratorEntry,
    help: `Usage: pnpm scaffold:action-http -- --vertical <vertical> --action <action> [--proposal-only]

Generate one explicit, typed public HTTP transport for an existing MicroVertical Action.

Required flags:
  --action <action>      Existing Action name (lower-kebab-case)
  --vertical <vertical>  Existing generated vertical folder (lower-kebab-case)

Options:
  --proposal-only        Upgrade only the parked-proposal transport of an existing endpoint: the 202
                         success entry, the trusted handler's success contract and the client intent.
                         Preserves owner error schemas, problem mappers, recovery text, custom server
                         header decoding, custom client composition and runtime argument positions.
                         Never rewrites problem mappers, barrels or package files, and leaves a
                         run-only or ephemeral Action unchanged.
  --domain-problem <Tag=shared/module.ts#Schema#Mapper> Preserve a typed domain Problem (repeatable)
  --schema-module <path> Adopt canonical schema exports from an owner shared/ module
  --result-schema <name> Result schema export (requires --schema-module)
  --help                 Show this help without writing
`,
    requiredFlags: ['action', 'vertical'],
    toConfig: (flags) =>
      Effect.gen(function* actionHttpConfigEffect() {
        const config = { action: flags.action ?? '', proposalOnly: flags.proposalOnly, vertical: flags.vertical ?? '' };
        if (flags.domainProblem !== undefined) {
          Object.assign(config, { domainProblems: flags.domainProblem.split(',') });
        }
        if (flags.schemaModule !== undefined) {
          Object.assign(config, { schemaModule: flags.schemaModule });
        }
        if (flags.resultSchema !== undefined) {
          Object.assign(config, { resultSchema: flags.resultSchema });
        }
        if (
          flags.proposalOnly &&
          (flags.domainProblem !== undefined || flags.schemaModule !== undefined || flags.resultSchema !== undefined)
        ) {
          return yield* failScaffolding(
            '--proposal-only upgrades only the parked-proposal transport and takes no --domain-problem, --schema-module or --result-schema',
          );
        }
        return config;
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
    afterGenerate: (result, options, workspaceRoot) => {
      const refresh = (input: RouteRefreshInput) => {
        if (options.routeRefresh === undefined) {
          return defaultRouteRefresh(input);
        }
        return options.routeRefresh(input);
      };
      return Effect.gen(function* refreshGeneratedPagesEffect() {
        if (!('appId' in result) || !Predicate.isString(result.appId)) {
          return yield* failScaffolding('microvertical-page generator returned an invalid result');
        }
        yield* refresh({ appId: result.appId, workspaceRoot });
        return yield* Effect.void;
      });
    },
    flags: [ACCESS_RISK_FLAG, ACCESS_SELECTORS_FLAG, 'authorization', 'page', 'url', 'vertical'],
    generator: microverticalPageGenerator,
    help: `Usage: pnpm scaffold:microvertical-page -- --vertical <vertical> --page <page> --authorization <public|authenticated_principal|protected> [--access-risk <routine|sensitive|critical>] [--url <url>]

Generate one localized, private-first page with a governed tenant page/read entrypoint.

Required flags:
  --vertical <vertical>  Existing generated vertical folder (lower-kebab-case)
  --page <page>          Stable page name (lower-kebab-case)
  --authorization       Explicit page authorization classification

Options:
  --url <url>            Root-relative canonical template of lowercase kebab segments and unique named :parameters; defaults to /<vertical>/<page>
  --access-risk <risk>   Declaration risk tier of a protected page; defaults to sensitive
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
        const authorization = yield* requireReadAuthorization(flags, 'microvertical-page');
        return url === undefined ? { ...authorization, page, vertical } : { ...authorization, page, url, vertical };
      }),
  }),
  [MODULE_API_COMMAND]: defineCommand({
    flags: [ACCESS_RISK_FLAG, ACCESS_SELECTORS_FLAG, 'authorization', 'core', 'module', 'name', 'vertical'],
    generator: moduleApiGenerator,
    help: `Usage: pnpm scaffold:module-api -- --vertical <vertical> --name <name> --authorization <public|authenticated_principal|protected> [--access-risk <routine|sensitive|critical>] [--access-selectors <all|assigned|entrusted|team>[,...]]
  pnpm scaffold:module-api -- --core --module <core.module> --name <name> --authorization <authenticated_principal|protected> [--access-risk <routine|sensitive|critical>] [--access-selectors <all|assigned|entrusted|team>[,...]]

Generate one typed owner-local module API contract and generated Effect client adapter.

Required flags:
  --vertical <vertical>  Existing generated vertical folder; required without --core
  --core                 Core-owned governed READ; exclusive with --vertical
  --module <core.module> Stable Core module key, required with --core
  --name <name>          API name (lower-kebab-case)
  --authorization       Explicit API authorization classification

Options:
  --access-risk <risk>            Declaration risk tier of a protected read; defaults to sensitive
  --access-selectors <selectors>  Record slots of a record-scoped read; adds the accessTarget scaffold
  --help                          Show this help without writing
`,
    requiredFlags: ['authorization', 'name'],
    toConfig: (flags) =>
      Effect.gen(function* moduleApiConfigEffect() {
        const authorization = yield* requireReadAuthorization(flags, MODULE_API_COMMAND);
        if (flags.core) {
          if (flags.vertical !== undefined || flags.module === undefined) {
            return yield* failScaffolding('--core requires --module and forbids --vertical');
          }
          return { ...authorization, core: true as const, module: flags.module, name: flags.name ?? '' };
        }
        if (flags.vertical === undefined || flags.module !== undefined) {
          return yield* failScaffolding('--vertical is required and --module is valid only with --core');
        }
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
    flags: ['action', 'module', 'scope', 'topic', 'vertical'],
    generator: outboxMessageGenerator,
    help: `Usage:
  pnpm scaffold:outbox-message -- --vertical <vertical> --action <action> --topic <topic>
  pnpm scaffold:outbox-message -- --scope core --module <core.module> --action <action> --topic <topic>

Generate one typed Outbox Message factory and schema owned by a generated Action.
MicroVertical messages are owned by a tenant-scoped Action; Core messages are owned by a system-scoped Action.

Required flags:
  --action <action>      Existing generated Action name (lower-kebab-case)
  --topic <topic>        Stable lowercase dot-separated topic
  --vertical <vertical>  Existing generated vertical folder (lower-kebab-case); exclusive with Core ownership
  --scope core           Required only for Core ownership; forbidden with --vertical
  --module <core.module> Stable core.* module key; required only with --scope core

Options:
  --help                 Show this help without writing
`,
    requiredFlags: ['action', 'topic'],
    toConfig: (flags) =>
      Effect.gen(function* outboxMessageConfigEffect() {
        const action = flags.action ?? '';
        const topic = flags.topic ?? '';
        const { module, scope, vertical } = flags;
        if (vertical !== undefined) {
          if (scope !== undefined || module !== undefined) {
            return yield* failScaffolding('--vertical is mutually exclusive with --scope and --module');
          }
          return { action, topic, vertical };
        }
        if (scope !== 'core') {
          return yield* failScaffolding('--scope core is required when --vertical is not supplied');
        }
        if (module === undefined) {
          return yield* failScaffolding('--module is required for Core Outbox Message ownership');
        }
        return { action, module, scope, topic };
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
          return yield* failScaffolding('--authorization must be owner_local_background for Outbox Workers');
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
    flags: [ACCESS_RISK_FLAG, ACCESS_SELECTORS_FLAG, 'authorization', 'name', 'vertical'],
    generator: publicComponentGenerator,
    help: `Usage: pnpm scaffold:public-component -- --vertical <vertical> --name <name> --authorization <public|authenticated_principal|protected> [--access-risk <routine|sensitive|critical>]

Generate one owner-local public component with safe Shell contribution and lazy registration.

Required flags:
  --vertical <vertical>  Existing generated vertical folder (lower-kebab-case)
  --name <name>          Component name (lower-kebab-case)
  --authorization       Explicit authorization classification

Options:
  --access-risk <risk>   Declaration risk tier of a protected component; defaults to sensitive
  --help                 Show this help without writing
`,
    requiredFlags: ['authorization', 'name', 'vertical'],
    toConfig: (flags) =>
      Effect.gen(function* publicComponentConfigEffect() {
        const authorization = yield* requireReadAuthorization(flags, 'public-component');
        return {
          ...authorization,
          name: flags.name ?? '',
          vertical: flags.vertical ?? '',
        };
      }),
  }),
  report: defineCommand({
    flags: [ACCESS_RISK_FLAG, ACCESS_SELECTORS_FLAG, 'authorization', 'name', 'resource', 'vertical'],
    generator: reportGenerator,
    help: `Usage: pnpm scaffold:report -- --vertical <vertical> --name <name> --resource <resource> --authorization <authenticated_principal|protected> [--access-risk <routine|sensitive|critical>]

Generate one owner-local report provider with a generated Effect adapter and safe Shell binding.

Required flags:
  --vertical <vertical>  Existing generated vertical folder (lower-kebab-case)
  --name <name>          Report name (lower-kebab-case)
  --resource <resource>  Existing owner-local resource key (lower-kebab-case)
  --authorization       Explicit authorization classification

Options:
  --access-risk <risk>   Declaration risk tier of a protected report; defaults to sensitive
  --help                 Show this help without writing
`,
    requiredFlags: ['authorization', 'name', 'resource', 'vertical'],
    toConfig: (flags) =>
      Effect.gen(function* reportConfigEffect() {
        const authorization = yield* requireReadAuthorization(flags, 'report');
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
  --vertical <vertical>  Existing generated vertical folder or core for Core-owned references
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
    flags: [ACCESS_RISK_FLAG, ACCESS_SELECTORS_FLAG, 'authorization', 'name', 'resource', 'vertical'],
    generator: searchProviderGenerator,
    help: `Usage: pnpm scaffold:search-provider -- --vertical <vertical> --name <name> --resource <resource> --authorization <authenticated_principal|protected> [--access-risk <routine|sensitive|critical>]

Generate one owner-local search provider with a generated Effect adapter and safe Shell binding.

Required flags:
  --vertical <vertical>  Existing generated vertical folder (lower-kebab-case)
  --name <name>          Provider name (lower-kebab-case)
  --resource <resource>  Existing owner-local resource key (lower-kebab-case)
  --authorization       Explicit authorization classification

Options:
  --access-risk <risk>   Declaration risk tier of a protected provider read; defaults to sensitive
  --help                 Show this help without writing
`,
    requiredFlags: ['authorization', 'name', 'resource', 'vertical'],
    toConfig: (flags) =>
      Effect.gen(function* searchProviderConfigEffect() {
        const authorization = yield* requireReadAuthorization(flags, 'search-provider');
        return {
          ...authorization,
          name: flags.name ?? '',
          resource: flags.resource ?? '',
          vertical: flags.vertical ?? '',
        };
      }),
  }),
  'search-provider-access': defineCommand({
    flags: [LEGAL_ENTITY_SCOPE_FLAG, 'name', REQUEST_FILTERS_FLAG, 'vertical'],
    generator: searchProviderAccessGenerator,
    help: `Usage: pnpm scaffold:search-provider-access -- --vertical <vertical> --name <name> --legal-entity-scope <required|optional> --request-filters <includeArchived[,role]>

Safely update only Codesmith-owned access metadata and request filters for an existing search provider.
The descriptor's accessKey is the declaration key of the provider's own governed search read.

Required flags:
  --vertical <vertical>          Existing generated vertical folder (lower-kebab-case)
  --name <name>                  Existing generated provider name (lower-kebab-case)
  --legal-entity-scope <scope>   required or optional
  --request-filters <filters>    Comma-separated includeArchived and role allowlist

Options:
  --help                         Show this help without writing
`,
    requiredFlags: [LEGAL_ENTITY_SCOPE_FLAG, 'name', REQUEST_FILTERS_FLAG, 'vertical'],
    toConfig: (flags) =>
      Effect.gen(function* searchProviderAccessConfigEffect() {
        const { legalEntityScope } = flags;
        const filters = (flags.requestFilters ?? '').split(',').filter((value) => value !== '');
        if (!isSearchLegalEntityScope(legalEntityScope)) {
          return yield* failScaffolding('--legal-entity-scope must be required or optional');
        }
        if (!filters.every(isRequestFilter)) {
          return yield* failScaffolding('--request-filters may contain only includeArchived and role');
        }
        const config: SearchProviderAccessScaffoldConfig = {
          legalEntityScope,
          name: flags.name ?? '',
          requestFilters: filters.filter(isRequestFilter),
          vertical: flags.vertical ?? '',
        };
        return config;
      }),
  }),
} satisfies Readonly<Record<ScaffoldCommand, CommandDefinition>>;

export const isScaffoldCommand = Schema.is(ScaffoldCommandSchema);

export const getHelpText = (command: ScaffoldCommand): string => commandDefinitions[command].help;

const isFlagArgument = (flag: string): boolean => flag.startsWith('--') && flag !== '--' && !flag.includes('=');

const parseFlagPair = (
  command: ScaffoldCommand,
  allowed: ReadonlySet<string>,
  parsed: Map<string, string>,
  flag: string | undefined,
  value: string | undefined,
) =>
  Effect.gen(function* parseFlagPairEffect() {
    if (flag === undefined || !isFlagArgument(flag)) {
      return yield* failScaffolding(`invalid argument ${flag ?? '<missing>'}; use separate --flag value pairs`);
    }
    const name = flag.slice(2);
    if (!allowed.has(name)) {
      return yield* failScaffolding(`unknown flag --${name} for scaffold:${command}`);
    }
    if (parsed.has(name) && !(command === 'action-http' && name === DOMAIN_PROBLEM_FLAG)) {
      return yield* failScaffolding(`flag --${name} may be supplied only once`);
    }
    if (value === undefined || value.startsWith('--') || value.trim().length === 0) {
      return yield* failScaffolding(`flag --${name} requires one non-empty value`);
    }
    const previous = parsed.get(name);
    parsed.set(name, name === DOMAIN_PROBLEM_FLAG && previous !== undefined ? `${previous},${value}` : value);
    return yield* Effect.void;
  });

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
    const coreCount = argumentsList.filter((argument) => argument === '--core').length;
    if (coreCount > 1) {
      return yield* failScaffolding('flag --core may be supplied only once');
    }
    const core = command === MODULE_API_COMMAND && coreCount === 1;
    const proposalOnlyCount = argumentsList.filter((argument) => argument === `--${PROPOSAL_ONLY_FLAG}`).length;
    if (proposalOnlyCount > 1) {
      return yield* failScaffolding(`flag --${PROPOSAL_ONLY_FLAG} may be supplied only once`);
    }
    const proposalOnly = command === ACTION_HTTP_COMMAND && proposalOnlyCount === 1;
    const booleanArguments = [core ? '--core' : undefined, proposalOnly ? `--${PROPOSAL_ONLY_FLAG}` : undefined].filter(
      (argument) => argument !== undefined,
    );
    const normalizedArguments =
      booleanArguments.length === 0
        ? argumentsList
        : argumentsList.filter((argument) => !booleanArguments.includes(argument));
    for (let index = 0; index < normalizedArguments.length; index += 2) {
      const flag = normalizedArguments[index];
      const value = normalizedArguments[index + 1];
      yield* parseFlagPair(command, allowed, parsed, flag, value);
    }
    for (const required of definition.requiredFlags) {
      if (!parsed.has(required)) {
        return yield* failScaffolding(`missing required flag --${required}`);
      }
    }
    return {
      accessRisk: parsed.get(ACCESS_RISK_FLAG),
      accessSelectors: parsed.get(ACCESS_SELECTORS_FLAG),
      accessWorkload: parsed.get(ACCESS_WORKLOAD_FLAG),
      accessWorkloadKeys: parsed.get(ACCESS_WORKLOAD_KEYS_FLAG),
      action: parsed.get('action'),
      authorizationMode: parsed.get('authorization'),
      core,
      domainProblem: parsed.get(DOMAIN_PROBLEM_FLAG),
      kind: parsed.get('kind'),
      legalEntityScope: parsed.get(LEGAL_ENTITY_SCOPE_FLAG),
      module: parsed.get('module'),
      name: parsed.get('name'),
      operation: parsed.get('operation'),
      page: parsed.get('page'),
      policy: parsed.get('policy'),
      producer: parsed.get('producer'),
      proposalOnly,
      provider: parsed.get('provider'),
      requestFilters: parsed.get(REQUEST_FILTERS_FLAG),
      resource: parsed.get('resource'),
      resultSchema: parsed.get(RESULT_SCHEMA_FLAG),
      schemaModule: parsed.get(SCHEMA_MODULE_FLAG),
      scope: parsed.get('scope'),
      service: parsed.get('service'),
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

const optionalTextFlag = (name: string) => Flag.String(name).pipe(Flag.optional);
const forwardedArguments = Argument.variadic(Argument.String('forwarded flags'));
const cliFlags = {
  accessRisk: optionalTextFlag(ACCESS_RISK_FLAG),
  accessSelectors: optionalTextFlag(ACCESS_SELECTORS_FLAG),
  accessWorkload: optionalTextFlag(ACCESS_WORKLOAD_FLAG),
  accessWorkloadKeys: optionalTextFlag(ACCESS_WORKLOAD_KEYS_FLAG),
  action: optionalTextFlag('action'),
  authorization: optionalTextFlag('authorization'),
  core: Flag.Boolean('core').pipe(Flag.withDefault(false)),
  domainProblem: Flag.String(DOMAIN_PROBLEM_FLAG).pipe(
    Flag.atLeast(0),
    Flag.map((values) => (values.length === 0 ? Option.none<string>() : Option.some(values.join(',')))),
  ),
  kind: optionalTextFlag('kind'),
  legalEntityScope: optionalTextFlag(LEGAL_ENTITY_SCOPE_FLAG),
  module: optionalTextFlag('module'),
  name: optionalTextFlag('name'),
  operation: optionalTextFlag('operation'),
  page: optionalTextFlag('page'),
  policy: optionalTextFlag('policy'),
  producer: optionalTextFlag('producer'),
  proposalOnly: Flag.Boolean(PROPOSAL_ONLY_FLAG).pipe(Flag.withDefault(false)),
  provider: optionalTextFlag('provider'),
  requestFilters: optionalTextFlag(REQUEST_FILTERS_FLAG),
  resource: optionalTextFlag('resource'),
  resultSchema: optionalTextFlag(RESULT_SCHEMA_FLAG),
  schemaModule: optionalTextFlag(SCHEMA_MODULE_FLAG),
  scope: optionalTextFlag('scope'),
  service: optionalTextFlag('service'),
  topic: optionalTextFlag('topic'),
  url: optionalTextFlag('url'),
  vertical: optionalTextFlag('vertical'),
  worker: optionalTextFlag('worker'),
} as const;

const cliFlagName = (key: string): string => key.replaceAll(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`);

const toCliArguments = (
  values: Readonly<Partial<Record<Exclude<keyof typeof cliFlags, 'core' | 'proposalOnly'>, Option.Option<string>>>> & {
    readonly core?: boolean;
    readonly proposalOnly?: boolean;
  },
): readonly string[] =>
  Object.entries(values).flatMap(([key, value]) => {
    if (key === 'core' || key === 'proposalOnly') {
      return value === true ? [`--${cliFlagName(key)}`] : [];
    }
    return value !== undefined && Option.isOption(value) && Option.isSome(value)
      ? [`--${cliFlagName(key)}`, value.value]
      : [];
  });

const executeCliCommand =
  (command: ScaffoldCommand) =>
  ({
    forwarded,
    ...values
  }: Readonly<Partial<Record<Exclude<keyof typeof cliFlags, 'core' | 'proposalOnly'>, Option.Option<string>>>> & {
    readonly core?: boolean;
    readonly forwarded: readonly string[];
    readonly proposalOnly?: boolean;
  }) =>
    Effect.gen(function* executeCliCommandEffect() {
      const result = yield* runScaffoldEffect(command, [...toCliArguments(values), ...forwarded]);
      if (result.kind === 'help') {
        yield* Console.log(result.help);
      }
    });

const cliSubcommands = scaffoldCommandValues.map((command) =>
  Command.make(
    command,
    {
      ...Object.fromEntries(
        Object.entries(cliFlags).filter(([key]) => commandDefinitions[command].flags.includes(cliFlagName(key))),
      ),
      forwarded: forwardedArguments,
    },
    executeCliCommand(command),
  ),
);

const cliRoot = Command.make('scaffold').pipe(Command.withSubcommands(cliSubcommands));

const customHelp = GlobalFlag.Action({
  flag: Flag.Boolean('help').pipe(Flag.withAlias('h')),
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
      onFailure: (error) =>
        Effect.logError(`Scaffold failed: ${String(error)}`).pipe(Effect.andThen(Effect.fail(error))),
      onSuccess: () => Effect.void,
    }),
    CliConfig.CliConfig,
    () => CliConfig.make({ builtIns: [customHelp] }),
  );
  const cliLayer = Layer.effectDiscard(cliProgram).pipe(Layer.provide(NodeServices.layer));
  NodeRuntime.runMain(Effect.scoped(Layer.build(cliLayer)), { disableErrorReporting: true });
}
