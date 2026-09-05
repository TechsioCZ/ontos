// The Effect-native replacements this rule points at.
import { Config, Effect, Result, Schema } from 'effect';

const JwksSchema = Schema.Struct({ keys: Schema.Array(Schema.String) });

export const decodeJwks = (input: unknown) => Schema.decodeUnknownEffect(JwksSchema)(input);

export const decodeJwksResult = (input: unknown) => Schema.decodeUnknownResult(JwksSchema)(input);

export const encodeJwks = (value: { readonly keys: readonly string[] }) =>
	Schema.encodeUnknownEffect(JwksSchema)(value);

export const jwksConfig = Config.schema(JwksSchema, 'ONTOS_GATEWAY_PUBLIC_JWKS');

export const program = Effect.gen(function* () {
	const configured = yield* jwksConfig;
	const decoded = yield* decodeJwks(configured);
	return Result.isSuccess(decodeJwksResult(decoded)) ? decoded.keys.length : 0;
});
