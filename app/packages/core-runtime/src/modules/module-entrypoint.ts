import { Match, Result, Schema } from 'effect';
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
).pipe(Schema.brand('StableKey'));

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

const roleAllowsAccess = (role: ModuleEntrypointRole, access: ModuleEntrypointAccess): boolean =>
  Match.value(role).pipe(
    Match.when('action', () => access === 'write'),
    Match.when('worker', () => access === 'background'),
    Match.whenOr(
      'api',
      'report',
      () => access === 'read' || access === 'historical_read' || access === 'write',
    ),
    Match.whenOr(
      'page',
      'public_component',
      'search',
      () => access === 'read' || access === 'historical_read',
    ),
    Match.exhaustive,
  );

const ModuleEntrypointInvariantError = Schema.TaggedError<Error>()(
  'ModuleEntrypointInvariantError',
  { message: Schema.String },
);

const failModuleEntrypointInvariant = (message: string): never => {
  throw new ModuleEntrypointInvariantError({ message });
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
    scope,
  };
  const validatedDescriptor = Result.getOrThrow(
    Schema.decodeUnknownResult(ModuleEntrypointSchema, { onExcessProperty: 'error' })(descriptor),
  );
  if (!roleAllowsAccess(validatedDescriptor.role, validatedDescriptor.access)) {
    return failModuleEntrypointInvariant('Module entrypoint role and access are inconsistent');
  }
  if (!roleAllowsAuthorization(validatedDescriptor.role, validatedDescriptor.authorization)) {
    return failModuleEntrypointInvariant(
      'Module entrypoint role and authorization are inconsistent',
    );
  }
  return Object.freeze({
    ...descriptor,
    authorization: Object.freeze(validatedDescriptor.authorization),
  });
};

export const decodeTenantModuleEntrypoint = <Input>(input: Input): TenantModuleEntrypoint => {
  const descriptor = Result.getOrThrow(
    Schema.decodeUnknownResult(ModuleEntrypointSchema, { onExcessProperty: 'error' })({
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
