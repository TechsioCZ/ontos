// Same member names, none of them Effect's `Schema`.
import { Schema } from 'effect';

export const CustomerSchema = Schema.Struct({ id: Schema.String });

/** A parameter shadow: `Schema` here is a hand-rolled codec, not the Effect namespace. */
export const runWithLocalCodec = (Schema: { readonly decodeUnknownSync: (value: unknown) => string }): string =>
	Schema.decodeUnknownSync('raw');

/** A hand-rolled codec object declaring the member, and a call on it. */
export const legacyCodec = {
	decodeUnknownSync: (value: unknown): string => String(value),
	encodeSync: (value: string): string => value,
};

export const legacyDecoded = legacyCodec.decodeUnknownSync('raw');
export const legacyEncoded = legacyCodec['encodeSync']('raw');

export const CodecBadge = (): JSX.Element => <span>{legacyDecoded}</span>;
