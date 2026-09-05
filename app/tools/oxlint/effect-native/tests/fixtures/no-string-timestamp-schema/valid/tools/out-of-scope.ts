import { Schema } from 'effect';

// `tools/**` is outside the rule's `include` scope.
export const ToolSchema = Schema.Struct({
  createdAt: Schema.String,
  generatedAt: Schema.String,
});

export interface ToolRow {
  readonly createdAt: string;
}
