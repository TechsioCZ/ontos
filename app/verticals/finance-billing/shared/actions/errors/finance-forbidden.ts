import { Schema } from 'effect';

/**
 * The caller may not read something the command needs from another owner (a permission it lacks), as opposed to that
 * owner being unreachable. `reason` is a code the screen explains.
 */
export class FinanceForbidden extends Schema.TaggedError<FinanceForbidden>()('FinanceForbidden', {
  code: Schema.Literal('finance_forbidden'),
  reason: Schema.String,
}) {}
