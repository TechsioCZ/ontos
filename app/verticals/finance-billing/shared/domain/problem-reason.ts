import { Schema } from 'effect';

/** The RFC 9457 fields every problem response carries, plus the optional machine code of action problems. */
export const ProblemReasonSchema = Schema.Struct({
  code: Schema.optionalKey(Schema.String),
  detail: Schema.String,
  status: Schema.Int,
});
export type ProblemReason = typeof ProblemReasonSchema.Type;
export const isProblemReason = Schema.is(ProblemReasonSchema);

/** The server's own explanation of a failed request: the problem detail with its HTTP status and code. */
export const formatProblemReason = (problem: ProblemReason): string => {
  const code = problem.code === undefined ? '' : `, ${problem.code}`;
  return `${problem.detail} (HTTP ${problem.status}${code})`;
};
