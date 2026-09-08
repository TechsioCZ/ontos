// expect-count: 5
import { Schema } from "effect";

export interface ContactRow {
	readonly id: string;
}
export interface ContactPage {
	readonly rows: ReadonlyArray<ContactRow>;
}
export interface ContactFilter {
	readonly q: string;
}
export interface ContactDraft {
	readonly name: string;
}
export interface ContactBadgeProps {
	readonly label: string;
}

export class ContactCodecs {
	build(): unknown {
		const rowSchema: Schema.Codec<ContactRow> = Schema.Struct({ id: Schema.String });
		return rowSchema;
	}

	async *stream(): AsyncGenerator<unknown> {
		const pageSchema: Schema.Codec<ContactPage> = Schema.Struct({ rows: Schema.Array(Schema.Unknown) });
		yield pageSchema;
	}
}

export const makeFilter = () => () => {
	const filterSchema: Schema.Codec<ContactFilter> = Schema.Struct({ q: Schema.String });
	return filterSchema;
};

export namespace Drafts {
	export const draftSchema: Schema.Codec<ContactDraft> = Schema.Struct({ name: Schema.String });
}

const badgePropsSchema: Schema.Codec<ContactBadgeProps> = Schema.Struct({ label: Schema.String });

export const Badge = (props: ContactBadgeProps): JSX.Element => (
	<span data-schema={String(badgePropsSchema)}>{props.label}</span>
);
