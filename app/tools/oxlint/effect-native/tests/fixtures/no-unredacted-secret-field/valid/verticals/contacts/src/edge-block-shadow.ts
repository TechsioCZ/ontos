// A block-scoped shadow of the imported namespace must not resolve to Effect.
import { Config, Schema } from 'effect';

export function build(): unknown {
  const Schema = { String: 'string' as const, Struct: (fields: unknown) => fields };
  const Config = { string: (key: string) => key };
  return {
    fields: Schema.Struct({ password: Schema.String, secret: Schema.String }),
    key: Config.string('BETTER_AUTH_SECRET'),
  };
}

export const RealName = Schema.String;
export const RealIssuer = Config.string('ONTOS_GATEWAY_ISSUER');
