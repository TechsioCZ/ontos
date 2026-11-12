/**
 * The app host's refusals: an answer the host gives itself instead of a unit's (a relay that found no unit, a route no
 * unit serves, a composition it cannot serve), and a relayed response a unit cut short. Each is one WARN line, so a
 * refusal is never silent, and the lines stay few: the Zerops log service keeps only about 1,000 lines, and a dead
 * unit is asked again on every request.
 *
 * Per key (the unit, or the host route that refused), the first refusal is written at once with its fields. Further
 * refusals within the next 10 seconds are only counted; `flush` (the host runs it every 10 seconds) writes one
 * summary line per key with that count and the last refusal's fields. A key therefore writes at most one line per
 * 10 seconds, however many requests it refuses.
 *
 * Fields carry the method and the path only: never a query string, header, cookie, token or body.
 */
import { Clock, Console, Duration, Effect, Option, Schema } from 'effect';

export const HOST_REFUSAL_LOG_WINDOW = Duration.seconds(10);
const WINDOW_MILLIS = Duration.toMillis(HOST_REFUSAL_LOG_WINDOW);

export type HostRefusalFields = Readonly<Record<string, string | number>>;

/** One refusal: `key` groups it for rate limiting; `what` is fixed text naming the refusal. */
export interface HostRefusal {
  readonly fields: HostRefusalFields;
  readonly key: string;
  readonly what: string;
}

export interface HostRefusalLog {
  readonly flush: Effect.Effect<void>;
  readonly record: (refusal: HostRefusal) => Effect.Effect<void>;
}

interface RefusalWindow {
  last: HostRefusal;
  opened: number;
  suppressed: number;
}

const formatFields = (fields: HostRefusalFields) =>
  Object.entries(fields)
    .map(([name, value]) => `${name}=${String(value)}`)
    .join(' ');

const line = (refusal: HostRefusal, extra: HostRefusalFields) =>
  `[app-host] WARN ${refusal.what}: ${formatFields({ ...refusal.fields, ...extra })}`;

/** A request's method and path, without its query string or fragment. */
export const requestPathOnly = (url: string) => url.split(/[?#]/u, 1)[0] ?? '';

export const makeHostRefusalLog = (): HostRefusalLog => {
  const windows = new Map<string, RefusalWindow>();
  const record = (refusal: HostRefusal) =>
    Effect.gen(function* recordRefusal() {
      const now = yield* Clock.currentTimeMillis;
      const open = windows.get(refusal.key);
      if (open !== undefined && now - open.opened < WINDOW_MILLIS) {
        open.suppressed += 1;
        open.last = refusal;
        return;
      }
      windows.set(refusal.key, { last: refusal, opened: now, suppressed: 0 });
      yield* Console.error(
        line(refusal, open === undefined || open.suppressed === 0 ? {} : { earlierRepeats: open.suppressed }),
      );
    });
  const flush = Effect.gen(function* flushRefusals() {
    const now = yield* Clock.currentTimeMillis;
    for (const [key, open] of windows) {
      if (open.suppressed > 0 && now - open.opened >= WINDOW_MILLIS) {
        yield* Console.error(
          line(open.last, { repeats: open.suppressed, windowSeconds: Duration.toSeconds(HOST_REFUSAL_LOG_WINDOW) }),
        );
        windows.set(key, { last: open.last, opened: now, suppressed: 0 });
      }
    }
  });
  return { flush, record };
};

/**
 * What an error on the way to a unit says about itself, read without its message (which can carry a URL): Node and
 * undici name the failure in `code` (ECONNREFUSED, ECONNRESET, UND_ERR_HEADERS_TIMEOUT, …), sometimes on the cause.
 */
const RelayCauseSchema = Schema.Struct({
  cause: Schema.optionalKey(Schema.Struct({ code: Schema.optionalKey(Schema.String) })),
  code: Schema.optionalKey(Schema.String),
  name: Schema.optionalKey(Schema.String),
});
type RelayCause = typeof RelayCauseSchema.Type;
export const decodeRelayCause = Schema.decodeUnknownOption(RelayCauseSchema);

const SAFE_CODE = /^[A-Z][A-Z0-9_]{1,63}$/u;
const SAFE_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/u;

/** The code to log for a relay failure: its own code, else its cause's, else its class name, else `unknown`. */
export const relayFailureCode = (cause: Option.Option<RelayCause>): string =>
  Option.match(cause, {
    onNone: () => 'unknown',
    onSome: ({ cause: inner, code, name }) =>
      [code, inner?.code].find((candidate) => candidate !== undefined && SAFE_CODE.test(candidate)) ??
      (name !== undefined && SAFE_NAME.test(name) ? name : 'unknown'),
  });

/** A relay that did not reach its unit, or lost it mid-response: where, and a code that is safe to log. */
export class RelayFailure extends Schema.TaggedError<RelayFailure>()('RelayFailure', {
  code: Schema.String,
  stage: Schema.Literals(['request', 'response body']),
}) {}
