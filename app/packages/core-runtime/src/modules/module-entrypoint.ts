import { Schema } from 'effect';
import {
  EntrypointAuthorizationSchema,
  decodeEntrypointAuthorization,
} from '../authorization/entrypoint-classification.ts';
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
export const MODULE_ENTRYPOINT_ACCESSES = [
  'read',
  'historical_read',
  'write',
  'background',
] as const;
export const MODULE_ENTRYPOINT_SCOPES = ['tenant', 'system'] as const;

export const ModuleEntrypointRoleSchema = Schema.Literals(MODULE_ENTRYPOINT_ROLES);
export const ModuleEntrypointAccessSchema = Schema.Literals(MODULE_ENTRYPOINT_ACCESSES);
export const ModuleEntrypointScopeSchema = Schema.Literals(MODULE_ENTRYPOINT_SCOPES);
export type ModuleEntrypointRole = Schema.Schema.Type<typeof ModuleEntrypointRoleSchema>;
export type ModuleEntrypointAccess = Schema.Schema.Type<typeof ModuleEntrypointAccessSchema>;
export type ModuleEntrypointScope = Schema.Schema.Type<typeof ModuleEntrypointScopeSchema>;

const stableKeySchema = Schema.String.check(
  Schema.isMinLength(3),
  Schema.isMaxLength(200),
  Schema.isPattern(/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u),
);

export const ModuleEntrypointSchema = Schema.Struct({
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

const roleAllowsAccess = (role: ModuleEntrypointRole, access: ModuleEntrypointAccess): boolean => {
  switch (role) {
    case 'action': {
      return access === 'write';
    }
    case 'worker': {
      return access === 'background';
    }
    case 'api':
    case 'report': {
      return access === 'read' || access === 'historical_read' || access === 'write';
    }
    case 'page':
    case 'public_component':
    case 'search': {
      return access === 'read' || access === 'historical_read';
    }
    default: {
      return role;
    }
  }
};

const roleAllowsAuthorization = (
  role: ModuleEntrypointRole,
  authorization: EntrypointAuthorization,
): boolean => {
  if (role === 'action') {
    return authorization.kind === 'action_execution';
  }
  if (role === 'worker') {
    return authorization.kind === 'owner_local_background';
  }
  if (
    authorization.kind === 'action_execution' ||
    authorization.kind === 'owner_local_background'
  ) {
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
    authorization: decodeEntrypointAuthorization(input.authorization),
    scope,
  };
  try {
    Schema.decodeUnknownSync(ModuleEntrypointSchema, { onExcessProperty: 'error' })(descriptor);
  } catch {
    throw new TypeError('Module entrypoint identity is invalid');
  }
  if (!roleAllowsAccess(descriptor.role, descriptor.access)) {
    throw new TypeError('Module entrypoint role and access are inconsistent');
  }
  if (!roleAllowsAuthorization(descriptor.role, descriptor.authorization)) {
    throw new TypeError('Module entrypoint role and authorization are inconsistent');
  }
  return Object.freeze(descriptor);
};

export const decodeTenantModuleEntrypoint = <Input>(input: Input): TenantModuleEntrypoint => {
  let descriptor: Schema.Schema.Type<typeof ModuleEntrypointSchema>;
  try {
    descriptor = Schema.decodeUnknownSync(ModuleEntrypointSchema, { onExcessProperty: 'error' })({
      ...input,
      scope: 'tenant',
    });
  } catch {
    throw new TypeError('Module entrypoint identity is invalid');
  }
  if (
    descriptor.scope !== 'tenant' ||
    !roleAllowsAccess(descriptor.role, descriptor.access) ||
    !roleAllowsAuthorization(descriptor.role, descriptor.authorization)
  ) {
    throw new TypeError('Module entrypoint role and access are inconsistent');
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
