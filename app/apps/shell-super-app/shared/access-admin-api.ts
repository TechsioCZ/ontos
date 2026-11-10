import { makeProblemDetailsSchema, makeRetryableProblemDetailsSchema } from '@app/shared-contracts/problem-details';
import { HttpApi, HttpApiEndpoint, HttpApiGroup, Schema } from '@modern-js/bff-effect/effect-client';

/**
 * Tenant-context administration contract. The BFF derives tenant, acting human, clock and
 * administration authority from the authenticated operational scope; none are request fields.
 * A legalEntityId in a command identifies the company being managed, NOT a selected company.
 * Every handler independently decides its own shell-super-app.access-* entrypoint through the Core gate.
 */
const uuid = Schema.String.check(Schema.isUUID());
const text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200));
const digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
export const AccessRoleIdSchema = uuid.pipe(Schema.brand('AccessRoleId'));
export const AccessRoleRevisionIdSchema = uuid.pipe(Schema.brand('AccessRoleRevisionId'));
export const AccessCatalogSnapshotIdSchema = uuid.pipe(Schema.brand('AccessCatalogSnapshotId'));
export const AccessAssignmentIdSchema = uuid.pipe(Schema.brand('AccessAssignmentIncarnationId'));
export const AccessDelegationIdSchema = uuid.pipe(Schema.brand('AccessDelegationId'));
export const AccessChangeItemIdSchema = uuid.pipe(Schema.brand('AccessChangeItemId'));
export const AccessChangeDecisionIdSchema = uuid.pipe(Schema.brand('AccessChangeDecisionId'));
export const AccessProposalIdSchema = uuid.pipe(Schema.brand('AccessProposalId'));
export const AccessHumanIdSchema = uuid.pipe(Schema.brand('AccessHumanPrincipalId'));
export const AccessCompanyIdSchema = uuid.pipe(Schema.brand('AccessLegalEntityId'));
/** Explicit null selects tenant authority; a company id selects only that company's roles. */
export const AccessCompanyTargetSchema = Schema.Union([Schema.Null, AccessCompanyIdSchema]);
export const AccessScopeIdSchema = uuid.pipe(Schema.brand('AccessScopeId'));
export const AccessCapabilityKeySchema = Schema.String.check(
  Schema.isMaxLength(200),
  Schema.isPattern(/^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*(?:\.[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*){2,}$/u),
).pipe(Schema.brand('AccessCapabilityKey'));
export const AccessRecordKeySchema = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500)).pipe(
  Schema.brand('AccessRecordKey'),
);
export const AccessAgentIdSchema = uuid.pipe(Schema.brand('AccessAgentId'));
export const AccessTemplateKeySchema = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120)).pipe(
  Schema.brand('AccessRoleTemplateKey'),
);
export const AccessModuleKeySchema = Schema.String.check(
  Schema.isMaxLength(120),
  Schema.isPattern(/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u),
).pipe(Schema.brand('AccessModuleKey'));
export const AccessActionKeySchema = Schema.String.check(Schema.isMinLength(3), Schema.isMaxLength(200)).pipe(
  Schema.brand('AccessActionKey'),
);
const accessMode = Schema.Literals(['run', 'propose', 'approve']);
const accessRisk = Schema.Literals(['routine', 'sensitive', 'critical']);
const lifecycleStatus = Schema.Literals(['active', 'revoked', 'expired']);
const changePreviewDecision = Schema.Literals(['adopt', 'undo']);
const approvalStatus = Schema.Literals(['pending', 'approved', 'executed', 'rejected', 'lapsed', 'expired']);
export const AccessIdempotencyHeadersSchema = Schema.Struct({
  'idempotency-key': Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
});
export const AccessPageSchema = Schema.Struct({
  cursor: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500))),
  limit: Schema.Int.check(Schema.isBetween({ maximum: 100, minimum: 1 })),
});
export const AccessScopeTargetSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('tenant') }),
  Schema.Struct({ kind: Schema.Literal('company'), legalEntityId: AccessCompanyIdSchema }),
]);
export const AccessCellSchema = Schema.Struct({
  amountCeiling: Schema.optionalKey(
    Schema.Struct({
      currency: Schema.String.check(Schema.isPattern(/^[A-Z]{3}$/u)),
      limitMinor: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    }),
  ),
  capabilityKey: AccessCapabilityKeySchema,
  mode: accessMode,
  selector: Schema.Union([
    Schema.Union([
      Schema.TaggedStruct('all', {}),
      Schema.TaggedStruct('assigned', {}),
      Schema.TaggedStruct('entrusted', {}),
      Schema.TaggedStruct('team', {}),
    ]),
    Schema.TaggedStruct('targets', { recordKeys: Schema.NonEmptyArray(AccessRecordKeySchema) }),
  ]),
});
const revision = Schema.Int.check(Schema.isGreaterThan(0));
const date = Schema.DateTimeUtcFromString;
export const AccessRoleSchema = Schema.Struct({
  catalogSnapshotId: AccessCatalogSnapshotIdSchema,
  cells: Schema.Array(AccessCellSchema),
  holderCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  id: AccessRoleIdSchema,
  legalEntityId: Schema.optionalKey(AccessCompanyIdSchema),
  name: text,
  provenance: Schema.Literals(['template', 'customer_changed', 'manual', 'imported']),
  revision,
  revisionId: AccessRoleRevisionIdSchema,
  scope: Schema.Literals(['tenant', 'company']),
  templateKey: Schema.optionalKey(AccessTemplateKeySchema),
});
const paged = <A extends Schema.Top>(item: A) =>
  Schema.Struct({ items: Schema.Array(item), nextCursor: Schema.Union([Schema.Null, Schema.String]) });
