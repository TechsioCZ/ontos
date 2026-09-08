// A service implementation record handed to a Layer combinator: the throw sits in an Effect
// combinator argument and is owned by effect-native/no-throw-in-effect-callback, so this rule must
// not report it a second time.
import { Context, Effect, Layer } from 'effect';

type Environment = Readonly<Record<string, string | undefined>>;

export class ContactsConfig extends Context.Tag('ContactsConfig')<
  ContactsConfig,
  { readonly read: (environment: Environment) => string }
>() {}

export const ContactsConfigLive = Layer.succeed(ContactsConfig, {
  read: (environment: Environment): string => {
    const value = environment['ONTOS_CONTACTS_API_BASE'];
    if (value === undefined) {
      throw new Error('ONTOS_CONTACTS_API_BASE is required');
    }
    return value;
  },
});

export const useConfig = Effect.gen(function* () {
  const config = yield* ContactsConfig;
  return config;
});
