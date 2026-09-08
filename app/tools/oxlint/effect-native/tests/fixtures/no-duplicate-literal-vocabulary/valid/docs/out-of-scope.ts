// Outside `include` (apps/**, verticals/**, packages/**, scripts/**): never reported.
import { Schema } from 'effect';

export const first = Schema.Literals(['alpha', 'beta']);
export const second = Schema.Literals(['alpha', 'beta']);