const previewToken = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500));
const namedEffect = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500));

export const ACCESS_ADMIN_HTTP_STATUS = {
  authenticationRequired: 401,
  conflict: 409,
  forbidden: 403,
  internal: 500,
  invalidRequest: 400,
  unavailable: 503,
  unprocessable: 422,
} as const;
export const AccessAdminAuthenticationRequiredProblemSchema = makeProblemDetailsSchema(
  'AccessAdminAuthenticationRequired',
  ACCESS_ADMIN_HTTP_STATUS.authenticationRequired,
);
export const AccessAdminForbiddenProblemSchema = makeProblemDetailsSchema(
  'AccessAdminForbidden',
  ACCESS_ADMIN_HTTP_STATUS.forbidden,
);
export const AccessAdminConflictProblemSchema = makeProblemDetailsSchema(
  'AccessAdminConflict',
  ACCESS_ADMIN_HTTP_STATUS.conflict,
);
export const AccessAdminUnprocessableProblemSchema = makeProblemDetailsSchema(
  'AccessAdminUnprocessable',
  ACCESS_ADMIN_HTTP_STATUS.unprocessable,
);
export const AccessAdminUnavailableProblemSchema = makeRetryableProblemDetailsSchema(
  'AccessAdminUnavailable',
  ACCESS_ADMIN_HTTP_STATUS.unavailable,
);
export const AccessAdminInvalidRequestProblemSchema = makeProblemDetailsSchema(
  'AccessAdminInvalidRequest',
  ACCESS_ADMIN_HTTP_STATUS.invalidRequest,
);
export const AccessAdminInternalProblemSchema = makeProblemDetailsSchema(
  'AccessAdminInternal',
  ACCESS_ADMIN_HTTP_STATUS.internal,
);
/** DENIED and NEEDS_APPROVAL are 403; stale revisions, preview tokens and fence conflicts are 409. */
export const accessAdminErrors = [
  AccessAdminInvalidRequestProblemSchema,
  AccessAdminAuthenticationRequiredProblemSchema,
  AccessAdminForbiddenProblemSchema,
  AccessAdminConflictProblemSchema,
  AccessAdminUnprocessableProblemSchema,
  AccessAdminUnavailableProblemSchema,
  AccessAdminInternalProblemSchema,
] as const;
export type AccessAdminProblem =
  | typeof AccessAdminInvalidRequestProblemSchema.Type
  | typeof AccessAdminAuthenticationRequiredProblemSchema.Type
  | typeof AccessAdminForbiddenProblemSchema.Type
  | typeof AccessAdminConflictProblemSchema.Type
  | typeof AccessAdminUnprocessableProblemSchema.Type
  | typeof AccessAdminUnavailableProblemSchema.Type
  | typeof AccessAdminInternalProblemSchema.Type;

