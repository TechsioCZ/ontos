import { v1 } from '@authzed/authzed-node';
import { Effect, Option, Result, Schema } from 'effect';

import type { PrincipalRef } from './principal-ref.ts';

const ScopedRoleScopeMismatch = Schema.TaggedError<Error>()('ScopedRoleScopeMismatch', {
  reason: Schema.String,
});

/** The business scope is part of role identity; labels never determine authority. */
export interface ScopedRoleIdentity {
  readonly legalEntityId?: string;
  readonly roleKey: string;
  readonly tenantId: string;
}

const RoleIdentityCodec = Schema.fromJsonString(
  Schema.Tuple([Schema.String, Schema.OptionFromNullOr(Schema.String), Schema.String]),
);
const encodeRoleIdentity = Schema.encodeResult(RoleIdentityCodec);
const decodeRoleIdentity = Schema.decodeUnknownResult(RoleIdentityCodec);

/** Lossless tuple encoding also distinguishes a tenant role from every company role. */
export const toScopedRoleObjectId = ({ legalEntityId, roleKey, tenantId }: ScopedRoleIdentity): string =>
  `sr_${Buffer.from(Result.getOrThrow(encodeRoleIdentity([tenantId, Option.fromNullishOr(legalEntityId), roleKey])), 'utf-8').toString('base64url')}`;

/** Rejects malformed and noncanonical graph IDs rather than guessing a role scope from its label. */
export const fromScopedRoleObjectId = (objectId: string): Option.Option<ScopedRoleIdentity> => {
  if (!objectId.startsWith('sr_')) {
    return Option.none();
  }
  const decoded = decodeRoleIdentity(Buffer.from(objectId.slice(3), 'base64url').toString('utf-8'));
  if (Result.isFailure(decoded)) {
    return Option.none();
  }
  const [tenantId, company, roleKey] = decoded.success;
  if (tenantId.length === 0 || roleKey.length === 0 || Option.exists(company, (companyId) => companyId.length === 0)) {
    return Option.none();
  }
  const role = Option.match(company, {
    onNone: () => ({ roleKey, tenantId }),
    onSome: (legalEntityId) => ({ legalEntityId, roleKey, tenantId }),
  });
  return toScopedRoleObjectId(role) === objectId ? Option.some(role) : Option.none();
};

/** Phase 1 agent policy uses one explicit role per principal and company. */
export const agentScopedRoleObjectId = (input: {
  readonly legalEntityId: string;
  readonly principalId: string;
  readonly tenantId: string;
}): string => toScopedRoleObjectId({ ...input, roleKey: `agent:${input.principalId}` });

/** Assignment is graph-native; choosing tenant scope is a separate, live capability check. */
export const buildScopedRoleMembershipUpdates = Effect.fn('ScopedRole.buildMembershipUpdates')(
  function* buildMembershipUpdates(input: {
    readonly operation: 'assign' | 'revoke';
    readonly principal: PrincipalRef;
    readonly role: ScopedRoleIdentity;
  }) {
    if (input.principal.tenantId !== input.role.tenantId) {
      return yield* new ScopedRoleScopeMismatch({ reason: 'A scoped role cannot contain a foreign-tenant principal' });
    }
    const roleId = toScopedRoleObjectId(input.role);
    const updates = [
      v1.RelationshipUpdate.create({
        operation:
          input.operation === 'assign' ? v1.RelationshipUpdate_Operation.TOUCH : v1.RelationshipUpdate_Operation.DELETE,
        relationship: {
          relation: 'member',
          resource: { objectId: roleId, objectType: 'scoped_role' },
          subject: { object: { objectId: input.principal.principalId, objectType: 'principal' } },
        },
      }),
    ];
    if (input.operation === 'assign' && input.role.legalEntityId === undefined) {
      updates.push(
        v1.RelationshipUpdate.create({
          operation: v1.RelationshipUpdate_Operation.TOUCH,
          relationship: {
            relation: 'context_role',
            resource: { objectId: input.role.tenantId, objectType: 'tenant' },
            subject: { object: { objectId: roleId, objectType: 'scoped_role' }, optionalRelation: 'member' },
          },
        }),
      );
    }
    // The tenant→role link belongs to the role, not one assignee. Revocation removes
    // only this member; deleting that link would revoke every other role member.
    return updates;
  },
);
