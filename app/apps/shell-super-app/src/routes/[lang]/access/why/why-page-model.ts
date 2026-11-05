import { DateTime, Effect, Match, Option, Schema } from 'effect';
import { Url, UrlParams } from 'effect/http';

import { ExplainAccessPayloadSchema } from '../../../../../shared/access-admin-api.ts';
import type { ExplainAccessPayload, ExplainAccessResponse } from '../../../../../shared/access-admin-api.ts';
import { explainAccess, listAccessPeople } from '../../../../api/auth-client.ts';
import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import {
  emptyWhySearch,
  hiddenWhySubjects,
  whyReasonKey,
  WhySearchDraftSchema,
} from '../../../access-admin/why/why-view-model.ts';
import type { WhyResultView, WhySearchDraft, WhySubjectOptions } from '../../../access-admin/why/why-view-model.ts';
import { shellAuthenticationClientOptionsFromRequest } from '../../../shell-authentication-client-options.ts';
import { loadHomePageModel } from '../../home-page-model.ts';
import type { HomePageModel } from '../../home-page-model.ts';

type ClientOptions = Parameters<typeof explainAccess>[1];
export interface WhyPageModel {
  readonly draft: WhySearchDraft;
  readonly result: WhyResultView;
  readonly shell: HomePageModel;
  readonly subjects: WhySubjectOptions;
}

// Do not broaden a partial record or amount into a scope-only/amount-free decision.
export const decodeWhySearch = (draft: WhySearchDraft): Option.Option<ExplainAccessPayload> => {
  if ((draft.targetModule === '') !== (draft.recordKey === '') || (draft.currency === '') !== (draft.minor === '')) {
    return Option.none();
  }
  if (draft.minor !== '' && (!/^\d+$/u.test(draft.minor) || !Number.isSafeInteger(Number(draft.minor)))) {
    return Option.none();
  }
  const input = {
    capabilityKey: draft.capabilityKey,
    mode: draft.mode,
    scope: draft.companyId === '' ? { kind: 'tenant' } : { kind: 'company', legalEntityId: draft.companyId },
  };
  const targeted =
    draft.recordKey === ''
      ? input
      : { ...input, target: { moduleKey: draft.targetModule, recordKey: draft.recordKey } };
  const amountBound =
    draft.minor === '' ? targeted : { ...targeted, amount: { currency: draft.currency, minor: Number(draft.minor) } };
  const subjectBound = draft.subject === '' ? amountBound : { ...amountBound, subjectPrincipalId: draft.subject };
  return Schema.decodeUnknownOption(ExplainAccessPayloadSchema)(subjectBound);
};

export const whyDecisionView = (
  response: ExplainAccessResponse,
  query: WhySearchDraft,
  subjectName: string | null = null,
): WhyResultView => ({
  decision: {
    authority:
      response.authorityMetadata === 'included'
        ? response.authority.map((role) => ({
            deadline: role.deadline === undefined ? null : DateTime.formatIso(role.deadline),
            id: `${role.roleId}:${role.capabilityKey}:${role.mode}:${role.selector}`,
            name: role.roleName ?? role.roleId,
          }))
        : [],
    authorityMetadata: response.authorityMetadata,
    deadline: response.admissionDeadline === undefined ? null : DateTime.formatIso(response.admissionDeadline),
    fieldClass: response.fieldClass ?? null,
    grantableBy:
      response.authorityMetadata === 'included'
        ? response.grantableBy.map((person) => ({ id: person.principalId, name: person.displayName }))
        : [],
    outcome: Match.value(response.outcome).pipe(
      Match.when('ALLOWED', () => 'allowed' as const),
      Match.when('DENIED', () => 'denied' as const),
      Match.when('NEEDS_APPROVAL', () => 'needsApproval' as const),
      Match.exhaustive,
    ),
    reasonKeys: [...new Set(response.reasonCodes.map(whyReasonKey))],
    subjectName,
  },
  query,
  state: 'decision',
});

export const loadWhySubjects = (options?: ClientOptions, cursor?: string): Effect.Effect<WhySubjectOptions> => {
  const payload = cursor === undefined ? { limit: 100 } : { cursor, limit: 100 };
  return listAccessPeople(payload, options).pipe(
    Effect.timeout('30 seconds'),
    Effect.match({
      onFailure: (error): WhySubjectOptions =>
        Match.value(error).pipe(
          Match.tag('AccessAdminForbidden', 'AccessAdminAuthenticationRequired', () => ({ state: 'hidden' as const })),
          Match.tag(
            'AccessAdminConflict',
            'AccessAdminInternal',
            'AccessAdminInvalidRequest',
            'AccessAdminUnavailable',
            'AccessAdminUnprocessable',
            'HttpClientError',
            'SchemaError',
            'TimeoutError',
            () => ({ state: 'unavailable' as const }),
          ),
          Match.exhaustive,
        ),
      onSuccess: (response): WhySubjectOptions => ({
        nextCursor: response.nextCursor,
        people: response.items.map((person) => ({ label: person.displayName, value: person.principalId })),
        revision: response.revision,
        state: 'ready',
      }),
    }),
  );
};