export const ListAccessRolesResponseSchema = paged(AccessRoleSchema);
export const GetAccessRolePayloadSchema = Schema.Struct({ roleId: AccessRoleIdSchema });
export const AccessAffectedHolderSchema = Schema.Struct({
  assignmentIncarnationId: AccessAssignmentIdSchema,
  holder: Schema.Union([
    Schema.TaggedStruct('Principal', { principalId: AccessHumanIdSchema }),
    Schema.TaggedStruct('Agent', { agentId: AccessAgentIdSchema }),
  ]),
  roleId: AccessRoleIdSchema,
});
export const GetAccessRoleResponseSchema = Schema.Struct({
  holderCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  holders: Schema.Array(AccessAffectedHolderSchema),
  role: AccessRoleSchema,
});
export const AccessCatalogEntrySchema = Schema.Struct({
  amountInput: Schema.optionalKey(text),
  capabilityKey: AccessCapabilityKeySchema,
  fieldClass: Schema.optionalKey(text),
  kind: Schema.Literals(['action', 'read', 'field_read', 'field_write', 'export', 'admin']),
  modes: Schema.NonEmptyArray(accessMode),
  moduleKey: AccessModuleKeySchema,
  placement: Schema.Struct({ group: text, level: Schema.Literals(['basic', 'extended', 'manage']) }),
  risk: accessRisk,
  selectors: Schema.Array(Schema.Literals(['all', 'assigned', 'entrusted', 'team'])),
});
export const AccessRoleTemplateSchema = Schema.Struct({
  catalogSnapshotId: AccessCatalogSnapshotIdSchema,
  cells: Schema.Array(AccessCellSchema),
  name: text,
  source: Schema.Literals(['catalog_full_access', 'blank', 'copy_role']),
  sourceRoleId: Schema.optionalKey(AccessRoleIdSchema),
  templateKey: AccessTemplateKeySchema,
});
export const ListAccessRoleTemplatesResponseSchema = Schema.Struct({
  catalogSnapshotId: AccessCatalogSnapshotIdSchema,
  entries: Schema.Array(AccessCatalogEntrySchema),
  publishedAt: date,
  templates: Schema.Array(AccessRoleTemplateSchema),
  // Saving an edit and creating a role are separate capabilities, so each control has its own answer.
  createAvailable: Schema.Boolean,
  createUnavailableReason: Schema.optionalKey(text),
  saveAvailable: Schema.Boolean,
  saveUnavailableReason: Schema.optionalKey(text),
});
export const AccessRoleEditPayloadSchema = Schema.Struct({
  catalogSnapshotId: AccessCatalogSnapshotIdSchema,
  cells: Schema.Array(AccessCellSchema),
  expectedRoleRevisionId: AccessRoleRevisionIdSchema,
  roleId: AccessRoleIdSchema,
});
export const AccessDangerousEffectSchema = Schema.Struct({
  capabilityKey: AccessCapabilityKeySchema,
  effect: text,
  mode: accessMode,
  risk: accessRisk,
  slot: text,
});
export const PreviewAccessRoleEditResponseSchema = Schema.Struct({
  added: Schema.Array(AccessCellSchema),
  affectedAgentCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  affectedHolders: Schema.Array(AccessAffectedHolderSchema),
  affectedHumanCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  cells: Schema.Array(AccessCellSchema),
  changes: Schema.Boolean,
  dangerous: Schema.Array(AccessDangerousEffectSchema),
  previewToken,
  removed: Schema.Array(AccessCellSchema),
  requiresNamedEffect: Schema.Boolean,
});
export const SaveAccessRoleEditPayloadSchema = Schema.Struct({
  ...AccessRoleEditPayloadSchema.fields,
  confirmedEffects: Schema.Array(Schema.Struct({ effect: text, slot: text })),
  previewToken,
});
export const CreateAccessRolePayloadSchema = Schema.Struct({
  catalogSnapshotId: AccessCatalogSnapshotIdSchema,
  cells: Schema.Array(AccessCellSchema),
  name: text,
  scope: AccessScopeTargetSchema,
  templateKey: AccessRoleTemplateSchema.fields.templateKey,
});
export const SaveAccessRoleEditResponseSchema = Schema.Struct({
  added: Schema.Array(AccessCellSchema),
  affectedHolderCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  removed: Schema.Array(AccessCellSchema),
  role: AccessRoleSchema,
});
export const accessAdminRolesGroup = HttpApiGroup.make('accessAdminRoles')
  .add(
    HttpApiEndpoint.post('listAccessRoles', '/shell/access/roles/list', {
      error: accessAdminErrors,
      payload: AccessPageSchema,
      success: ListAccessRolesResponseSchema,
    }),
  )
  .add(
    HttpApiEndpoint.post('getAccessRole', '/shell/access/roles/detail', {
      error: accessAdminErrors,
      payload: GetAccessRolePayloadSchema,
      success: GetAccessRoleResponseSchema,
    }),
  )
  .add(
    HttpApiEndpoint.post('listAccessRoleTemplates', '/shell/access/roles/templates', {
      error: accessAdminErrors,
      payload: AccessPageSchema,
      success: ListAccessRoleTemplatesResponseSchema,
    }),
  )
  .add(
    HttpApiEndpoint.post('previewAccessRoleEdit', '/shell/access/roles/preview', {
      error: accessAdminErrors,
      payload: AccessRoleEditPayloadSchema,
      success: PreviewAccessRoleEditResponseSchema,
    }),
  )
  .add(
    HttpApiEndpoint.post('saveAccessRoleEdit', '/shell/access/roles/save', {
      error: accessAdminErrors,
      headers: AccessIdempotencyHeadersSchema,
      payload: SaveAccessRoleEditPayloadSchema,
      success: SaveAccessRoleEditResponseSchema,
    }),
  )
  .add(
    HttpApiEndpoint.post('createAccessRole', '/shell/access/roles/create', {
      error: accessAdminErrors,
      headers: AccessIdempotencyHeadersSchema,
      payload: CreateAccessRolePayloadSchema,
      success: AccessRoleSchema,
    }),
  );

