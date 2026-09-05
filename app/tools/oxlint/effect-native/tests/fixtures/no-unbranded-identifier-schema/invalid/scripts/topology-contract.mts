// expect-count: 2
import { Schema } from 'effect';

// 1
export const OntosModuleIdSchema = Schema.String.check(Schema.isPattern(/^[a-z.]+$/u));

// 2 — script-scoped contract field bag.
export const RolloutSchema = Schema.Struct({
  deploymentId: Schema.String,
  enabled: Schema.Boolean,
});
