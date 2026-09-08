// A test file that reuses one named vocabulary must stay silent.
import { Schema } from 'effect';

const RunState = Schema.Literals(['queued', 'running', 'done']);

export const Fixture = Schema.Struct({ before: RunState, after: RunState });
export const Expectation = Schema.Struct({ state: RunState });
