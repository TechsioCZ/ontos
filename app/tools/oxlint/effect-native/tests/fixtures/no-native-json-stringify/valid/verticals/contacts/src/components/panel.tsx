// The component renders Schema-encoded text and a serializer handed in as a prop.
import { Schema } from "effect";

const Filters = Schema.Struct({ query: Schema.String });
const encodeFilters = Schema.encodeSync(Schema.fromJsonString(Filters));

interface PanelProps {
	readonly filters: { readonly query: string };
	readonly serialize: (value: unknown) => string;
}

export function FiltersPanel({ filters, serialize }: PanelProps) {
	return <span data-filters={encodeFilters(filters)}>{serialize(filters)}</span>;
}
