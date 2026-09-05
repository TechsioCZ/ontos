// expect-count: 4
// Evasion: async generator default parameter, getter, object method, computed key and an IIFE body.
import { Schema } from 'effect';

async function* stream(kinds = Schema.Literals(['insert', 'update', 'delete'])) {
  yield kinds;
}

const registry = {
  get changes() {
    return Schema.Literals(['delete', 'insert', 'update']);
  },
  build() {
    return Schema.Literals(['update', 'delete', 'insert']);
  },
  ['computed']: Schema.Literals(['insert', 'delete', 'update']),
};

export const eager = (() => Schema.Literals(['delete', 'update', 'insert']))();
export { registry, stream };
