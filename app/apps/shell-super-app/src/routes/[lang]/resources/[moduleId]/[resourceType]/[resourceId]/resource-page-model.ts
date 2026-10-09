import { Effect, Match, Schema } from 'effect';

import { ShellResourceRequestSchema } from '../../../../../../../shared/api.ts';
import type { ShellResourceResponse } from '../../../../../../../shared/api.ts';
import { resourceDetail } from '../../../../../../api/auth-client.ts';
import { browserRuntime } from '../../../../../../runtime/browser-effect-runtime.ts';
import { shellAuthenticationClientOptionsFromRequest } from '../../../../../shell-authentication-client-options.ts';
import { loadHomePageModel } from '../../../../home-page-model.ts';
import type { HomePageModel } from '../../../../home-page-model.ts';

interface ResourceLoaderArguments {
  readonly params: {
    readonly moduleId: string;
    readonly resourceId: string;
    readonly resourceType: string;
    readonly tenantId?: string;
  };
  readonly request: Request;
}

export type ResourcePageModel =
  | {
      readonly shell: HomePageModel;
      readonly state: 'forbidden' | 'not_found' | 'reload_required' | 'selection_required' | 'unavailable';
    }
  | {
      readonly resource: ShellResourceResponse;
      readonly shell: HomePageModel;
      readonly state: 'ready';
    };

export const loader = ({ params, request }: ResourceLoaderArguments): Promise<ResourcePageModel> =>
  browserRuntime.runPromise(
    loadHomePageModel(request).pipe(
      Effect.timeout('30 seconds'),
      Effect.flatMap((shell) => {
        if (shell.state !== 'authenticated') {
          return Effect.succeed<ResourcePageModel>({
            shell,
            state: shell.state === 'anonymous' ? 'selection_required' : shell.state,
          });
        }
        if (shell.compositionRevision === undefined) {
          return Effect.succeed<ResourcePageModel>({ shell, state: 'selection_required' });
        }
        const { compositionRevision } = shell;
        return shellAuthenticationClientOptionsFromRequest(request).pipe(
          Effect.flatMap((options) =>
            Schema.decodeEffect(ShellResourceRequestSchema)({
              ...params,
              compositionRevision,
            }).pipe(Effect.flatMap((resourceRef) => resourceDetail(resourceRef, options))),
          ),
          Effect.map((resource): ResourcePageModel => ({
            resource,
            shell,
            state: 'ready',
          })),
          Effect.matchEffect({
            onFailure: (error) =>
              Effect.succeed<ResourcePageModel>({
                shell,
                state: Match.value(error).pipe(
                  Match.tag('ShellReloadRequiredProblem', () => 'reload_required' as const),
                  Match.tag(
                    'ShellAuthenticationRequiredProblem',
                    'ShellSelectionRequiredProblem',
                    () => 'selection_required' as const,
                  ),
                  Match.tag('ShellTargetForbiddenProblem', () => 'forbidden' as const),
                  Match.tag('ShellTargetNotFoundProblem', () => 'not_found' as const),
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
                    () => 'unavailable' as const,
                  ),
                  Match.exhaustive,
                ),
              }),
            onSuccess: Effect.succeed,
          }),
        );
      }),
    ),
    { signal: request.signal },
  );
