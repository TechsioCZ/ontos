// expect-count: 1
// Audit A3 evidence shape: ambient env string -> JSON.parse -> synchronous Schema decode -> throw.
import { Predicate, Schema } from 'effect';

const PrivateJwkInputSchema = Schema.Struct({
	d: Schema.String,
	kid: Schema.String,
	x: Schema.String,
});

export const parsePrivateJwk = (encoded: string): { readonly kid: string } => {
	const parsed = Schema.decodeUnknownSync(PrivateJwkInputSchema)(JSON.parse(encoded));
	if (!Predicate.isString(parsed.kid)) throw new Error('Private JWK is not a signing key');
	return { kid: parsed.kid };
};
