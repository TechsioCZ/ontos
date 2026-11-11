import { DateTime, Effect, Match, Option, Schema } from 'effect';
import { Url, UrlParams } from 'effect/http';

import {
  ListAccessPeopleOptionsResponseSchema,
  ListAccessPeopleResponseSchema,
} from '../../../../../shared/access-admin-api.ts';
import { listAccessPeople, listAccessPeopleOptions } from '../../../../api/auth-client.ts';
import type { ShellAuthenticationClientOptions } from '../../../../api/auth-client.ts';
import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import { shellAuthenticationClientOptionsFromRequest } from '../../../shell-authentication-client-options.ts';
import { loadHomePageModel } from '../../home-page-model.ts';
import type { HomePageModel } from '../../home-page-model.ts';

export interface PeopleReadPort {
  readonly list: typeof listAccessPeople;
  readonly options: typeof listAccessPeopleOptions;
}

export interface PeopleSnapshot {
  readonly options: typeof ListAccessPeopleOptionsResponseSchema.Encoded;
  readonly people: typeof ListAccessPeopleResponseSchema.Encoded;
  /** When the list was read; a member row is current against it, as Core judges it at the write. */
  readonly readAt: typeof Schema.DateTimeUtcFromString.Encoded;
}

export type PeoplePageModel =
  | { readonly shell: HomePageModel; readonly snapshot: PeopleSnapshot; readonly state: 'ready' }
  | {
      readonly shell: HomePageModel;
      readonly state: 'unauthenticated' | 'forbidden' | 'unavailable' | 'conflict' | 'invalid' | 'reload_required';
    };

const livePeopleReadPort: PeopleReadPort = { list: listAccessPeople, options: listAccessPeopleOptions };
const PeopleRouteSearch = Schema.Struct({
  cursor: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500))),
});

/** Tenant authentication is sufficient to ask the governed BFF; the BFF alone admits the read. */
export const loadPeopleData = (
  shell: HomePageModel,
  options: ShellAuthenticationClientOptions,
  cursor?: string,
  port: PeopleReadPort = livePeopleReadPort,
): Effect.Effect<PeoplePageModel> => {
  if (shell.state !== 'authenticated') {
    return Effect.succeed({ shell, state: shell.state === 'anonymous' ? 'unauthenticated' : shell.state });
  }
  const payload = cursor === undefined ? { limit: 50 } : { cursor, limit: 50 };
  return Effect.all(
    { options: port.options({ limit: 100 }, options), people: port.list(payload, options) },
    { concurrency: 2 },
  ).pipe(
    Effect.flatMap((snapshot) => {
      if (snapshot.people.revision !== snapshot.options.revision) {
        return Effect.succeed<PeoplePageModel>({ shell, state: 'conflict' });
      }
      return Effect.all(
        {
          options: Schema.encodeEffect(ListAccessPeopleOptionsResponseSchema)(snapshot.options),
          people: Schema.encodeEffect(ListAccessPeopleResponseSchema)(snapshot.people),
          readAt: DateTime.now.pipe(Effect.flatMap(Schema.encodeEffect(Schema.DateTimeUtcFromString))),
        },
        { concurrency: 1 },
      ).pipe(Effect.map((encoded): PeoplePageModel => ({ shell, snapshot: encoded, state: 'ready' })));
    }),
    Effect.timeout('30 seconds'),
    Effect.match({
      onFailure: (error): PeoplePageModel => ({
        shell,
        state: Match.value(error).pipe(
          Match.tag('AccessAdminAuthenticationRequired', () => 'unauthenticated' as const),
          Match.tag('AccessAdminForbidden', () => 'forbidden' as const),
          Match.tag('AccessAdminConflict', () => 'conflict' as const),
          Match.tag('AccessAdminInvalidRequest', 'AccessAdminUnprocessable', () => 'invalid' as const),
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
      onSuccess: (model) => model,
    }),
  );
};

export const loader = ({ request }: { readonly request: Request }): Promise<PeoplePageModel> => {
  const cursorValue = UrlParams.getFirst(Url.urlParams(new URL(request.url)), 'cursor');
  const search = Schema.decodeOption(PeopleRouteSearch)(
    Option.isSome(cursorValue) ? { cursor: cursorValue.value } : {},
  );
  return browserRuntime.runPromise(
    loadHomePageModel(request).pipe(
      Effect.flatMap((shell) =>
        shellAuthenticationClientOptionsFromRequest(request).pipe(
          Effect.flatMap((options) =>
            Option.isSome(search)
              ? loadPeopleData(shell, options, search.value.cursor)
              : Effect.succeed<PeoplePageModel>({ shell, state: 'invalid' }),
          ),
          Effect.catchTag('ConfigError', () => Effect.succeed<PeoplePageModel>({ shell, state: 'unavailable' })),
        ),
      ),
    ),
    { signal: request.signal },
  );
};