export const AccessTeamIdSchema = uuid.pipe(Schema.brand('AccessTeamId'));
export const AccessPeopleRevisionSchema = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500)).pipe(
  Schema.brand('AccessPeopleRevision'),
);
export const AccessMembershipSchema = Schema.Struct({
  kind: Schema.Literals(['member', 'owner', 'access_admin']),
  scope: AccessScopeTargetSchema,
  status: Schema.Literals(['active', 'suspended', 'revoked']),
  validFrom: date,
  validUntil: Schema.Union([Schema.Null, date]),
});
export const AccessDelegatedLimitsSchema = Schema.Struct({
  amountCeiling: AccessCellSchema.fields.amountCeiling,
  capabilityKeys: Schema.NonEmptyArray(AccessCapabilityKeySchema),
  delegationId: AccessDelegationIdSchema,
  until: date,
});
export const AccessAssignmentSchema = Schema.Struct({
  delegated: Schema.optionalKey(AccessDelegatedLimitsSchema),
  incarnationId: AccessAssignmentIdSchema,
  principalId: AccessHumanIdSchema,
  roleId: AccessRoleIdSchema,
  roleName: text,
  scope: AccessScopeTargetSchema,
  status: lifecycleStatus,
  validFrom: date,
  validUntil: Schema.Union([Schema.Null, date]),
});
export const AccessTeamMembershipSchema = Schema.Struct({
  name: text,
  scope: AccessScopeTargetSchema,
  teamId: AccessTeamIdSchema,
});
export const AccessDelegationViewSchema = Schema.Struct({
  amountCeiling: Schema.optionalKey(AccessCellSchema.fields.amountCeiling),
  capabilityKeys: Schema.NonEmptyArray(AccessCapabilityKeySchema),
  delegationId: AccessDelegationIdSchema,
  managerId: AccessHumanIdSchema,
  people: Schema.Array(AccessHumanIdSchema),
  roleIds: Schema.Array(AccessRoleIdSchema),
  scope: AccessScopeTargetSchema,
  status: lifecycleStatus,
  validFrom: date,
  validUntil: date,
});
export const AccessPersonOwnershipSchema = Schema.Struct({
  administersScopes: Schema.Array(AccessScopeTargetSchema),
  soleAdministratorScopes: Schema.Array(AccessScopeTargetSchema),
});
export const AccessPersonSchema = Schema.Struct({
  assignments: Schema.Array(AccessAssignmentSchema),
  delegations: Schema.Array(AccessDelegationViewSchema),
  displayName: text,
  email: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(320))),
  memberships: Schema.Array(AccessMembershipSchema),
  ownership: AccessPersonOwnershipSchema,
  principalId: AccessHumanIdSchema,
  suspended: Schema.Boolean,
  teams: Schema.Array(AccessTeamMembershipSchema),
});
export const ListAccessPeoplePayloadSchema = Schema.Struct({
  ...AccessPageSchema.fields,
  query: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200))),
  scope: Schema.optionalKey(AccessScopeTargetSchema),
});
export const ListAccessPeopleResponseSchema = Schema.Struct({
  ...paged(AccessPersonSchema).fields,
  revision: AccessPeopleRevisionSchema,
});
export const ListAccessAssignmentsPayloadSchema = Schema.Struct({
  ...AccessPageSchema.fields,
  principalId: AccessHumanIdSchema,
});
export const ListAccessAssignmentsResponseSchema = paged(AccessAssignmentSchema);
export const AccessPersonChoiceSchema = Schema.Struct({
  canTakeOwnershipOfScopes: Schema.Array(AccessScopeTargetSchema),
  displayName: text,
  memberOfScopes: Schema.Array(AccessScopeTargetSchema),
  principalId: AccessHumanIdSchema,
  soleAdministratorScopes: Schema.Array(AccessScopeTargetSchema),
});
export const AccessRoleChoiceSchema = Schema.Struct({
  capabilityKeys: Schema.Array(AccessCapabilityKeySchema),
  latestRevisionId: AccessRoleRevisionIdSchema,
  name: text,
  risk: accessRisk,
  roleId: AccessRoleIdSchema,
  scope: AccessScopeTargetSchema,
});
export const AccessCapabilityChoiceSchema = Schema.Struct({
  capabilityKey: AccessCapabilityKeySchema,
  hasAmountInput: Schema.Boolean,
  moduleKey: AccessModuleKeySchema,
  risk: accessRisk,
  withinGrantorAuthority: Schema.Boolean,
});
/** Exactly one company: admission targets a company, never the tenant context. */
export const AccessCompanyScopeTargetSchema = Schema.Struct({
  kind: Schema.Literal('company'),
  legalEntityId: AccessCompanyIdSchema,
});
/** A person the company directory lists as an active human with no live member row in that company yet. */
export const AccessAdmissionCandidateSchema = Schema.Struct({
  displayName: text,
  principalId: AccessHumanIdSchema,
  scope: AccessCompanyScopeTargetSchema,
});
export const AccessPeopleWriteAvailabilitySchema = Schema.Struct({
  canAdmitMember: Schema.Boolean,
  canAssign: Schema.Boolean,
  canDelegate: Schema.Boolean,
  canEndMembership: Schema.Boolean,
  canManageTeams: Schema.Boolean,
  canRevokeDelegation: Schema.Boolean,
  canTransferOwnership: Schema.Boolean,
  canUnassign: Schema.Boolean,
});
export const ListAccessPeopleOptionsResponseSchema = Schema.Struct({
  admissionCandidates: Schema.Array(AccessAdmissionCandidateSchema),
  capabilities: Schema.Array(AccessCapabilityChoiceSchema),
  managers: Schema.Array(AccessPersonChoiceSchema),
  people: Schema.Array(AccessPersonChoiceSchema),
  revision: AccessPeopleRevisionSchema,
  roles: Schema.Array(AccessRoleChoiceSchema),
  scopes: Schema.Array(Schema.Struct({ label: text, scope: AccessScopeTargetSchema })),
  teams: Schema.Array(Schema.Struct({ name: text, scope: AccessScopeTargetSchema, teamId: AccessTeamIdSchema })),
  writeAvailability: AccessPeopleWriteAvailabilitySchema,
});
export const AssignAccessRolePayloadSchema = Schema.Struct({
  expectedRevision: AccessPeopleRevisionSchema,
  expectedRoleRevisionId: AccessRoleRevisionIdSchema,
  principalId: AccessHumanIdSchema,
  roleId: AccessRoleIdSchema,
  scope: AccessScopeTargetSchema,
  validUntil: Schema.optionalKey(date),
});
export const RevokeAccessAssignmentPayloadSchema = Schema.Struct({
  expectedRevision: AccessPeopleRevisionSchema,
  incarnationId: AccessAssignmentIdSchema,
  reason: namedEffect,
});
export const SetAccessTeamMembershipPayloadSchema = Schema.Struct({
  action: Schema.Literals(['join', 'leave']),
  expectedRevision: AccessPeopleRevisionSchema,
  principalId: AccessHumanIdSchema,
  teamId: AccessTeamIdSchema,
});
export const CreateAccessDelegationPayloadSchema = Schema.Struct({
  amountCeiling: Schema.optionalKey(AccessCellSchema.fields.amountCeiling),
  capabilityKeys: Schema.NonEmptyArray(AccessCapabilityKeySchema),
  expectedRevision: AccessPeopleRevisionSchema,
  managerId: AccessHumanIdSchema,
  people: Schema.NonEmptyArray(AccessHumanIdSchema),
  roleIds: Schema.NonEmptyArray(AccessRoleIdSchema),
  scope: AccessScopeTargetSchema,
  validUntil: date,
});
export const AccessDelegationResponseSchema = Schema.Struct({
  delegationId: AccessDelegationIdSchema,
  status: lifecycleStatus,
});
export const RevokeAccessDelegationPayloadSchema = Schema.Struct({
  delegationId: AccessDelegationIdSchema,
  expectedRevision: AccessPeopleRevisionSchema,
  reason: namedEffect,
});
export const TransferAccessOwnershipPayloadSchema = Schema.Struct({
  expectedRevision: AccessPeopleRevisionSchema,
  fromPrincipalId: AccessHumanIdSchema,
  scopes: Schema.NonEmptyArray(AccessScopeTargetSchema),
  toPrincipalId: AccessHumanIdSchema,
});
export const AdmitAccessMemberPayloadSchema = Schema.Struct({
  expectedRevision: AccessPeopleRevisionSchema,
  principalId: AccessHumanIdSchema,
  scope: AccessCompanyScopeTargetSchema,
});
export const EndAccessMembershipPayloadSchema = Schema.Struct({
  expectedRevision: AccessPeopleRevisionSchema,
  principalId: AccessHumanIdSchema,
  reason: namedEffect,
  scope: AccessScopeTargetSchema,
});
export const AccessMembershipChangeSchema = Schema.Struct({
  principalId: AccessHumanIdSchema,
  scope: AccessScopeTargetSchema,
  status: AccessMembershipSchema.fields.status,
});
export const AccessPeopleMutationResponseSchema = Schema.Struct({
  assignment: Schema.optionalKey(AccessAssignmentSchema),
  delegation: Schema.optionalKey(AccessDelegationResponseSchema),
  membership: Schema.optionalKey(AccessMembershipChangeSchema),
  revision: AccessPeopleRevisionSchema,
  teamMembership: Schema.optionalKey(
    Schema.Struct({ active: Schema.Boolean, principalId: AccessHumanIdSchema, teamId: AccessTeamIdSchema }),
  ),
  transferredScopes: Schema.optionalKey(Schema.Array(AccessScopeTargetSchema)),
});
export const accessAdminPeopleGroup = HttpApiGroup.make('accessAdminPeople')
  .add(
    HttpApiEndpoint.post('listAccessPeopleOptions', '/shell/access/people/options', {
      error: accessAdminErrors,
      payload: ListAccessPeoplePayloadSchema,
      success: ListAccessPeopleOptionsResponseSchema,
    }),
  )
  .add(
    HttpApiEndpoint.post('setAccessTeamMembership', '/shell/access/people/team-membership', {
      error: accessAdminErrors,
      headers: AccessIdempotencyHeadersSchema,
      payload: SetAccessTeamMembershipPayloadSchema,
      success: AccessPeopleMutationResponseSchema,
    }),
  )
  .add(
    HttpApiEndpoint.post('transferAccessOwnership', '/shell/access/people/transfer-ownership', {
      error: accessAdminErrors,
      headers: AccessIdempotencyHeadersSchema,
      payload: TransferAccessOwnershipPayloadSchema,
      success: AccessPeopleMutationResponseSchema,
    }),
  )
  .add(
    HttpApiEndpoint.post('listAccessPeople', '/shell/access/people/list', {
      error: accessAdminErrors,
      payload: ListAccessPeoplePayloadSchema,
      success: ListAccessPeopleResponseSchema,
    }),
  )
  .add(
    HttpApiEndpoint.post('listAccessAssignments', '/shell/access/people/assignments', {
      error: accessAdminErrors,
      payload: ListAccessAssignmentsPayloadSchema,
      success: ListAccessAssignmentsResponseSchema,
    }),
  )
  .add(
    HttpApiEndpoint.post('assignAccessRole', '/shell/access/people/assign', {
      error: accessAdminErrors,
      headers: AccessIdempotencyHeadersSchema,
      payload: AssignAccessRolePayloadSchema,
      success: AccessPeopleMutationResponseSchema,
    }),
  )
  .add(
    HttpApiEndpoint.post('revokeAccessAssignment', '/shell/access/people/revoke-assignment', {
      error: accessAdminErrors,
      headers: AccessIdempotencyHeadersSchema,
      payload: RevokeAccessAssignmentPayloadSchema,
      success: AccessPeopleMutationResponseSchema,
    }),
  )
  .add(
    HttpApiEndpoint.post('createAccessDelegation', '/shell/access/people/delegate', {
      error: accessAdminErrors,
      headers: AccessIdempotencyHeadersSchema,
      payload: CreateAccessDelegationPayloadSchema,
      success: AccessPeopleMutationResponseSchema,
    }),
  )
  .add(
    HttpApiEndpoint.post('revokeAccessDelegation', '/shell/access/people/revoke-delegation', {
      error: accessAdminErrors,
      headers: AccessIdempotencyHeadersSchema,
      payload: RevokeAccessDelegationPayloadSchema,
      success: AccessPeopleMutationResponseSchema,
    }),
  )
  .add(
    HttpApiEndpoint.post('admitAccessMember', '/shell/access/people/admit-member', {
      error: accessAdminErrors,
      headers: AccessIdempotencyHeadersSchema,
      payload: AdmitAccessMemberPayloadSchema,
      success: AccessPeopleMutationResponseSchema,
    }),
  )
  .add(
    HttpApiEndpoint.post('endAccessMembership', '/shell/access/people/end-membership', {
      error: accessAdminErrors,
      headers: AccessIdempotencyHeadersSchema,
      payload: EndAccessMembershipPayloadSchema,
      success: AccessPeopleMutationResponseSchema,
    }),
  );

