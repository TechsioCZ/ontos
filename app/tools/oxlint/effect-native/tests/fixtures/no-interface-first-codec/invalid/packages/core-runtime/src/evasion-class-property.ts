// expect-count: 2
import { Schema } from "effect";

export interface OutboxRow {
	readonly id: string;
}
export interface PrincipalRow {
	readonly principalId: string;
}

/** A2 hidden inside a class body: the field annotation is still a second authority. */
export class OutboxRepository {
	private readonly rowSchema: Schema.Codec<OutboxRow> = Schema.Struct({ id: Schema.String });

	static readonly principalSchema: Schema.Codec<PrincipalRow> = Schema.Struct({
		principalId: Schema.String,
	}).annotate({ title: "principal" });

	decodeRow(input: unknown) {
		return Schema.decodeUnknownEffect(this.rowSchema)(input);
	}
}
