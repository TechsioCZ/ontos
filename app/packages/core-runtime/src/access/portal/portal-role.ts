import { Result, Schema } from 'effect';

import { AccessDeclarationError } from '../../authorization/access-declaration-error.ts';
import { CapabilityKeySchema, ModuleKeySchema, RoleTemplateKeySchema } from '../ids.ts';

/*
 * A portal role is the fixed role a module declares for the external people its portal serves: a retail
 * customer, a counterparty's buyer, a person who is about to claim an invitation. Everyone who logs in gets
 * rights only from roles, so such a person gets exactly this one, and only while the module's own grant for
 * them is live: the module tells Core when that grant becomes ACTIVE or ends, and Core writes the membership
 * and the assignment (`portal-access.ts`). The module's owner rule still narrows every record (O70).
 *
 * The declaration is data the module owns, next to the declarations of its capabilities: a key in the
 * module's own namespace, the name people see in Lidé and Role, and the capabilities the role holds. A
 * module can only declare its own capabilities, so a portal role never grants another module's work. Core
 * compiles it once per tenant against the newest release that publishes every one of those capabilities,
 * with the run mode only, and keeps the role it compiled: a later declaration change never widens a role
 * somebody already holds (guarantee 2).
 */

const PortalRoleNameSchema = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200), Schema.isTrimmed());

export const AccessPortalRoleSchema = Schema.Struct({
  /** Every capability the role holds, each declared by the role's own module; at least one, never repeated. */
  capabilities: Schema.NonEmptyArray(CapabilityKeySchema).check(Schema.isUnique()),
  /** `<moduleKey>.<role>`: the role's template key, and with the tenant the identity of its role. */
  key: RoleTemplateKeySchema,
  /** The module that declares the role and owns every capability it names. */
  moduleKey: ModuleKeySchema,
  /** The label people see; never a technical key. */
  name: PortalRoleNameSchema,
});
export type AccessPortalRole = typeof AccessPortalRoleSchema.Type;
export type AccessPortalRoleInput = typeof AccessPortalRoleSchema.Encoded;

const decodePortalRoleFields = Schema.decodeUnknownResult(AccessPortalRoleSchema, { onExcessProperty: 'error' });

const invalidPortalRole = (reason: string): AccessDeclarationError =>
  new AccessDeclarationError({ code: 'access_declaration_invalid', reason: `accessPortalRole: ${reason}` });

/** Why a decoded role names something outside its own module, if it does. */
const foreignPortalRoleIssue = (role: AccessPortalRole): string | undefined => {
  const prefix = `${role.moduleKey}.`;
  if (!role.key.startsWith(prefix) || role.key.length === prefix.length) {
    return `${role.key} is not a role of module ${role.moduleKey}`;
  }
  const foreign = role.capabilities.find((capability) => !capability.startsWith(prefix));
  return foreign === undefined ? undefined : `${foreign} is not a capability of module ${role.moduleKey}`;
};

/** Non-throwing decoder: the role is decoded, kept inside its own module and frozen. */
export const decodeAccessPortalRole = <Input>(input: Input): Result.Result<AccessPortalRole, AccessDeclarationError> =>
  decodePortalRoleFields(input).pipe(
    Result.mapError((issue) => invalidPortalRole(issue.message)),
    Result.flatMap((role) => {
      const foreign = foreignPortalRoleIssue(role);
      return foreign === undefined
        ? Result.succeed(
            Object.freeze({
              capabilities: Object.freeze([...role.capabilities] as const),
              key: role.key,
              moduleKey: role.moduleKey,
              name: role.name,
            }),
          )
        : Result.fail(invalidPortalRole(foreign));
    }),
  );

/** Definition-time declaration of a portal role: an invalid one is a definition error, never a runtime gap. */
export const defineAccessPortalRole = (input: AccessPortalRoleInput): AccessPortalRole =>
  Result.getOrThrow(decodeAccessPortalRole(input));
