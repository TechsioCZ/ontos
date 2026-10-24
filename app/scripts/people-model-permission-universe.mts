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

/** Object identity, not its type or permission name, determines whether a historical answer exists. */
export const classifyPermissionCases = Effect.fn('People.classifyPermissionCases')(
  function* classifyPermissionCasesEffect(
    entries: readonly PermissionUniverseEntry[],
    archivedObjects: readonly (readonly [objectType: string, objectId: string])[],
  ) {
    const archived = new Set(yield* Effect.all(archivedObjects.map((object) => permissionEntryKey(object))));
    const restored: PermissionUniverseEntry[] = [];
    const postBaseline: PermissionUniverseEntry[] = [];
    for (const entry of entries) {
      const objectKey = yield* permissionEntryKey(entry.slice(0, 2));
      (archived.has(objectKey) ? restored : postBaseline).push(entry);
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

/** Exact self-service resources have no role override: only their own customer may use them. */
export const validatePostBaselineSelfServicePermission = Effect.fn('People.validatePostBaselineSelfServicePermission')(
  function* validatePostBaselineSelfServicePermissionEffect(input: {
    readonly allowed: boolean;
    readonly permission: string;
    readonly selfServiceGranteePrincipalId: string;
    readonly subjectPrincipalId: string;
  }) {
    if (
      !['use', 'direct_use', 'role_use'].includes(input.permission) ||
      input.selfServiceGranteePrincipalId.length === 0
    ) {
      return yield* new PermissionUniverseError({ reason: 'Unsupported post-baseline self-service permission policy' });
    }
    const expected = input.permission === 'use' && input.subjectPrincipalId === input.selfServiceGranteePrincipalId;
    if (input.allowed !== expected) {
      return yield* new PermissionUniverseError({
        reason: 'Post-baseline self-service authority differs from its exact customer grant',
      });
    }
    return { currentPolicyExpectationMet: true, historicalAnswer: 'not_applicable' };
  },
);
