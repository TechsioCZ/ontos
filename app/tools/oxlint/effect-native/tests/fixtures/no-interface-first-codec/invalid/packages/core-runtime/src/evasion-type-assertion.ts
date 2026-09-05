// expect-count: 1
import { Schema } from "effect";

export interface AuditRow {
	readonly id: string;
}

// angle-bracket type assertion: the same cast the rule reports as `as Schema.Codec<AuditRow>`.
export const AuditRowSchema = <Schema.Codec<AuditRow>>Schema.Struct({ id: Schema.String });
