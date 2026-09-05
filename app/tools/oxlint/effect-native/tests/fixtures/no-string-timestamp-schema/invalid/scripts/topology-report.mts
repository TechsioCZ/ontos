// expect-count: 2
import { Schema } from 'effect';

// 1 generatedAt in a script contract
export const ReportSchema = Schema.Struct({
  generatedAt: Schema.String,
  moduleCount: Schema.Number,
});

// 2 a script-local DTO interface
export interface ReportRow {
  readonly recordedAt: string;
  readonly total: number;
}
