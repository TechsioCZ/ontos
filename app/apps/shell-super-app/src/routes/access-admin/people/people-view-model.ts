import { Schema } from 'effect';

import {
  AccessAssignmentIdSchema,
  AccessCapabilityKeySchema,
  AccessCompanyIdSchema,
  AccessDelegationIdSchema,
  AccessHumanIdSchema,
  AccessRoleIdSchema,
  AccessTeamIdSchema,
} from '../../../../shared/access-admin-api.ts';

const PeopleScopeChoiceSchema = Schema.Union([Schema.Literal('tenant'), AccessCompanyIdSchema]);

/** Serializable presentation only. Authority and available choices come from the governed BFF. */
export interface PeopleChoice {
  readonly id: string;
  readonly label: string;
}

export interface PeopleMembershipView {
  readonly expiryLabel: string | null;
  readonly id: string;
  readonly kind: 'member' | 'owner' | 'access_admin';
  readonly scope: string;
  readonly status: 'active' | 'suspended' | 'revoked';
}

export interface PeopleAssignmentView {
  readonly canRemove: boolean;
  readonly delegatedLimits: {
    readonly amount: string | null;
    readonly capabilities: readonly string[];
    readonly expiryLabel: string;
  } | null;
  readonly expiryLabel: string | null;
  readonly id: string;
  readonly role: string;
  readonly scope: string;
  readonly status: 'active' | 'revoked' | 'expired';
}

export interface PeopleDelegationView {
  readonly amount: string | null;
  readonly canRevoke: boolean;
  readonly capabilities: readonly string[];
  readonly expiryLabel: string;
  readonly id: string;
  readonly manager: string;
  readonly people: readonly string[];
  readonly roles: readonly string[];
  readonly scope: string;
  readonly status: 'active' | 'revoked' | 'expired';
}

export interface PeoplePersonView extends PeopleChoice {
  readonly assignments: readonly PeopleAssignmentView[];
  readonly delegations: readonly PeopleDelegationView[];
  readonly memberships: readonly PeopleMembershipView[];
  readonly soleOwnerScopes: readonly string[];
  readonly suspended: boolean;
  readonly teams: readonly (PeopleChoice & { readonly canRemove: boolean; readonly scope: string })[];
}

export interface PeopleScopeChoices extends PeopleChoice {
  readonly capabilities: readonly PeopleChoice[];
  readonly managers: readonly PeopleChoice[];
  readonly people: readonly PeopleChoice[];
  readonly roles: readonly PeopleChoice[];
  readonly teams: readonly PeopleChoice[];
}

export interface PeopleViewModel {
  readonly hasMore: boolean;
  readonly people: readonly PeoplePersonView[];
  readonly revision: string;
  readonly scopes: readonly PeopleScopeChoices[];
  readonly writes: {
    readonly assign: boolean;
    readonly delegate: boolean;
    readonly team: boolean;
  };
}

/** Raw form values, decoded into the BFF's branded ids and DateTime at the feature edge. */
export const PeopleCommandSchema = Schema.Union([
  Schema.Struct({
    expiryInput: Schema.String,
    kind: Schema.Literal('assign'),
    personId: AccessHumanIdSchema,
    roleId: AccessRoleIdSchema,
    scopeId: PeopleScopeChoiceSchema,
  }),
  Schema.Struct({ assignmentId: AccessAssignmentIdSchema, kind: Schema.Literal('remove-role') }),
  Schema.Struct({
    action: Schema.Literals(['join', 'leave']),
    kind: Schema.Literal('team'),
    personId: AccessHumanIdSchema,
    teamId: AccessTeamIdSchema,
  }),
  Schema.Struct({
    amountMinor: Schema.String,
    capabilities: Schema.Array(AccessCapabilityKeySchema),
    currency: Schema.String,
    expiryInput: Schema.String,
    kind: Schema.Literal('delegate'),
    managerId: AccessHumanIdSchema,
    people: Schema.Array(AccessHumanIdSchema),
    roles: Schema.Array(AccessRoleIdSchema),
    scopeId: PeopleScopeChoiceSchema,
  }),
  Schema.Struct({ delegationId: AccessDelegationIdSchema, kind: Schema.Literal('revoke-delegation') }),
]);
export type PeopleCommand = typeof PeopleCommandSchema.Encoded;
export const PeopleFeedbackSchema = Schema.Literals([
  'idle',
  'saving',
  'saved',
  'conflict',
  'forbidden',
  'unavailable',
  'unauthenticated',
  'invalid',
]);
export type PeopleFeedback = typeof PeopleFeedbackSchema.Type;
export const PeopleCommandIdentitySchema = Schema.fromJsonString(
  Schema.Struct({ command: Schema.toEncoded(PeopleCommandSchema), expectedRevision: Schema.String }),
);

export interface PeoplePendingChange {
  readonly command: PeopleCommand;
  readonly facts: readonly string[];
  readonly titleKey: string;
}
