import {
  exhaustive as matchExhaustive,
  value as matchValue,
  when as matchWhen,
  whenOr as matchWhenOr,
} from 'effect/Match';
import { getOrThrow as getResultOrThrow } from 'effect/Result';
import {
  Literals,
  String as StringSchema,
  Struct,
  TaggedError,
  brand,
  decodeUnknownResult,
  isMaxLength,
  isMinLength,
  isPattern,
} from 'effect/Schema';
import type { Schema } from 'effect/Schema';

import { EntrypointAuthorizationSchema } from '../authorization/entrypoint-classification.ts';
import type { EntrypointAuthorization } from '../authorization/entrypoint-classification.ts';

export const MODULE_ENTRYPOINT_ROLES = [
  'action',
  'page',
  'public_component',
  'api',
  'search',
  'report',
  'worker',
] as const;
export const MODULE_ENTRYPOINT_ACCESSES = ['read', 'historical_read', 'write', 'background'] as const;
export const MODULE_ENTRYPOINT_SCOPES = ['tenant', 'system'] as const;

export const ModuleEntrypointRoleSchema = Literals(MODULE_ENTRYPOINT_ROLES);
export const ModuleEntrypointAccessSchema = Literals(MODULE_ENTRYPOINT_ACCESSES);
export const ModuleEntrypointScopeSchema = Literals(MODULE_ENTRYPOINT_SCOPES);
export type ModuleEntrypointRole = Schema.Type<typeof ModuleEntrypointRoleSchema>;
export type ModuleEntrypointAccess = Schema.Type<typeof ModuleEntrypointAccessSchema>;
export type ModuleEntrypointScope = Schema.Type<typeof ModuleEntrypointScopeSchema>;

const stableKeySchema = StringSchema.check(
  isMinLength(3),
  isMaxLength(200),
  isPattern(/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u),
).pipe(brand('StableKey'));

export const ModuleEntrypointSchema = Struct({
  access: ModuleEntrypointAccessSchema,
  authorization: EntrypointAuthorizationSchema,
  entrypointKey: stableKeySchema,
  moduleKey: stableKeySchema,
  role: ModuleEntrypointRoleSchema,
  scope: ModuleEntrypointScopeSchema,
});

export type EntrypointAccessForRole<Role extends ModuleEntrypointRole> = Role extends 'action'
  ? 'write'
  : Role extends 'worker'
    ? 'background'
    : Role extends 'api' | 'report'
      ? 'historical_read' | 'read' | 'write'
      : 'historical_read' | 'read';

export interface ModuleEntrypointDescriptor<
  Role extends ModuleEntrypointRole = ModuleEntrypointRole,
  Access extends ModuleEntrypointAccess = ModuleEntrypointAccess,
  ModuleKey extends string = string,
  Scope extends ModuleEntrypointScope = ModuleEntrypointScope,
> {
  readonly access: Access;
  readonly authorization: EntrypointAuthorization;
  readonly entrypointKey: string;
  readonly moduleKey: ModuleKey;
  readonly role: Role;
  readonly scope: Scope;
}

export type TenantModuleEntrypoint<
  Role extends ModuleEntrypointRole = ModuleEntrypointRole,
  Access extends ModuleEntrypointAccess = ModuleEntrypointAccess,
  ModuleKey extends string = string,
> = ModuleEntrypointDescriptor<Role, Access, ModuleKey, 'tenant'>;

export type SystemModuleEntrypoint<
  Role extends ModuleEntrypointRole = ModuleEntrypointRole,
  Access extends ModuleEntrypointAccess = ModuleEntrypointAccess,
  ModuleKey extends string = string,
> = ModuleEntrypointDescriptor<Role, Access, ModuleKey, 'system'>;

const roleAllowsAccess = (role: ModuleEntrypointRole, access: ModuleEntrypointAccess): boolean =>
  matchValue(role).pipe(
    matchWhen('action', () => access === 'write'),
    matchWhen('worker', () => access === 'background'),
    matchWhenOr('api', 'report', () => access === 'read' || access === 'historical_read' || access === 'write'),
    matchWhenOr('page', 'public_component', 'search', () => access === 'read' || access === 'historical_read'),
    matchExhaustive,
  );

