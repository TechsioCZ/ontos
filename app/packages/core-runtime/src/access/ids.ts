import { Schema } from 'effect';

/** Access identifiers are fixed-length UUIDs. Core never reuses an incarnation identifier. */
const uuid = Schema.String.check(Schema.isUUID());

export const TenantIdSchema = uuid.pipe(Schema.brand('TenantId'));
export type TenantId = typeof TenantIdSchema.Type;
export const LegalEntityIdSchema = uuid.pipe(Schema.brand('LegalEntityId'));
export type LegalEntityId = typeof LegalEntityIdSchema.Type;
/** A human principal (`core.principals.kind = 'human'`). */
export const PrincipalIdSchema = uuid.pipe(Schema.brand('PrincipalId'));
export type PrincipalId = typeof PrincipalIdSchema.Type;
/** An AI agent: a `core.principals` row of kind `agent`, never interchangeable with a human. */
export const AgentIdSchema = uuid.pipe(Schema.brand('AgentId'));
export type AgentId = typeof AgentIdSchema.Type;

export const AccessScopeIdSchema = uuid.pipe(Schema.brand('AccessScopeId'));
export type AccessScopeId = typeof AccessScopeIdSchema.Type;
export const CatalogSnapshotIdSchema = uuid.pipe(Schema.brand('AccessCatalogSnapshotId'));
export type CatalogSnapshotId = typeof CatalogSnapshotIdSchema.Type;
export const RoleIdSchema = uuid.pipe(Schema.brand('AccessRoleId'));
export type RoleId = typeof RoleIdSchema.Type;
export const RoleRevisionIdSchema = uuid.pipe(Schema.brand('AccessRoleRevisionId'));
export type RoleRevisionId = typeof RoleRevisionIdSchema.Type;
export const AssignmentIncarnationIdSchema = uuid.pipe(Schema.brand('AccessAssignmentIncarnationId'));
export type AssignmentIncarnationId = typeof AssignmentIncarnationIdSchema.Type;
export const GrantIncarnationIdSchema = uuid.pipe(Schema.brand('AccessGrantIncarnationId'));
export type GrantIncarnationId = typeof GrantIncarnationIdSchema.Type;
export const DelegationIdSchema = uuid.pipe(Schema.brand('AccessDelegationId'));
export type DelegationId = typeof DelegationIdSchema.Type;
export const AccessChangeItemIdSchema = uuid.pipe(Schema.brand('AccessChangeItemId'));
export type AccessChangeItemId = typeof AccessChangeItemIdSchema.Type;
export const AccessChangeDecisionIdSchema = uuid.pipe(Schema.brand('AccessChangeDecisionId'));
export type AccessChangeDecisionId = typeof AccessChangeDecisionIdSchema.Type;
export const AccessChangeBatchIdSchema = uuid.pipe(Schema.brand('AccessChangeBatchId'));
export type AccessChangeBatchId = typeof AccessChangeBatchIdSchema.Type;
/** A proposal becomes the mandate once a person approves it; both share this identifier. */
export const ProposalIdSchema = uuid.pipe(Schema.brand('AccessProposalId'));
export type ProposalId = typeof ProposalIdSchema.Type;
export const AgentConnectionIdSchema = uuid.pipe(Schema.brand('AgentConnectionId'));
export type AgentConnectionId = typeof AgentConnectionIdSchema.Type;
/** Identifies one Core access-writer operation and its journal. */
export const AccessOperationIdSchema = uuid.pipe(Schema.brand('AccessOperationId'));
export type AccessOperationId = typeof AccessOperationIdSchema.Type;
export const DecisionLogIdSchema = uuid.pipe(Schema.brand('AccessDecisionLogId'));
export type DecisionLogId = typeof DecisionLogIdSchema.Type;

/** Matches the declaration key grammar: `<module>.<resource>.<verb>[.<qualifier>]`, lowercase. */
export const CAPABILITY_KEY_PATTERN = /^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*(?:\.[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*){2,}$/u;
export const CapabilityKeySchema = Schema.String.check(
  Schema.isMaxLength(200),
  Schema.isPattern(CAPABILITY_KEY_PATTERN),
).pipe(Schema.brand('CapabilityKey'));
export type CapabilityKey = typeof CapabilityKeySchema.Type;
export const ModuleKeySchema = Schema.String.check(
  Schema.isMaxLength(120),
  Schema.isPattern(/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u),
).pipe(Schema.brand('ModuleKey'));
export type ModuleKey = typeof ModuleKeySchema.Type;
/** Stable template key such as `sales.salesperson`; the label shown to people lives elsewhere. */
export const RoleTemplateKeySchema = Schema.String.check(
  Schema.isMaxLength(120),
  Schema.isPattern(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u),
).pipe(Schema.brand('AccessRoleTemplateKey'));
export type RoleTemplateKey = typeof RoleTemplateKeySchema.Type;

const sha256Hex = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
export const CatalogDigestSchema = sha256Hex.pipe(Schema.brand('AccessCatalogDigest'));
export type CatalogDigest = typeof CatalogDigestSchema.Type;
/** SHA-256 of the frozen command a proposal asks to execute. */
export const CommandDigestSchema = sha256Hex.pipe(Schema.brand('AccessCommandDigest'));
export type CommandDigest = typeof CommandDigestSchema.Type;
/** Module-owned record identity used for explicit target sets; never a cross-legal-entity reference. */
export const RecordKeySchema = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500)).pipe(
  Schema.brand('AccessRecordKey'),
);
export type RecordKey = typeof RecordKeySchema.Type;
export const CurrencyCodeSchema = Schema.String.check(Schema.isPattern(/^[A-Z]{3}$/u)).pipe(
  Schema.brand('CurrencyCode'),
);
export type CurrencyCode = typeof CurrencyCodeSchema.Type;
