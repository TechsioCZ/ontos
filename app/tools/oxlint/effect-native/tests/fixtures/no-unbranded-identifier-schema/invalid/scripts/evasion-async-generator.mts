// expect-count: 2
import { Schema } from 'effect';

const refine = (schema: unknown): never => schema as never;

// 1 — a field bag built inside an async generator body is still a contract.
export async function* rows(): AsyncGenerator<unknown> {
  yield Schema.Struct({ deploymentId: Schema.String, at: Schema.String });
}

// 2 — nine transparent refinements deep, still an unbranded string.
export const OntosActionIdSchema = Schema.String.check(refine)
  .check(refine)
  .check(refine)
  .check(refine)
  .check(refine)
  .check(refine)
  .check(refine)
  .annotate({});