export const AccessChangeHolderSchema = Schema.Struct({
  assignmentIncarnationId: AccessAssignmentIdSchema,
  holder: Schema.Union([
    Schema.TaggedStruct('human', { principalId: AccessHumanIdSchema }),
    Schema.TaggedStruct('agent', { agentId: AccessAgentIdSchema }),
  ]),
  roleId: AccessRoleIdSchema,
});
export const AccessCellChangeSchema = Schema.Struct({ cell: AccessCellSchema, roleId: AccessRoleIdSchema });
/** batchEligible is server-computed from pending + routine + non-widening in the current release;
 * requiresIndividualDecision only names the risk tier and is NEVER a safe batch criterion. */
export const AccessChangeSchema = Schema.Struct({
  addedCells: Schema.Array(AccessCellChangeSchema),
  affectedAgentCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  affectedHumanCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  batchEligible: Schema.Boolean,
  capabilityKey: AccessCapabilityKeySchema,
  catalogSnapshotId: AccessCatalogSnapshotIdSchema,
  entry: Schema.optionalKey(AccessCatalogEntrySchema),
  holders: Schema.Array(AccessChangeHolderSchema),
  id: AccessChangeItemIdSchema,
  kind: Schema.Literals(['new', 'renamed', 'split', 'removed', 'risk_changed']),
  lineageFrom: Schema.Array(AccessCapabilityKeySchema),
  namedEffect: Schema.optionalKey(namedEffect),
  removedCells: Schema.Array(AccessCellChangeSchema),
  requiresIndividualDecision: Schema.Boolean,
  risk: accessRisk,
  status: Schema.Literals(['pending', 'adopted', 'declined', 'undone']),
  suggestedRoleIds: Schema.Array(AccessRoleIdSchema),
  widens: Schema.Boolean,
});
export const ListAccessChangesResponseSchema = Schema.Struct({
  ...paged(AccessChangeSchema).fields,
  catalogSnapshotId: Schema.Union([Schema.Null, AccessCatalogSnapshotIdSchema]),
  roles: Schema.Array(AccessRoleSchema),
  writeAvailability: Schema.Struct({ available: Schema.Boolean, reason: Schema.String }),
});
export const PreviewAccessChangesPayloadSchema = Schema.Struct({
  catalogSnapshotId: AccessCatalogSnapshotIdSchema,
  decision: changePreviewDecision,
  itemIds: Schema.NonEmptyArray(AccessChangeItemIdSchema),
  legalEntityId: AccessCompanyTargetSchema,
});
export const AccessChangeSkipSchema = Schema.Struct({
  capabilityKey: AccessCapabilityKeySchema,
  reason: Schema.Literals([
    'already_present',
    'already_removed',
    'capability_not_published',
    'cell_revoked_later',
    'role_missing',
  ]),
  roleId: AccessRoleIdSchema,
  slot: text,
});
export const PreviewAccessChangesResponseSchema = Schema.Struct({
  affectedAgentCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  affectedHumanCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  individualItemIds: Schema.Array(AccessChangeItemIdSchema),
  items: Schema.Array(AccessChangeSchema),
  legalEntityId: AccessCompanyTargetSchema,
  previewToken,
  requiresNamedEffect: Schema.Boolean,
  roleChanges: Schema.Array(
    Schema.Struct({
      after: Schema.Array(AccessCellSchema),
      before: Schema.Array(AccessCellSchema),
      expectedRevisionId: AccessRoleRevisionIdSchema,
      roleId: AccessRoleIdSchema,
    }),
  ),
  skipped: Schema.Array(AccessChangeSkipSchema),
});
export const DecideAccessChangesPayloadSchema = Schema.Union([
  Schema.Struct({
    catalogSnapshotId: AccessCatalogSnapshotIdSchema,
    decision: changePreviewDecision,
    itemIds: Schema.NonEmptyArray(AccessChangeItemIdSchema),
    legalEntityId: AccessCompanyTargetSchema,
    namedEffect: Schema.optionalKey(namedEffect),
    previewToken,
  }),
  Schema.Struct({
    catalogSnapshotId: AccessCatalogSnapshotIdSchema,
    decision: Schema.Literal('decline'),
    itemIds: Schema.NonEmptyArray(AccessChangeItemIdSchema),
    legalEntityId: AccessCompanyTargetSchema,
  }),
]);
export const DecideAccessChangesResponseSchema = Schema.Struct({
  catalogSnapshotId: AccessCatalogSnapshotIdSchema,
  decisionIds: Schema.Array(AccessChangeDecisionIdSchema),
  legalEntityId: AccessCompanyTargetSchema,
  skipped: Schema.Array(AccessChangeSkipSchema),
});
export const accessAdminChangesGroup = HttpApiGroup.make('accessAdminChanges')
  .add(
    HttpApiEndpoint.post('listAccessChanges', '/shell/access/changes/list', {
      error: accessAdminErrors,
      payload: AccessPageSchema,
      success: ListAccessChangesResponseSchema,
    }),
  )
  .add(
    HttpApiEndpoint.post('previewAccessChanges', '/shell/access/changes/preview', {
      error: accessAdminErrors,
      payload: PreviewAccessChangesPayloadSchema,
      success: PreviewAccessChangesResponseSchema,
    }),
  )
  .add(
    HttpApiEndpoint.post('decideAccessChanges', '/shell/access/changes/decide', {
      error: accessAdminErrors,
      headers: AccessIdempotencyHeadersSchema,
      payload: DecideAccessChangesPayloadSchema,
      success: DecideAccessChangesResponseSchema,
    }),
  );

