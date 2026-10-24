import { Effect, Schema } from 'effect';

const permissionEntryKey = Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)));

export type PermissionUniverseEntry = readonly [objectType: string, objectId: string, permission: string];

export class PermissionUniverseError extends Schema.TaggedError<PermissionUniverseError>()('PermissionUniverseError', {
  reason: Schema.String,
}) {}

/** Preserve the frozen baseline order; append new cases without dropping objects removed from the live graph. */
export const permissionUniverseUnion = Effect.fn('People.permissionUniverseUnion')(
  function* permissionUniverseUnionEffect(
    before: readonly PermissionUniverseEntry[],
    after: readonly PermissionUniverseEntry[],
  ) {
    const beforeEncoded = yield* Effect.all(before.map((entry) => permissionEntryKey(entry)));
    const afterEncoded = yield* Effect.all(after.map((entry) => permissionEntryKey(entry)));
    const beforeKeys = new Set(beforeEncoded);
    const afterKeys = new Set(afterEncoded);
    if (beforeKeys.size !== before.length || afterKeys.size !== after.length) {
      return yield* new PermissionUniverseError({ reason: 'Permission universes must contain unique exact cases' });
    }
    const added = after.filter((_, index) => !beforeKeys.has(afterEncoded[index]));
    const removed = before.filter((_, index) => !afterKeys.has(beforeEncoded[index]));
    return { added, entries: [...before, ...added], removed };
  },
);
