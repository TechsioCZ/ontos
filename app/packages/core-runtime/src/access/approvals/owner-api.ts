import { Schema } from 'effect';
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware, HttpApiSchema } from 'effect/http-api';

import {
  AccessScopeIdSchema,
  CommandDigestSchema,
  LegalEntityIdSchema,
  ModuleKeySchema,
  ProposalIdSchema,
  TenantIdSchema,
} from '../ids.ts';

export const OWNER_ACTION_APPROVAL_PATH = '/_ontos/action-approvals/approve' as const;
export const OWNER_ACTION_APPROVAL_INSPECTION_PATH = '/_ontos/action-approvals/inspect' as const;
const revision = Schema.String.check(Schema.isPattern(/^[\da-f]{64}$/u));
const identifier = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200), Schema.isTrimmed());
const appId = identifier.pipe(Schema.brand('OntosDeploymentAppId'), Schema.decodeTo(Schema.String));

/** Receiving-release expectations, not identity, authority, a command or an approver override. */
export const OwnerActionApprovalRequestSchema = Schema.Struct({
  compositionRevision: revision,
  expectedCommandDigest: CommandDigestSchema,
  expectedOwner: Schema.Struct({
    deployment: Schema.Struct({ appId, buildMarker: identifier }),
    moduleKey: ModuleKeySchema,
  }),
  expectedStatus: Schema.Literal('pending'),
  proposalId: ProposalIdSchema,
  scopeId: AccessScopeIdSchema,
});
export type OwnerActionApprovalRequest = typeof OwnerActionApprovalRequestSchema.Type;

/** An approval does not execute the owner Action or return any part of its private command/proof. */
export const OwnerActionApprovalResponseSchema = Schema.Struct({
  proposalId: ProposalIdSchema,
  status: Schema.Literal('approved'),
});
export type OwnerActionApprovalResponse = typeof OwnerActionApprovalResponseSchema.Type;

/** A current eligibility observation, never an approval, reservation, proof or execution lease. */
export const OwnerActionApprovalInspectionResponseSchema = Schema.Struct({
  canApprove: Schema.Boolean,
  proposalId: ProposalIdSchema,
});
export type OwnerActionApprovalInspectionResponse = typeof OwnerActionApprovalInspectionResponseSchema.Type;

/** The only command facts Shell needs to select the already-published receiving owner. */
export const OwnerActionApprovalRoutingSchema = Schema.Struct({
  format: Schema.Literal('core.action/2'),
  owningModuleKey: ModuleKeySchema,
  scope: Schema.Struct({
    legalEntityId: Schema.optionalKey(LegalEntityIdSchema),
    tenantId: TenantIdSchema,
  }),
});
export type OwnerActionApprovalRouting = typeof OwnerActionApprovalRoutingSchema.Type;

const problemFields = { detail: Schema.String, title: Schema.String, type: Schema.String };
const problem = <const Tag extends string, const Status extends 400 | 401 | 403 | 409 | 500>(
  tag: Tag,
  status: Status,
) =>
  Schema.TaggedStruct(tag, { ...problemFields, status: Schema.Literal(status) }).pipe(
    HttpApiSchema.status(status),
    HttpApiSchema.asJson({ contentType: 'application/problem+json' }),
  );
export const OwnerActionApprovalInvalidSchema = problem('OwnerActionApprovalInvalid', 400);
export const OwnerActionApprovalAuthenticationSchema = problem('OwnerActionApprovalAuthentication', 401);
export const OwnerActionApprovalForbiddenSchema = problem('OwnerActionApprovalForbidden', 403);
export const OwnerActionApprovalConflictSchema = problem('OwnerActionApprovalConflict', 409);
export const OwnerActionApprovalInternalSchema = problem('OwnerActionApprovalInternal', 500);
export const OwnerActionApprovalUnavailableSchema = Schema.TaggedStruct('OwnerActionApprovalUnavailable', {
  ...problemFields,
  retryable: Schema.Literal(true),
  status: Schema.Literal(503),
}).pipe(HttpApiSchema.status(503), HttpApiSchema.asJson({ contentType: 'application/problem+json' }));

export class OwnerActionApprovalSchemaErrorMiddleware extends HttpApiMiddleware.Service<OwnerActionApprovalSchemaErrorMiddleware>()(
  '@app/core-runtime/access/approvals/owner-api/OwnerActionApprovalSchemaErrorMiddleware',
  { error: OwnerActionApprovalInvalidSchema },
) {}

export const ownerActionApprovalGroupDefinition = HttpApiGroup.make('ownerActionApprovals')
  .add(
    HttpApiEndpoint.post('inspect', OWNER_ACTION_APPROVAL_INSPECTION_PATH, {
      error: [
        OwnerActionApprovalInvalidSchema,
        OwnerActionApprovalAuthenticationSchema,
        OwnerActionApprovalForbiddenSchema,
        OwnerActionApprovalConflictSchema,
        OwnerActionApprovalInternalSchema,
        OwnerActionApprovalUnavailableSchema,
      ],
      payload: OwnerActionApprovalRequestSchema,
      success: OwnerActionApprovalInspectionResponseSchema,
    }),
    HttpApiEndpoint.post('approve', OWNER_ACTION_APPROVAL_PATH, {
      error: [
        OwnerActionApprovalInvalidSchema,
        OwnerActionApprovalAuthenticationSchema,
        OwnerActionApprovalForbiddenSchema,
        OwnerActionApprovalConflictSchema,
        OwnerActionApprovalInternalSchema,
        OwnerActionApprovalUnavailableSchema,
      ],
      payload: OwnerActionApprovalRequestSchema,
      success: OwnerActionApprovalResponseSchema,
    }),
  )
  .middleware(OwnerActionApprovalSchemaErrorMiddleware);
type OwnerActionApprovalGroupContract = HttpApiGroup.HttpApiGroup<
  'ownerActionApprovals',
  HttpApiGroup.Endpoints<typeof ownerActionApprovalGroupDefinition>
>;
const ownerActionApprovalGroup: OwnerActionApprovalGroupContract = ownerActionApprovalGroupDefinition;
export const OwnerActionApprovalApi = HttpApi.make('OwnerActionApprovalApi')
  .add(ownerActionApprovalGroup)
  .annotate(HttpApi.ParseOptions, { onExcessProperty: 'error' });
