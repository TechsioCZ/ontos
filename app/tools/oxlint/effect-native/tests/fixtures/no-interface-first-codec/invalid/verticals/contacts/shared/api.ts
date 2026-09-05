// expect-count: 4
import { Schema as S } from "effect";
import * as Codecs from "effect/Schema";
import type { Codec } from "effect/Schema";

export interface ContactsMarker {
	readonly kind: string;
}
export interface ContactsReadiness {
	readonly ready: boolean;
}
export interface CustomerContactRow {
	readonly id: string;
}
export interface ContactsFilter {
	readonly query: string;
}

// aliased named import: `Schema as S`.
export const contactsMarkerSchema: S.Codec<ContactsMarker> = S.Struct({ kind: S.String });

// submodule namespace import: `import * as Codecs from "effect/Schema"`.
export const contactsReadinessSchema: Codecs.Codec<ContactsReadiness> = Codecs.Struct({
	ready: Codecs.Boolean,
});

// bare type import of the codec type itself.
export const customerContactRowSchema: Codec<CustomerContactRow> = Codecs.Struct({
	id: Codecs.String,
});

// `Schema.Schema<A, I>` spelling of the same annotation.
export const contactsFilterSchema: S.Schema<ContactsFilter, unknown> = S.Struct({ query: S.String });
