import { Context, Effect, Layer, Match, Option, Schema } from 'effect';

import type { TrustedPrincipalContext } from '../../actions/principal-context.ts';
import { transportIdentifier } from '../../actions/string-schemas.ts';
import {
  isVerifiedGatewayPrincipalContext,
  readVerifiedGatewayCompositionRevision,
} from '../../auth/system-principal-context-provenance.ts';
import type { ActionHttpRequestHeaders } from '../../http/http-instrumentation-seam.ts';
import { ActiveApplicationCompositionService } from '../../modules/active-application-composition.ts';
import { OntosDeploymentIdentitySchema } from '../../modules/manifest.ts';
import { getVerticalRuntimeActions } from '../../modules/runtime-registration.ts';
import type { VerticalRuntimeRegistration } from '../../modules/runtime-registration.ts';
import { OperationalScopeResolver } from '../../operations/context.ts';
import type { OperationalScope } from '../../operations/context.ts';
import type { OperationContextError } from '../../operations/errors.ts';
import { PrincipalIdSchema, TenantIdSchema } from '../ids.ts';
import { ActionMandateDispatcher } from './action-mandate-dispatch-service.ts';
import { makeOwnerActionMandateDispatch } from './action-mandate-dispatch.ts';
import { decodeActionCommandV2 } from './action-command-v2.ts';
import type { ApprovalsError } from './errors.ts';
import type { LiveApprovalServices } from './live-composition.ts';
import { OwnerActionApprovalRequestSchema } from './owner-api.ts';
import type {
  OwnerActionApprovalInspectionResponse,
  OwnerActionApprovalRequest,
  OwnerActionApprovalResponse,
} from './owner-api.ts';
import { OwnerActionApprovalError, ownerActionApprovalFailure } from './owner-errors.ts';
import { readOwnerActionApprovalRouting } from './owner-routing.ts';
import { resolveRegisteredActionSourceV2 } from './registered-action-source-v2.ts';
import { liveApprovalsService } from './service.ts';
import type { ApproveCommand } from './service.ts';

export { ActionMandateDispatcher } from './action-mandate-dispatch-service.ts';
export { OwnerActionApprovalError } from './owner-errors.ts';
export { readOwnerActionApprovalRouting } from './owner-routing.ts';

export interface OwnerActionApproveInput {
  /** The exact audience-bound, verified AND redeemed principal, including its private provenance. */
  readonly principal: TrustedPrincipalContext;
  readonly request: OwnerActionApprovalRequest;
  /** Original bounded HTTP transport metadata, never principal or company claims. */
  readonly requestHeaders: Pick<ActionHttpRequestHeaders, 'x-correlation-id'>;
}
export interface OwnerActionApprovalsService {
  readonly approve: (
    input: OwnerActionApproveInput,
  ) => Effect.Effect<OwnerActionApprovalResponse, OwnerActionApprovalError>;
  readonly inspect: (
    input: OwnerActionApproveInput,
  ) => Effect.Effect<OwnerActionApprovalInspectionResponse, OwnerActionApprovalError>;
}
export class OwnerActionApprovals extends Context.Service<OwnerActionApprovals, OwnerActionApprovalsService>()(
  '@app/core-runtime/access/approvals/owner-runtime/OwnerActionApprovals',
) {}

const refused = <Cause>(cause?: Cause) => ownerActionApprovalFailure('approval_refused', cause);
const unavailable = <Cause>(cause?: Cause) => ownerActionApprovalFailure('approval_unavailable', cause);
const authentication = () => new OwnerActionApprovalError({ code: 'authentication_required' });
const scopeFailure = (failure: OperationContextError): OwnerActionApprovalError =>
  Match.value(failure).pipe(
    Match.tags({
      OperationAuthenticationRequired: (cause) => ownerActionApprovalFailure('authentication_required', cause),
      OperationContextDenied: refused,
      OperationContextInvalid: refused,
      OperationContextUnavailable: unavailable,
    }),
    Match.exhaustive,
  );
