// expect-count: 3
import { Schema } from "effect";
import { Struct, String as SchemaString } from "effect/Schema";

interface SeedRow {
	readonly id: string;
}
interface SeedBatch {
	readonly rows: ReadonlyArray<SeedRow>;
}
interface SeedSummary {
	readonly count: number;
}

// direct member import as the initializer, codec annotation via the namespace.
const seedRowSchema: Schema.Codec<SeedRow> = Struct({ id: SchemaString });

// non-exported, block-scoped declarator is still interface-first.
function build(): void {
	const seedBatchSchema: Schema.Codec<SeedBatch> = Schema.Struct({
		rows: Schema.Array(seedRowSchema),
	});
	void seedBatchSchema;
}

// initializer is an opaque factory call: the annotation alone is the competing authority.
const seedSummarySchema: Schema.Codec<SeedSummary> = makeSummarySchema();

declare function makeSummarySchema(): Schema.Codec<SeedSummary>;

void build;
void seedSummarySchema;
