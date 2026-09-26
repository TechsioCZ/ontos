import { Config, Schema } from 'effect';

// A local shadow of the imported namespace must not resolve to Effect.
export const build = (Schema: { readonly String: string }, Config: { readonly string: (key: string) => string }) => ({
  fields: { password: Schema.String, secret: Schema.String },
  key: Config.String('BETTER_AUTH_SECRET'),
});

// Referenced so the real imports are used somewhere.
export const RealIssuer = Config.String('ONTOS_GATEWAY_ISSUER');
export const RealName = Schema.String;
