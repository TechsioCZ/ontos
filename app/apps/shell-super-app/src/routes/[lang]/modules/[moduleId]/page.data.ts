import { Effect, Match, Predicate, Schema } from 'effect';
import type { Cause, Config } from 'effect';

import { ResolveModuleTargetPayloadSchema } from '../../../../../shared/api.ts';
import type { ResolvedModuleTarget } from '../../../../../shared/api.ts';
import { resolveModuleTarget } from '../../../../api/auth-client.ts';
import type { ShellTargetClientError } from '../../../../api/auth-client.ts';
import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import { shellAuthenticationClientOptionsFromRequest } from '../../../shell-authentication-client-options.ts';
import { loadHomePageModel } from '../../page.data.ts';
import type { HomePageModel } from '../../page.data.ts';

const withOptionalProperty = <
  Base extends object,
  Key extends PropertyKey,
  Value,
  Trailing extends object,
>(
  base: Base,
  condition: boolean,
  key: Key,
  value: Value,
  trailing: Trailing
) =>
  condition ? { ...base, [key]: value, ...trailing } : { ...base, ...trailing };

interface ModuleTargetLoaderArguments {
  readonly params: {
    readonly entrypointKey?: string;
    readonly moduleId: string;
  };
  readonly request: Request;
  readonly routeParams?: Readonly<Record<string, string>>;
}

const RouteParameterInputSchema = Schema.Record(
  Schema.String,
  Schema.Union([Schema.String, Schema.Undefined])
);
type RouteParameterInput = typeof RouteParameterInputSchema.Type;

export type ModulePageRouteParams = Readonly<Record<string, string>>;

const routeParameterNamePattern = /^[a-z][A-Za-z0-9]*$/u;
const routeParameterLimit = 64;
const routeParameterValueLengthLimit = 200;

export const selectRouteParams = (
  params: RouteParameterInput,
  declaredNames: readonly string[]
): ModulePageRouteParams =>
  Object.freeze(
    Object.fromEntries(
      declaredNames.slice(0, routeParameterLimit).flatMap((name) => {
        const value = params[name];
        return routeParameterNamePattern.test(name) &&
          Predicate.isString(value) &&
          value.length <= routeParameterValueLengthLimit
          ? [[name, value] as const]
          : [];
      })
    )
  );

export type ModuleTargetPageModel =
  | {
      readonly shell: HomePageModel;
      readonly state:
        | 'forbidden'
        | 'not_found'
        | 'selection_required'
        | 'unavailable';
    }
  | {
      readonly routeParams: ModulePageRouteParams;
      readonly shell: HomePageModel;
      readonly state: 'resolved';
      readonly target: ResolvedModuleTarget;
    };

const safeState = (
  error: Config.ConfigError | ShellTargetClientError,
  shell: HomePageModel
): ModuleTargetPageModel =>
  Match.value(error).pipe(
    Match.tag(
      'ShellAuthenticationRequiredProblem',
      'ShellSelectionRequiredProblem',
      () => ({
        shell,
        state: 'selection_required' as const,
      })
    ),
    Match.tag('ShellTargetForbiddenProblem', () => ({
      shell,
      state: 'forbidden' as const,
    })),
    Match.tag('ShellTargetNotFoundProblem', () => ({
      shell,
      state: 'not_found' as const,
    })),
    Match.tag(
      'ConfigError',
      'HttpClientError',
      'SchemaError',
      'ShellCapabilityUnavailableProblem',
      'ShellInternalProblem',
      'ShellInvalidRequestProblem',
      'ShellPolicyConflictProblem',
      'ShellPolicyUnprocessableProblem',
      'ShellPreconditionRequiredProblem',
      'ShellRateLimitedProblem',
      () => ({ shell, state: 'unavailable' as const })
    ),
    Match.exhaustive
  );

export const loadModulePageModel = ({
  params,
  request,
  routeParams = {},
}: ModuleTargetLoaderArguments): Effect.Effect<
  ModuleTargetPageModel,
  Cause.TimeoutError
> =>
  loadHomePageModel(request).pipe(
    Effect.timeout('30 seconds'),
    Effect.flatMap((shell) => {
      if (shell.state !== 'authenticated') {
        return Effect.succeed<ModuleTargetPageModel>({
          shell,
          state:
            shell.state === 'unavailable'
              ? 'unavailable'
              : 'selection_required',
        });
      }
      const boundedRouteParams = selectRouteParams(
        routeParams,
        Object.keys(routeParams)
      );
      return shellAuthenticationClientOptionsFromRequest(request).pipe(
        Effect.flatMap((options) =>
          Schema.decodeUnknownEffect(ResolveModuleTargetPayloadSchema)(
            withOptionalProperty(
              {},
              params.entrypointKey !== undefined,
              'entrypointKey',
              params.entrypointKey,
              { moduleId: params.moduleId }
            )
          ).pipe(
            Effect.flatMap((payload) => resolveModuleTarget(payload, options))
          )
        ),
        Effect.map((target): ModuleTargetPageModel => ({
          routeParams: boundedRouteParams,
          shell,
          state: 'resolved',
          target,
        })),
        Effect.matchEffect({
          onFailure: (error) => Effect.succeed(safeState(error, shell)),
          onSuccess: Effect.succeed,
        })
      );
    })
  );

export const loader = (
  input: ModuleTargetLoaderArguments
): Promise<ModuleTargetPageModel> =>
  browserRuntime.runPromise(loadModulePageModel(input), {
    signal: input.request.signal,
  });