const approvalFailure = (failure: ApprovalsError): OwnerActionApprovalError =>
  Match.value(failure).pipe(
    Match.tags({
      ApprovalAuthorityUnavailableError: unavailable,
      ApprovalRefusedError: (cause) =>
        cause.code === 'proposal_not_pending' || cause.code === 'proposal_expired'
          ? ownerActionApprovalFailure('approval_conflict', cause)
          : refused(cause),
      ApprovalStorageConflictError: (cause) => ownerActionApprovalFailure('approval_conflict', cause),
      ApprovalStorageUnavailableError: unavailable,
      CommandNotCanonicalError: refused,
      MandateRefusedError: refused,
      ProposalIntegrityError: refused,
      ProposalRefusedError: refused,
    }),
    Match.exhaustive,
  );

const trustedRequest = (principal: TrustedPrincipalContext, request: OwnerActionApprovalRequest) =>
  isVerifiedGatewayPrincipalContext(principal) &&
  readVerifiedGatewayCompositionRevision(principal) === request.compositionRevision &&
  principal.authMethod !== 'system';

const originalScope = (
  scope: OperationalScope,
  principal: TrustedPrincipalContext,
  request: OwnerActionApprovalRequest,
) =>
  isVerifiedGatewayPrincipalContext(scope) &&
  readVerifiedGatewayCompositionRevision(scope) === request.compositionRevision &&
  scope.tenantId === principal.tenantId &&
  scope.principalId === principal.principalId &&
  scope.authBindingId === principal.authBindingId &&
  scope.legalEntityId === principal.legalEntityId;

