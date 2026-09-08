import { Schema } from "effect";

// Generic arrow in TSX needs the trailing comma; the rule must not choke on it.
export const identity = <T,>(value: T): T => value;

export const RowSchema = Schema.Struct({ id: Schema.String });
export type Row = typeof RowSchema.Type;

// `satisfies` on a non-Schema value stays blessed.
export const meta = { title: "rows" } satisfies { readonly title: string };

export const Rows = (): JSX.Element => (
	<>
		<svg xmlnsXlink="http://www.w3.org/1999/xlink" />
		<span data-title={meta.title}>{identity(String(RowSchema))}</span>
	</>
);