export const ListAccessApprovalsPayloadSchema = Schema.Struct({
  ...AccessPageSchema.fields,
  status: Schema.optionalKey(approvalStatus),
});
export const AccessApprovalRequesterSchema = Schema.Struct({
  displayName: Schema.optionalKey(text),
  kind: Schema.Literals(['human', 'agent']),
  principalId: AccessHumanIdSchema,
});
export const AccessApprovalScopeSchema = Schema.Union([
  Schema.Struct({ accessScopeId: AccessScopeIdSchema, kind: Schema.Literal('tenant') }),
  Schema.Struct({
    accessScopeId: AccessScopeIdSchema,
    kind: Schema.Literal('company'),
    legalEntityId: AccessCompanyIdSchema,
  }),
]);
/** Server-rendered and field-filtered preview of the frozen command, never a payload source. */
export const AccessApprovalCommandPreviewSchema = Schema.Struct({
  actionKey: AccessActionKeySchema,
  capabilityKey: AccessCapabilityKeySchema,
  digestShort: Schema.String.check(Schema.isPattern(/^[a-f0-9]{12}$/u)),
  fields: Schema.Array(Schema.Struct({ label: text, value: text })),
  frozenAt: date,
  redactedFieldCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  target: Schema.optionalKey(Schema.Struct({ label: Schema.optionalKey(text), recordKey: AccessRecordKeySchema })),
});
export const AccessApprovalEligibilitySchema = Schema.Struct({
  allowed: Schema.Boolean,
  reason: Schema.optionalKey(text),
});
export const AccessApprovalSchema = Schema.Struct({
  approver: Schema.optionalKey(
    Schema.Struct({
      approvalExpiresAt: date,
      approvedAt: date,
      displayName: Schema.optionalKey(text),
      principalId: AccessHumanIdSchema,
    }),
  ),
  capabilityKey: AccessCapabilityKeySchema,
  capabilityLabel: text,
  command: AccessApprovalCommandPreviewSchema,
  commandDigest: digest,
  createdAt: date,
  endedAt: Schema.optionalKey(date),
  execution: Schema.Struct({ available: Schema.Boolean, reason: text }),
  expiresAt: date,
  permitted: Schema.Struct({
    approval: AccessApprovalEligibilitySchema,
    rejection: AccessApprovalEligibilitySchema,
    withdrawal: AccessApprovalEligibilitySchema,
  }),
  proposalId: AccessProposalIdSchema,
  requester: AccessApprovalRequesterSchema,
  revision: text,
  risk: accessRisk,
  scope: AccessApprovalScopeSchema,
  status: approvalStatus,
});
export const ListAccessApprovalsResponseSchema = paged(AccessApprovalSchema);
// A proposal must be frozen from a trusted Core-owned command, never from a browser-supplied
// digest/reference. P5 adds proposal creation only when that dispatch boundary exists.
export const DecideAccessApprovalPayloadSchema = Schema.Struct({
  decision: Schema.Literals(['approve', 'reject', 'withdraw']),
  expectedStatus: Schema.Literals(['pending', 'approved']),
  proposalId: AccessProposalIdSchema,
  reason: Schema.optionalKey(namedEffect),
  revision: Schema.optionalKey(text),
});
export const ExecuteAccessApprovalPayloadSchema = Schema.Struct({
  expectedStatus: Schema.Literal('approved'),
  proposalId: AccessProposalIdSchema,
  revision: Schema.optionalKey(text),
});
export const accessAdminApprovalsGroup = HttpApiGroup.make('accessAdminApprovals')
  .add(
    HttpApiEndpoint.post('listAccessApprovals', '/shell/access/approvals/list', {
      error: accessAdminErrors,
      payload: ListAccessApprovalsPayloadSchema,
      success: ListAccessApprovalsResponseSchema,
    }),
  )
  .add(
    HttpApiEndpoint.post('decideAccessApproval', '/shell/access/approvals/decide', {
      error: accessAdminErrors,
      headers: AccessIdempotencyHeadersSchema,
      payload: DecideAccessApprovalPayloadSchema,
      success: AccessApprovalSchema,
    }),
  )
  .add(
    HttpApiEndpoint.post('executeAccessApproval', '/shell/access/approvals/execute', {
      error: accessAdminErrors,
      headers: AccessIdempotencyHeadersSchema,
      payload: ExecuteAccessApprovalPayloadSchema,
      success: AccessApprovalSchema,
    }),
  );

