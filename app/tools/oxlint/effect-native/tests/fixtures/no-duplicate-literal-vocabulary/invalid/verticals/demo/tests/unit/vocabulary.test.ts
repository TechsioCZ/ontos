// expect-count: 1
// Tests are in scope by default (`ignoreTests: false`).
import * as Schema from 'effect/Schema';

const request = Schema.Struct({ state: Schema.Literals(['queued', 'running', 'done']) });
const response = Schema.Struct({ state: Schema.Literals(['done', 'queued', 'running']) });

export const contract = Schema.Struct({ request, response });
