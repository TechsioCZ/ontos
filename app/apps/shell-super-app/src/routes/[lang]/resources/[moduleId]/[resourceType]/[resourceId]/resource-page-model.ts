import { throwTanstackRedirect } from '@modern-js/plugin-tanstack/runtime';
import { Effect, Match, Option, Predicate, Schema } from 'effect';
import { UrlParams } from 'effect/http';

import { ShellResourceRequestSchema, ShellSearchPresentationInventorySchema } from '../../../../../../../shared/api.ts';
import type { ShellResourceDetailResponse, ShellResourceResponse } from '../../../../../../../shared/api.ts';
import { resourceDetail } from '../../../../../../api/auth-client.ts';
import { browserRuntime } from '../../../../../../runtime/browser-effect-runtime.ts';
import { shellAuthenticationClientOptionsFromRequest } from '../../../../../shell-authentication-client-options.ts';
import { loadHomePageModel, sessionEndedModel } from '../../../../home-page-model.ts';
import { routeMeta } from '../../../../route.meta.ts';
import { requireSignedIn } from '../../../../../sign-in-return.ts';
import {
  recordAgendaPaths,
  shellSearchPresentationIndex,
  shellSearchRecordTarget,
} from '../../../../../shell-search-resource-types.ts';
import type {
  ShellSearchNamedTarget,
  ShellSearchPresentationIndex,
} from '../../../../../shell-search-resource-types.ts';
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
      /** The exact captured agendas the inventory declares for this record, or the generic module fallback. */
      readonly agendaPaths?: readonly string[];
      readonly detailSupport?: 'not_supported';
      readonly shell: HomePageModel;
      readonly state: 'forbidden' | 'not_found' | 'reload_required' | 'selection_required' | 'unavailable';
    }
  | {
      readonly resource: ShellResourceDetailResponse;
      readonly shell: HomePageModel;
      readonly state: 'ready';
    };

/**
 * The single-detail presentation inventory the Host attaches to a resource response. It is read structurally: the
 * browser keeps working while the Host has not wired the detail inventory yet, and a stale or malformed value is
 * simply no owner destination. Nothing here redirects on a denied, missing or failed read.
 */
const detailPresentationIndex = (
  resource: ShellResourceResponse,
  compositionRevision: string,
): ShellSearchPresentationIndex | undefined => {
  if (!Predicate.hasProperty(resource, 'presentation')) {
    return undefined;
  }
  const decoded = Schema.decodeUnknownOption(ShellSearchPresentationInventorySchema)(resource.presentation);
  return Option.isSome(decoded) ? shellSearchPresentationIndex(decoded.value, compositionRevision) : undefined;
};

const namedPath = (target: ShellSearchNamedTarget): string | undefined => {
  const parameterNames = [...target.to.matchAll(/\$(?<name>[a-z][A-Za-z0-9]*)/gu)].map(
    (match) => match.groups?.['name'] ?? '',
  );
  if (parameterNames.some((name) => target.params?.[name] === undefined)) {
    return undefined;
  }
  // Opaque owner IDs stay unchanged in the model; only this redirect adapter encodes the exact named values.
  return target.to.replaceAll(/\$(?<name>[a-z][A-Za-z0-9]*)/gu, (_match, name: string) =>
    encodeURIComponent(target.params?.[name] ?? ''),
  );
};

const withAgendas = <Value extends object>(
  model: Value,
  agendas: readonly string[] | undefined,
): Value & { readonly agendaPaths?: readonly string[] } =>
  agendas === undefined ? model : { ...model, agendaPaths: agendas };

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
              const index = sameRef ? detailPresentationIndex(resource, compositionRevision) : undefined;
              const target =
                index === undefined
                  ? undefined
                  : shellSearchRecordTarget(index, resource.ref, shell.selectedLegalEntityId);
              const path = target === undefined ? undefined : namedPath(target);
              if (target !== undefined && path !== undefined) {
                const prefix = new URL(request.url).pathname.split('/')[1] ?? '';
                const language = Object.hasOwn(routeMeta.localisedPaths, prefix) ? prefix : 'cs';
                const search = target.search === undefined ? '' : `?${UrlParams.toString(target.search)}`;
                return throwTanstackRedirect(`/${encodeURIComponent(language)}${path}${search}`);
              }
              return sameRef
                ? withAgendas(
                    { detailSupport: 'not_supported' as const, shell, state: 'unavailable' as const },
                    index === undefined ? undefined : recordAgendaPaths(index, resource.ref),
                  )
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
