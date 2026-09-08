import { Effect, Match, Schema } from 'effect';

import { ResourceRefSchema } from '../../../../../../../shared/api.ts';
import type { ShellResourceResponse } from '../../../../../../../shared/api.ts';
import { resourceDetail } from '../../../../../../api/auth-client.ts';
import { runBrowserEffect } from '../../../../../../runtime/browser-effect-runtime.ts';
import { shellAuthenticationClientOptionsFromRequest } from '../../../../../shell-authentication-client-options.ts';
import { loadHomePageModel } from '../../../../page.data.ts';
import type { HomePageModel } from '../../../../page.data.ts';

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
      readonly state:
        | 'forbidden'
        | 'not_found'
        | 'selection_required'
        | 'unavailable';
    }
  | {
      readonly resource: ShellResourceResponse;
      readonly shell: HomePageModel;
      readonly state: 'ready';
    };

export const loader = ({
  params,
  request,
}: ResourceLoaderArguments): Promise<ResourcePageModel> =>
  runBrowserEffect(
    Effect.tryPromise(() => loadHomePageModel(request)).pipe(
      Effect.timeout('30 seconds'),
      Effect.flatMap((shell) => {
        if (shell.state !== 'authenticated') {
          return Effect.succeed<ResourcePageModel>({
            shell,
            state:
              shell.state === 'unavailable'
                ? 'unavailable'
                : 'selection_required',
          });
        }
        return shellAuthenticationClientOptionsFromRequest(request).pipe(
          Effect.flatMap((options) =>
            Schema.decodeUnknownEffect(ResourceRefSchema)(params).pipe(
              Effect.flatMap((resourceRef) =>
                resourceDetail(resourceRef, options)
              )
            )
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
                  Match.tag(
                    'ShellAuthenticationRequiredProblem',
                    'ShellSelectionRequiredProblem',
                    () => 'selection_required' as const
                  ),
                  Match.tag(
                    'ShellTargetForbiddenProblem',
                    () => 'forbidden' as const
                  ),
                  Match.tag(
                    'ShellTargetNotFoundProblem',
                    () => 'not_found' as const
                  ),
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
                    () => 'unavailable' as const
                  ),
                  Match.exhaustive
                ),
              }),
            onSuccess: Effect.succeed,
          })
        );
      })
    )
  );
