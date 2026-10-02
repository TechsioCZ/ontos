import { Effect, Match, Schema } from 'effect';
import type { Cause, Config } from 'effect';

import { ResolveModuleTargetPayloadSchema } from '../../../../../shared/api.ts';
import type { ResolvedModuleTarget } from '../../../../../shared/api.ts';
import { resolveModuleTarget } from '../../../../api/auth-client.ts';
import type { ShellTargetClientError } from '../../../../api/auth-client.ts';
import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import { shellAuthenticationClientOptionsFromRequest } from '../../../shell-authentication-client-options.ts';
import { loadHomePageModel } from '../../home-page-model.ts';
import type { HomePageModel } from '../../home-page-model.ts';

interface ModuleTargetLoaderArguments {
  readonly canonicalPath?: string;
  readonly params?: {
    readonly entrypointKey?: string;
    readonly moduleId: string;
  };
  readonly request: Request;
}

export type ModulePageRouteParams = Readonly<Record<string, string>>;

export type ModuleTargetPageModel =
  | {
      readonly shell: HomePageModel;
      readonly state: 'forbidden' | 'not_found' | 'reload_required' | 'selection_required' | 'unavailable';
    }
  | {
      readonly routeParams: ModulePageRouteParams;
      readonly shell: HomePageModel;
      readonly state: 'resolved';
      readonly target: ResolvedModuleTarget;
    };

const safeState = (error: Config.ConfigError | ShellTargetClientError, shell: HomePageModel): ModuleTargetPageModel =>
  Match.value(error).pipe(
    Match.tag('ShellReloadRequiredProblem', () => ({ shell, state: 'reload_required' as const })),
    Match.tag('ShellAuthenticationRequiredProblem', 'ShellSelectionRequiredProblem', () => ({
      shell,
      state: 'selection_required' as const,
    })),
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
      () => ({ shell, state: 'unavailable' as const }),
    ),
    Match.exhaustive,
  );

export const loadModulePageModel = ({
  canonicalPath,
  params,
  request,
}: ModuleTargetLoaderArguments): Effect.Effect<ModuleTargetPageModel, Cause.TimeoutError> =>
  loadHomePageModel(request).pipe(
    Effect.timeout('30 seconds'),
    Effect.flatMap((shell) => {
      if (shell.state !== 'authenticated') {
        return Effect.succeed<ModuleTargetPageModel>({
          shell,
          state: shell.state === 'anonymous' ? 'selection_required' : shell.state,
        });
      }
      if (shell.compositionRevision === undefined) {
        return Effect.succeed<ModuleTargetPageModel>({ shell, state: 'selection_required' });
      }
      const { compositionRevision } = shell;
      return shellAuthenticationClientOptionsFromRequest(request).pipe(
        Effect.flatMap((options) =>
          Schema.decodeEffect(ResolveModuleTargetPayloadSchema)({
            ...(canonicalPath === undefined ? params : { canonicalPath }),
            compositionRevision,
          }).pipe(Effect.flatMap((payload) => resolveModuleTarget(payload, options))),
        ),
        Effect.map((target): ModuleTargetPageModel =>
          target.compositionRevision === compositionRevision
            ? { routeParams: target.routeParameters, shell, state: 'resolved', target }
            : { shell, state: 'reload_required' },
        ),
        Effect.matchEffect({
          onFailure: (error) => Effect.succeed(safeState(error, shell)),
          onSuccess: Effect.succeed,
        }),
      );
    }),
  );

export const loader = (input: ModuleTargetLoaderArguments): Promise<ModuleTargetPageModel> =>
  browserRuntime.runPromise(loadModulePageModel(input), {
    signal: input.request.signal,
  });