const ModuleEntrypointInvariantError = TaggedError<Error>()('ModuleEntrypointInvariantError', {
  message: StringSchema,
});

const failModuleEntrypointInvariant = (message: string): never => {
  throw new ModuleEntrypointInvariantError({ message });
};

const roleAllowsAuthorization = (role: ModuleEntrypointRole, authorization: EntrypointAuthorization): boolean => {
  if (role === 'action') {
    return authorization.kind === 'action_execution';
  }
  if (role === 'worker') {
    return authorization.kind === 'owner_local_background';
  }
  if (authorization.kind === 'action_execution' || authorization.kind === 'owner_local_background') {
    return false;
  }
  return authorization.kind !== 'capability_issuance' || role === 'api';
};

const defineEntrypoint = <
  const Role extends ModuleEntrypointRole,
  const Access extends EntrypointAccessForRole<Role>,
  const ModuleKey extends string,
  const Scope extends ModuleEntrypointScope,
>(
  input: Omit<ModuleEntrypointDescriptor<Role, Access, ModuleKey, Scope>, 'scope'>,
  scope: Scope,
): ModuleEntrypointDescriptor<Role, Access, ModuleKey, Scope> => {
  const descriptor: ModuleEntrypointDescriptor<Role, Access, ModuleKey, Scope> = {
    ...input,
    scope,
  };
  const validatedDescriptor = getResultOrThrow(
    decodeUnknownResult(ModuleEntrypointSchema, {
      onExcessProperty: 'error',
    })(descriptor),
  );
  if (!roleAllowsAccess(validatedDescriptor.role, validatedDescriptor.access)) {
    return failModuleEntrypointInvariant('Module entrypoint role and access are inconsistent');
  }
  if (!roleAllowsAuthorization(validatedDescriptor.role, validatedDescriptor.authorization)) {
    return failModuleEntrypointInvariant('Module entrypoint role and authorization are inconsistent');
  }
  return Object.freeze({
    ...descriptor,
    authorization: Object.freeze(validatedDescriptor.authorization),
  });
};

export const decodeTenantModuleEntrypoint = <Input>(input: Input): TenantModuleEntrypoint => {
  const descriptor = getResultOrThrow(
    decodeUnknownResult(ModuleEntrypointSchema, {
      onExcessProperty: 'error',
    })({
      ...input,
      scope: 'tenant',
    }),
  );
  if (
    descriptor.scope !== 'tenant' ||
    !roleAllowsAccess(descriptor.role, descriptor.access) ||
    !roleAllowsAuthorization(descriptor.role, descriptor.authorization)
  ) {
    return failModuleEntrypointInvariant('Module entrypoint role and access are inconsistent');
  }
  return Object.freeze({
    access: descriptor.access,
    authorization: Object.freeze(descriptor.authorization),
    entrypointKey: descriptor.entrypointKey,
    moduleKey: descriptor.moduleKey,
    role: descriptor.role,
    scope: 'tenant',
  });
};

export const defineTenantModuleEntrypoint = <
  const Role extends ModuleEntrypointRole,
  const Access extends EntrypointAccessForRole<Role>,
  const ModuleKey extends string,
>(
  input: Omit<TenantModuleEntrypoint<Role, Access, ModuleKey>, 'scope'>,
): TenantModuleEntrypoint<Role, Access, ModuleKey> => defineEntrypoint(input, 'tenant');

export const defineSystemModuleEntrypoint = <
  const Role extends ModuleEntrypointRole,
  const Access extends EntrypointAccessForRole<Role>,
  const ModuleKey extends string,
>(
  input: Omit<SystemModuleEntrypoint<Role, Access, ModuleKey>, 'scope'>,
): SystemModuleEntrypoint<Role, Access, ModuleKey> => defineEntrypoint(input, 'system');
