// Pathological syntax: decorators + class bodies must not crash the rule (no client here).
import { Effect } from 'effect';
import { ContactsClientTag } from './client-layer.ts';

function logged<T>(target: T): T {
  return target;
}

export class ContactsController {
  @logged
  list() {
    return Effect.gen(function* () {
      const client = yield* ContactsClientTag;
      return yield* client.customerList.list({});
    });
  }
}
