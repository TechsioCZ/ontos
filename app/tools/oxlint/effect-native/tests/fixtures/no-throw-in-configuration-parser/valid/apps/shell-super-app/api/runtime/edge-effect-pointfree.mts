// Point-free and aliased Effect callbacks in an `.mts` module. Every throw already has a typed
// boundary and is owned by effect-native/no-throw-in-effect-callback, so this rule stays quiet.
import { Effect as E, pipe } from 'effect';
import * as Sch from 'effect/Schema';

type Environment = Readonly<Record<string, string | undefined>>;

export const loadApiBase = (environment: Environment) =>
  pipe(
    E.succeed(environment['ONTOS_API_BASE']),
    E.map((raw) => {
      if (raw === undefined) {
        throw new Error('ONTOS_API_BASE is required');
      }
      return raw;
    }),
  );

export const decodeLocale = (environment: Environment) =>
  E.try({
    catch: () => new Error('ONTOS_LOCALE is malformed'),
    try: () => {
      const locale = environment['ONTOS_LOCALE'];
      if (locale === undefined) {
        throw new Error('ONTOS_LOCALE is required');
      }
      return Sch.decodeUnknownSync(Sch.String)(locale);
    },
  });

export const loadFlags = (environment: Environment) =>
  E.gen(function* () {
    const raw = environment['ONTOS_FEATURE_FLAGS'];
    if (raw === undefined) {
      throw new Error('ONTOS_FEATURE_FLAGS is required');
    }
    return yield* E.succeed(raw.split(','));
  });

const run = E.runPromise;
export const runApiBase = (environment: Environment): Promise<string> => run(loadApiBase(environment));
