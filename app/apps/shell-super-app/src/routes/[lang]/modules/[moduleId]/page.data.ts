/* eslint-disable promise/prefer-await-to-callbacks, promise/prefer-await-to-then -- The loader preserves the typed Effect error channel until the framework boundary. */
import { Effect, Predicate } from 'effect';
import type { ResolvedModuleTarget } from '../../../../../shared/api.ts';
import { resolveModuleTarget, runEffectRequest } from '../../../../api/auth-client.ts';
import type { ShellTargetClientError } from '../../../../api/auth-client.ts';
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
  trailing: Trailing,
) => (condition ? { ...base, [key]: value, ...trailing } : { ...base, ...trailing });

interface ModuleTargetLoaderArguments {
  readonly params: { readonly entrypointKey?: string; readonly moduleId: string };
  readonly request: Request;
  readonly routeParams?: Readonly<Record<string, string>>;
}

export type ModulePageRouteParams = Readonly<Record<string, string>>;

const routeParameterNamePattern = /^[a-z][A-Za-z0-9]*$/u;
const routeParameterLimit = 64;
const routeParameterValueLengthLimit = 200;

export const selectRouteParams = (
  params: Readonly<Record<string, string | undefined>>,
  declaredNames: readonly string[],
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
      }),
    ),
  );

export type ModuleTargetPageModel =
  | {
      readonly shell: HomePageModel;
      readonly state: 'forbidden' | 'not_found' | 'selection_required' | 'unavailable';
    }
  | {
      readonly routeParams: ModulePageRouteParams;
      readonly shell: HomePageModel;
      readonly state: 'resolved';
      readonly target: ResolvedModuleTarget;
    };

const safeState = (error: ShellTargetClientError, shell: HomePageModel): ModuleTargetPageModel => {
  switch (error._tag) {
    case 'ShellAuthenticationRequiredProblem':
    case 'ShellSelectionRequiredProblem': {
      return { shell, state: 'selection_required' };
    }
    case 'ShellTargetForbiddenProblem': {
      return { shell, state: 'forbidden' };
    }
    case 'ShellTargetNotFoundProblem': {
      return { shell, state: 'not_found' };
    }
    case 'ShellCapabilityUnavailableProblem':
    case 'HttpClientError':
    case 'SchemaError':
    case 'ShellInternalProblem':
    case 'ShellInvalidRequestProblem':
    case 'ShellPolicyConflictProblem':
    case 'ShellPolicyUnprocessableProblem':
    case 'ShellPreconditionRequiredProblem':
    case 'ShellRateLimitedProblem': {
      return { shell, state: 'unavailable' };
    }
    default: {
      const exhaustive: never = error;
      return exhaustive;
    }
  }
};

export const loader = ({ params, request, routeParams = {} }: ModuleTargetLoaderArguments) =>
  loadHomePageModel(request).then((shell) => {
    if (shell.state !== 'authenticated') {
      return {
        shell,
        state: shell.state === 'unavailable' ? 'unavailable' : 'selection_required',
      } as const;
    }
    const boundedRouteParams = selectRouteParams(routeParams, Object.keys(routeParams));
    return runEffectRequest(
      shellAuthenticationClientOptionsFromRequest(request).pipe(
        Effect.flatMap((options) =>
          resolveModuleTarget(
            withOptionalProperty(
              {},
              params.entrypointKey !== undefined,
              'entrypointKey',
              params.entrypointKey,
              {
                moduleId: params.moduleId,
              },
            ),
            options,
          ),
        ),
        Effect.map((target): ModuleTargetPageModel => ({
          routeParams: boundedRouteParams,
          shell,
          state: 'resolved',
          target,
        })),
        Effect.catch((error) =>
          Effect.succeed(
            error._tag === 'ConfigError'
              ? { shell, state: 'unavailable' }
              : safeState(error, shell),
          ),
        ),
      ),
    );
  });
