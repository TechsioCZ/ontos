// expect-count: 2
import { Schema } from "effect";

interface FixtureRow {
	readonly id: string;
}
interface FixturePage {
	readonly rows: ReadonlyArray<FixtureRow>;
}

// tests are in scope by default (`ignoreTests: false`): contracts under test must be Schema-first too.
const fixtureRowSchema: Schema.Codec<FixtureRow> = Schema.Struct({ id: Schema.String });

const fixturePageSchema: Schema.Codec<FixturePage> = Schema.Struct({
	rows: Schema.Array(fixtureRowSchema),
});

void fixturePageSchema;