export const AccessDecisionReasonCodeSchema = Schema.Literals([
  'allow.granted',
  'approval.required',
  'deny.agent_forbidden',
  'deny.agent_sensitive_read',
  'deny.amount_exceeds_ceiling',
  'deny.amount_required',
  'deny.caveat_indeterminate',
  'deny.connection_ceiling',
  'deny.connection_inactive',
  'deny.consent_stale',
  'deny.deadline_passed',
  'deny.declaration_missing',
  'deny.insufficient_grant',
  'deny.mode_unsupported',
  'deny.parent_read_required',
  'deny.principal_kind_forbidden',
  'deny.scope_mismatch',
  'deny.target_required',
  'deny.workload_forbidden',
  'deny.workload_only',
  'structural.access_admin',
  'structural.access_admin_any',
  'structural.delegation',
  'structural.owner',
  'unavailable.engine',
  'unavailable.evidence',
  'unavailable.indeterminate',
  'unavailable.intent',
]);
export const ExplainAccessPayloadSchema = Schema.Struct({
  amount: Schema.optionalKey(
    Schema.Struct({
      currency: Schema.String.check(Schema.isPattern(/^[A-Z]{3}$/u)),
      minor: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    }),
  ),
  capabilityKey: AccessCapabilityKeySchema,
  mode: Schema.Literals(['run', 'propose']),
  scope: AccessScopeTargetSchema,
  /**
   * Whose access is explained. Absent means "mine". Naming someone else needs the separate
   * `core.shell.access-explain.read-subject` capability and a live membership of this tenant, and a
   * person of another tenant and a person who does not exist answer identically.
   */
  subjectPrincipalId: Schema.optionalKey(AccessHumanIdSchema),
  target: Schema.optionalKey(Schema.Struct({ moduleKey: AccessModuleKeySchema, recordKey: AccessRecordKeySchema })),
});
/** An unprovable decision is a retryable 503, never a 403 or a successful explanation. */
export const ExplainAccessResponseSchema = Schema.Struct({
  admissionDeadline: Schema.optionalKey(date),
  authority: Schema.Array(
    Schema.Struct({
      capabilityKey: AccessCapabilityKeySchema,
      deadline: Schema.optionalKey(date),
      mode: accessMode,
      roleId: AccessRoleIdSchema,
      roleName: Schema.optionalKey(text),
      selector: Schema.Literals(['all', 'assigned', 'entrusted', 'team', 'targets']),
    }),
  ),
  authorityMetadata: Schema.Literals(['included', 'withheld', 'unavailable']),
  fieldClass: Schema.optionalKey(text),
  grantableBy: Schema.Array(Schema.Struct({ displayName: text, principalId: AccessHumanIdSchema })),
  outcome: Schema.Literals(['ALLOWED', 'DENIED', 'NEEDS_APPROVAL']),
  reasonCodes: Schema.NonEmptyArray(AccessDecisionReasonCodeSchema),
});
export const accessAdminExplainGroup = HttpApiGroup.make('accessAdminExplain').add(
  HttpApiEndpoint.post('explainAccess', '/shell/access/explain', {
    error: accessAdminErrors,
    payload: ExplainAccessPayloadSchema,
    success: ExplainAccessResponseSchema,
  }),
);

