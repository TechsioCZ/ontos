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

/** Restored objects have historical answers; a newly created identity must never get a fabricated old denial. */
export const classifyPrincipalPermissionCases = Effect.fn('People.classifyPrincipalPermissionCases')(
  function* classifyPrincipalPermissionCasesEffect(
    entries: readonly PermissionUniverseEntry[],
    archivedPrincipalIds: readonly string[],
  ) {
    const archived = new Set(archivedPrincipalIds);
    const restored: PermissionUniverseEntry[] = [];
    const postBaseline: PermissionUniverseEntry[] = [];
    for (const entry of entries) {
      if (entry[0] !== 'principal' || (entry[2] !== 'operate' && entry[2] !== 'manage_own_credentials')) {
        return yield* new PermissionUniverseError({
          reason: 'New non-principal permission cases require explicit policy review',
        });
      }
      (archived.has(entry[1]) ? restored : postBaseline).push(entry);
    }
    return { postBaseline, restored };
  },
);

/** An expectation check, not an authorization grant. Role holders must come from explicit current catalog evidence. */
export const validatePostBaselinePrincipalPermission = Effect.fn('People.validatePostBaselinePrincipalPermission')(
  function* validatePostBaselinePrincipalPermissionEffect(input: {
    readonly allowed: boolean;
    readonly permission: string;
    readonly resourcePrincipalId: string;
    readonly roleGrantedPrincipalIds: readonly string[];
    readonly subjectPrincipalId: string;
  }) {
    if (input.permission !== 'operate' && input.permission !== 'manage_own_credentials') {
      return yield* new PermissionUniverseError({ reason: 'Unsupported post-baseline principal permission' });
    }
    if (
      input.allowed &&
      input.subjectPrincipalId !== input.resourcePrincipalId &&
      !input.roleGrantedPrincipalIds.includes(input.subjectPrincipalId)
    ) {
      return yield* new PermissionUniverseError({ reason: 'Unexpected human authority on a post-baseline principal' });
    }
    return { currentPolicyExpectationMet: true, historicalAnswer: 'not_applicable' };
  },
);