/** All concrete services remain constructor requirements. No database/gate Layer is supplied here. */
export const makeOwnerActionApprovalsLive = (
  expectedDeployment: typeof OntosDeploymentIdentitySchema.Type,
  ownerRegistration: VerticalRuntimeRegistration,
) =>
  Layer.effectContext(
    Effect.gen(function* ownerActionApprovalsLayer() {
      const deployment = Object.freeze(
        yield* Schema.decodeEffect(OntosDeploymentIdentitySchema)(expectedDeployment).pipe(
          Effect.mapError(unavailable),
        ),
      );
      const registrations = yield* Effect.try({
        catch: unavailable,
        try: () => getVerticalRuntimeActions(ownerRegistration),
      });
      const applicationComposition = yield* ActiveApplicationCompositionService;
      const resolver = yield* OperationalScopeResolver;
      const { dispatcher, lifecycle, ports } = yield* makeOwnerActionMandateDispatch({
        expectedDeployment: deployment,
        ownerRegistration,
      });
      const { enforcement, frozenCommands } = ports;
      const { records } = ports.live;
      const owner = Object.freeze({ applicationComposition, expectedDeployment: deployment, ownerRegistration });
      const live: LiveApprovalServices = { ...ports.live, actionCommands: lifecycle };
      const approvalsFor = (scope: OperationalScope) => liveApprovalsService(live, scope);
      const prepareOwnerRequest = Effect.fn('OwnerActionApprovals.prepareRequest')(function* prepareOwnerRequest(
        input: OwnerActionApproveInput,
      ) {
        const request = yield* Schema.decodeUnknownEffect(OwnerActionApprovalRequestSchema, {
          onExcessProperty: 'error',
        })(input.request).pipe(Effect.mapError(refused));
        const correlationId = yield* Schema.decodeUnknownEffect(transportIdentifier)(
          input.requestHeaders['x-correlation-id'],
        ).pipe(Effect.mapError(refused));
        const { principal } = input;
        if (!trustedRequest(principal, request)) {
          return yield* authentication();
        }
        if (
          request.expectedOwner.moduleKey !== ownerRegistration.moduleId ||
          request.expectedOwner.deployment.appId !== deployment.appId ||
          request.expectedOwner.deployment.buildMarker !== deployment.buildMarker
        ) {
          return yield* refused();
        }
        // Resolve the ORIGINAL verified principal. An optional initial scope does not remove or add
        // a company. The original registered command below enforces its actual legal-entity scope.
        const scope = yield* resolver
          .resolve({
            audience: deployment.appId,
            correlationId,
            legalEntityScope: 'optional',
            principal,
          })
          .pipe(Effect.mapError(scopeFailure));
        if (!originalScope(scope, principal, request)) {
          return yield* authentication();
        }
        const kind = yield* enforcement.principalKinds
          .readKind({
            principalId: PrincipalIdSchema.make(scope.principalId),
            scope,
            tenantId: TenantIdSchema.make(scope.tenantId),
          })
          .pipe(Effect.mapError(unavailable));
        if (Option.isNone(kind) || kind.value !== 'human') {
          return yield* refused();
        }
        const frozen = yield* frozenCommands
          .load(scope, {
            proposalId: request.proposalId,
            scopeId: request.scopeId,
          })
          .pipe(Effect.mapError(unavailable));
        if (Option.isNone(frozen)) {
          return yield* refused();
        }
        const stored = yield* records
          .recordsFor(scope)
          .load({
            proposalId: request.proposalId,
            scopeId: request.scopeId,
            tenantId: TenantIdSchema.make(scope.tenantId),
          })
          .pipe(Effect.mapError(unavailable));
        if (
          Option.isNone(stored) ||
          stored.value.status !== request.expectedStatus ||
          stored.value.commandDigest !== request.expectedCommandDigest ||
          frozen.value.commandDigest !== request.expectedCommandDigest
        ) {
          return yield* new OwnerActionApprovalError({ code: 'approval_conflict' });
        }
        const routing = yield* readOwnerActionApprovalRouting(frozen.value);
        if (
          routing.owningModuleKey !== ownerRegistration.moduleId ||
          routing.scope.tenantId !== scope.tenantId ||
          routing.scope.legalEntityId !== scope.legalEntityId
        ) {
          return yield* refused();
        }
        const command = yield* decodeActionCommandV2(frozen.value.command.payload).pipe(Effect.mapError(refused));
        const source = yield* resolveRegisteredActionSourceV2({ command, owners: [owner], scope }).pipe(
          Effect.mapError(unavailable),
        );
        if (source.revision !== request.compositionRevision) {
          return yield* refused();
        }
        if (!registrations.includes(source.registration)) {
          return yield* refused();
        }
        const approvalCommand: ApproveCommand = {
          approver: { _tag: 'Principal', principalId: PrincipalIdSchema.make(scope.principalId) },
          approverKind: kind.value,
          policy: { selfApproval: 'forbidden' },
          proposalId: request.proposalId,
          scopeId: request.scopeId,
          tenantId: TenantIdSchema.make(scope.tenantId),
        };
        return { command: approvalCommand, proposal: stored.value, scope };
      });
      const approve: OwnerActionApprovalsService['approve'] = Effect.fn('OwnerActionApprovals.approve')(
        function* approve(input) {
          const prepared = yield* prepareOwnerRequest(input);
          const approved = yield* approvalsFor(prepared.scope)
            .approve(prepared.command)
            .pipe(Effect.mapError(approvalFailure));
          if (approved.id !== prepared.proposal.id || approved.status !== 'approved') {
            return yield* unavailable();
          }
          return { proposalId: approved.id, status: 'approved' as const };
        },
      );
      const inspect: OwnerActionApprovalsService['inspect'] = Effect.fn('OwnerActionApprovals.inspect')(
        function* inspect(input) {
          const prepared = yield* prepareOwnerRequest(input);
          const canApprove = yield* lifecycle.inspectApproval(prepared).pipe(Effect.mapError(approvalFailure));
          return { canApprove, proposalId: prepared.proposal.id };
        },
      );
      return Context.make(ActionMandateDispatcher, dispatcher).pipe(
        Context.add(OwnerActionApprovals, { approve, inspect }),
      );
    }),
  );
