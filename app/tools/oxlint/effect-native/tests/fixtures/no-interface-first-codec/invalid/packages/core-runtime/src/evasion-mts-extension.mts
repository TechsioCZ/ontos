// expect-count: 1
import { Schema } from "effect";

export interface MtsRow {
	readonly id: string;
}

export const mtsRowSchema: Schema.Codec<MtsRow> = Schema.Struct({ id: Schema.String });
