import { throwTanstackRedirect } from '@modern-js/plugin-tanstack/runtime';
import { Effect, Match, Predicate, Schema } from 'effect';
import { UrlParams } from 'effect/http';

import { ShellResourceRequestSchema } from '../../../../../../../shared/api.ts';
import type { ShellResourceDetailResponse } from '../../../../../../../shared/api.ts';
import { resourceDetail } from '../../../../../../api/auth-client.ts';
import { browserRuntime } from '../../../../../../runtime/browser-effect-runtime.ts';
import { shellAuthenticationClientOptionsFromRequest } from '../../../../../shell-authentication-client-options.ts';
import { loadHomePageModel, sessionEndedModel } from '../../../../home-page-model.ts';
import { routeMeta } from '../../../../route.meta.ts';
import { requireSignedIn } from '../../../../../sign-in-return.ts';
import { ownerRecordTarget, shellSearchPresentationContext } from '../../../../../shell-search-resource-types.ts';
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
      readonly detailSupport?: 'not_supported';
      readonly shell: HomePageModel;
      readonly state: 'forbidden' | 'not_found' | 'reload_required' | 'selection_required' | 'unavailable';
    }
  | {
      readonly resource: ShellResourceDetailResponse;
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
          Effect.map((resource): ResourcePageModel => {
            if ('outcome' in resource) {
              // The response admits only catalog support, not existence. Never redirect on a denied, missing or
              // failed read. The owner page independently reads the current record under its own permission policy.
              const sameRef =
                resource.ref.moduleId === params.moduleId &&
                resource.ref.resourceType === params.resourceType &&
                resource.ref.resourceId === params.resourceId;
              const target = sameRef
                ? ownerRecordTarget(
                    resource.ref,
                    shell.selectedLegalEntityId,
                    shellSearchPresentationContext(shell.navigation.items),
                  )
                : undefined;
              if (target !== undefined) {
                const prefix = new URL(request.url).pathname.split('/')[1] ?? '';
                const language = Object.hasOwn(routeMeta.localisedPaths, prefix) ? prefix : 'cs';
                const path =
                  'params' in target
                    ? target.to.replace('$id', encodeURIComponent(target.params.id))
                    : `${target.to}?${UrlParams.toString(target.search)}`;
                return throwTanstackRedirect(`/${encodeURIComponent(language)}${path}`);
              }
              return sameRef
                ? { detailSupport: 'not_supported', shell, state: 'unavailable' }
                : { shell, state: 'unavailable' };
            }
            return { resource, shell, state: 'ready' };
          }),
          Effect.matchEffect({
            onFailure: (error) =>
              Effect.succeed<ResourcePageModel>({
                // The resource read itself saying "sign in again" means the session died meanwhile.
                shell: Predicate.isTagged(error, 'ShellAuthenticationRequiredProblem') ? sessionEndedModel : shell,
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
      Effect.map((model) => requireSignedIn(request, model)),
    ),
    { signal: request.signal },
  );