export const mergeWhySubjects = (previous: WhySubjectOptions, next: WhySubjectOptions): WhySubjectOptions => {
  if (previous.state === 'ready' && next.state === 'ready' && previous.revision === next.revision) {
    return {
      ...next,
      people: [...new Map([...previous.people, ...next.people].map((person) => [person.value, person])).values()],
    };
  }
  return next;
};

export const checkWhySearch = (
  draft: WhySearchDraft,
  options?: ClientOptions,
  subjects: WhySubjectOptions = hiddenWhySubjects,
): Effect.Effect<WhyResultView> => {
  let subjectName: string | null = null;
  if (draft.subject.length > 0) {
    if (subjects.state === 'unavailable') {
      return Effect.succeed({ state: 'unavailable' });
    }
    if (subjects.state === 'hidden') {
      return Effect.succeed({ state: 'forbidden' });
    }
    const person = subjects.people.find((candidate) => candidate.value === draft.subject);
    if (person === undefined) {
      return Effect.succeed({ state: 'invalid' });
    }
    subjectName = person.label;
  }
  const payload = decodeWhySearch(draft);
  if (Option.isNone(payload)) {
    return Effect.succeed({ state: 'invalid' });
  }
  return explainAccess(payload.value, options).pipe(
    Effect.timeout('30 seconds'),
    Effect.match({
      onFailure: (error): WhyResultView => ({
        state: Match.value(error).pipe(
          Match.tag('AccessAdminAuthenticationRequired', () => 'unauthenticated' as const),
          Match.tag('AccessAdminForbidden', () => 'forbidden' as const),
          Match.tag('AccessAdminInvalidRequest', 'AccessAdminUnprocessable', () => 'invalid' as const),
          Match.tag('AccessAdminConflict', () => 'conflict' as const),
          Match.tag(
            'AccessAdminUnavailable',
            'AccessAdminInternal',
            'HttpClientError',
            'SchemaError',
            'TimeoutError',
            () => 'unavailable' as const,
          ),
          Match.exhaustive,
        ),
      }),
      onSuccess: (response): WhyResultView => whyDecisionView(response, draft, subjectName),
    }),
  );
};

export const whySearchFromRequest = (request: Request): Option.Option<WhySearchDraft> =>
  Schema.decodeUnknownOption(WhySearchDraftSchema)({
    ...emptyWhySearch,
    ...UrlParams.toRecord(Url.urlParams(new URL(request.url))),
  });

export const loadWhyPageModel = Effect.fn('WhyPageModel.load')(function* loadWhy(request: Request) {
  const shell = yield* loadHomePageModel(request);
  if (shell.state !== 'authenticated') {
    return {
      draft: emptyWhySearch,
      result: { state: shell.state === 'anonymous' ? 'unauthenticated' : 'unavailable' },
      shell,
      subjects: { state: 'hidden' },
    } satisfies WhyPageModel;
  }
  return yield* shellAuthenticationClientOptionsFromRequest(request).pipe(
    Effect.flatMap(
      Effect.fn('WhyPageModel.loadContext')(function* loadContext(options: ClientOptions) {
        const subjects = yield* loadWhySubjects(options);
        const decoded = whySearchFromRequest(request);
        if (Option.isNone(decoded)) {
          return { draft: emptyWhySearch, result: { state: 'invalid' }, shell, subjects } satisfies WhyPageModel;
        }
        const draft = decoded.value;
        const result: WhyResultView =
          draft.capabilityKey === '' ? { state: 'idle' } : yield* checkWhySearch(draft, options, subjects);
        return { draft, result, shell, subjects } satisfies WhyPageModel;
      }),
    ),
    Effect.catchTag('ConfigError', () =>
      Effect.succeed<WhyPageModel>({
        draft: emptyWhySearch,
        result: { state: 'unavailable' },
        shell,
        subjects: { state: 'unavailable' },
      }),
    ),
  );
});

export const loader = ({ request }: { readonly request: Request }): Promise<WhyPageModel> =>
  browserRuntime.runPromise(loadWhyPageModel(request), { signal: request.signal });
