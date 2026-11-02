import { Context, Effect, Layer, Option } from 'effect';

import { peopleDirectoryRolesOf } from '../auth/people-directory-read.ts';
import { loadSpiceDbConfig } from '../permissions/config.ts';
import { openSpiceDbRpc } from '../permissions/spicedb-transaction-guard.ts';
import { ReadHandlerUnavailable } from '../reads/errors.ts';

export const peopleSearchUnavailable = (cause?: unknown) =>
  Object.defineProperty(
    new ReadHandlerUnavailable({
      code: 'read_handler_unavailable',
      reason: 'People search is temporarily unavailable',
    }),
    'cause',
    { value: cause },
  );

export class PeopleSearchVisibility extends Context.Service<
  PeopleSearchVisibility,
  {
    readonly visible: (
      tenantId: string,
      principalIds: readonly string[],
    ) => Effect.Effect<ReadonlySet<string>, ReadHandlerUnavailable>;
  }
>()('@app/core-runtime/people/people-search-visibility/PeopleSearchVisibility') {}

/** Same cross-company system-service exclusion as the canonical directory, outside SQL transactions. */
export const PeopleSearchVisibilityLive = Layer.succeed(PeopleSearchVisibility, {
  visible: Effect.fn('PeopleSearchVisibility.visible')(function* visible(
    tenantId: string,
    principalIds: readonly string[],
  ) {
    if (principalIds.length === 0) {
      return new Set<string>();
    }
    return yield* Effect.scoped(
      Effect.gen(function* visibleOutsideTransaction() {
        const configuration = yield* loadSpiceDbConfig();
        const rpc = yield* Effect.acquireRelease(
          Effect.try({ catch: peopleSearchUnavailable, try: () => openSpiceDbRpc(configuration, 5000) }),
          (client) => Effect.sync(client.close),
        );
        const visibleIds = yield* Effect.forEach(
          [...new Set(principalIds)],
          Effect.fn(function* readVisibility(principalId) {
            const roles = yield* peopleDirectoryRolesOf(rpc, { principalId, tenantId });
            return Option.isSome(roles) ? [principalId] : [];
          }),
          { concurrency: 4 },
        );
        return new Set(visibleIds.flat());
      }),
    ).pipe(Effect.mapError(peopleSearchUnavailable));
  }),
});
