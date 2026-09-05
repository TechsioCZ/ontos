import { Schema } from "some-other-library";

export interface Row {
	readonly id: string;
}

export const rowSchema: Schema.Codec<Row> = Schema.Struct({ id: Schema.String });
