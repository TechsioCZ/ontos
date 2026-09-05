// expect-count: 3
// A4: every Contacts read server owns a copy-pasted `catchDefect` → sanitized 500.
import { Effect } from '@modern-js/plugin-bff/effect-edge';

declare const problems: { readonly internal: () => { readonly _tag: 'Internal' } };
declare const customerDetail: Effect.Effect<string, never>;
declare const contactList: Effect.Effect<string, never>;
declare const aresLookup: Effect.Effect<string, never>;

export const detail = customerDetail.pipe(
  Effect.catchDefect((defect) =>
    Effect.annotateLogs(Effect.logError('Unexpected Customer detail BFF defect', defect), {
      correlationId: 'unavailable',
    }).pipe(Effect.andThen(Effect.fail(problems.internal()))),
  ),
);

export const list = contactList.pipe(
  Effect.catchDefect(() => Effect.fail(problems.internal())),
);

export const lookup = aresLookup.pipe(
  Effect.catchAllCause(() => Effect.fail(problems.internal())),
);