/** Native client contract; Shell composes backed groups into shared/api.ts as handlers arrive. */
export const AccessAdministrationApi = HttpApi.make('accessAdministrationApi')
  .add(accessAdminRolesGroup)
  .add(accessAdminPeopleGroup)
  .add(accessAdminChangesGroup)
  .add(accessAdminApprovalsGroup)
  .add(accessAdminExplainGroup);

// Core exposes precise ./access/decision/{contract,explain} and
// ./access/changes/{commands,role-revision} subpaths, not area barrels.
export type ListAccessRolesPayload = typeof AccessPageSchema.Type;
export type ListAccessRolesResponse = typeof ListAccessRolesResponseSchema.Type;
export type GetAccessRolePayload = typeof GetAccessRolePayloadSchema.Type;
export type GetAccessRoleResponse = typeof GetAccessRoleResponseSchema.Type;
export type ListAccessRoleTemplatesPayload = typeof AccessPageSchema.Type;
export type ListAccessRoleTemplatesResponse = typeof ListAccessRoleTemplatesResponseSchema.Type;
export type CreateAccessRolePayload = typeof CreateAccessRolePayloadSchema.Type;
export type AccessRoleEditPayload = typeof AccessRoleEditPayloadSchema.Type;
export type PreviewAccessRoleEditResponse = typeof PreviewAccessRoleEditResponseSchema.Type;
export type SaveAccessRoleEditPayload = typeof SaveAccessRoleEditPayloadSchema.Type;
export type SaveAccessRoleEditResponse = typeof SaveAccessRoleEditResponseSchema.Type;
export type ListAccessPeoplePayload = typeof ListAccessPeoplePayloadSchema.Type;
export type ListAccessPeopleResponse = typeof ListAccessPeopleResponseSchema.Type;
export type ListAccessAssignmentsPayload = typeof ListAccessAssignmentsPayloadSchema.Type;
export type ListAccessAssignmentsResponse = typeof ListAccessAssignmentsResponseSchema.Type;
export type AssignAccessRolePayload = typeof AssignAccessRolePayloadSchema.Type;
export type RevokeAccessAssignmentPayload = typeof RevokeAccessAssignmentPayloadSchema.Type;
export type CreateAccessDelegationPayload = typeof CreateAccessDelegationPayloadSchema.Type;
export type RevokeAccessDelegationPayload = typeof RevokeAccessDelegationPayloadSchema.Type;
export type AccessPeopleMutationResponse = typeof AccessPeopleMutationResponseSchema.Type;
export type ListAccessPeopleOptionsResponse = typeof ListAccessPeopleOptionsResponseSchema.Type;
export type SetAccessTeamMembershipPayload = typeof SetAccessTeamMembershipPayloadSchema.Type;
export type TransferAccessOwnershipPayload = typeof TransferAccessOwnershipPayloadSchema.Type;
export type AdmitAccessMemberPayload = typeof AdmitAccessMemberPayloadSchema.Type;
export type EndAccessMembershipPayload = typeof EndAccessMembershipPayloadSchema.Type;
export type AccessAdmissionCandidate = typeof AccessAdmissionCandidateSchema.Type;
export type ListAccessChangesPayload = typeof AccessPageSchema.Type;
export type ListAccessChangesResponse = typeof ListAccessChangesResponseSchema.Type;
export type PreviewAccessChangesPayload = typeof PreviewAccessChangesPayloadSchema.Type;
export type PreviewAccessChangesResponse = typeof PreviewAccessChangesResponseSchema.Type;
export type DecideAccessChangesPayload = typeof DecideAccessChangesPayloadSchema.Type;
export type DecideAccessChangesResponse = typeof DecideAccessChangesResponseSchema.Type;
export type ListAccessApprovalsPayload = typeof ListAccessApprovalsPayloadSchema.Type;
export type ListAccessApprovalsResponse = typeof ListAccessApprovalsResponseSchema.Type;
export type DecideAccessApprovalPayload = typeof DecideAccessApprovalPayloadSchema.Type;
export type ExecuteAccessApprovalPayload = typeof ExecuteAccessApprovalPayloadSchema.Type;
export type AccessApproval = typeof AccessApprovalSchema.Type;
export type ExplainAccessPayload = typeof ExplainAccessPayloadSchema.Type;
export type ExplainAccessResponse = typeof ExplainAccessResponseSchema.Type;
