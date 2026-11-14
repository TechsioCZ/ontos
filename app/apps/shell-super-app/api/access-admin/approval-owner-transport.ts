import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import type { OperationalScope } from '@app/core-runtime';
import type { FrozenCommandRecord } from '@app/core-runtime/access/approvals/frozen-command';
import {
  OWNER_ACTION_APPROVAL_PATH,
  OWNER_ACTION_APPROVAL_INSPECTION_PATH,
  OwnerActionApprovalApi,
  OwnerActionApprovalInspectionResponseSchema,
  OwnerActionApprovalRequestSchema,
  OwnerActionApprovalResponseSchema,
} from '@app/core-runtime/access/approvals/owner-api';
import { readOwnerActionApprovalRouting } from '@app/core-runtime/access/approvals/owner-runtime';
import { Context, Effect, Layer, Schema } from 'effect';

import { GatewayIssuer } from '../auth/gateway-issuer.ts';
import { ShellInstalledModuleCatalog } from '../modules/installed-module-catalog.ts';
import type { ShellInstalledCatalog } from '../modules/installed-module-catalog.ts';
import { ApprovalOwnerIdentity } from './approval-owner-identity.ts';
import { ApprovalOwnerModuleTransport } from './approval-owner-module-transport.ts';
import {
  approvalOwnerConflict as conflict,
  approvalOwnerRefused as refused,
  approvalOwnerUnavailable as unavailable,
} from './approval-owner-errors.ts';
import type { ApprovalCommandFailure, ApprovalRecord } from './approvals-contract.ts';

interface ApprovalOwnerTransportInput {
  readonly frozen: FrozenCommandRecord;
  readonly headers: Headers;
  readonly proposal: ApprovalRecord;
}
export interface ApprovalOwnerTransportService {
  readonly approve: (
    scope: OperationalScope,
    input: ApprovalOwnerTransportInput,
  ) => Effect.Effect<void, ApprovalCommandFailure>;
  readonly inspect: (
    scope: OperationalScope,
    input: ApprovalOwnerTransportInput,
  ) => Effect.Effect<boolean, ApprovalCommandFailure>;
}
export class ApprovalOwnerTransport extends Context.Service<ApprovalOwnerTransport, ApprovalOwnerTransportService>()(
  '@app/shell-super-app/api/access-admin/approval-owner-transport/ApprovalOwnerTransport',
) {}

const encodeRequest = Schema.encodeEffect(Schema.fromJsonString(OwnerActionApprovalRequestSchema));
const decodeResponse = Schema.decodeUnknownEffect(Schema.fromJsonString(OwnerActionApprovalResponseSchema), {
  onExcessProperty: 'error',
});
const decodeInspection = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OwnerActionApprovalInspectionResponseSchema),
  { onExcessProperty: 'error' },
);
const operationKeys = {
  approve: `${OwnerActionApprovalApi.groups.ownerActionApprovals.identifier}.${OwnerActionApprovalApi.groups.ownerActionApprovals.endpoints.approve.identifier}`,
  inspect: `${OwnerActionApprovalApi.groups.ownerActionApprovals.identifier}.${OwnerActionApprovalApi.groups.ownerActionApprovals.endpoints.inspect.identifier}`,
};
const operationPaths = { approve: OWNER_ACTION_APPROVAL_PATH, inspect: OWNER_ACTION_APPROVAL_INSPECTION_PATH };
const discardResponse = (response: Response) => {
  const { body } = response;
  return body === null
    ? Effect.void
    : Effect.tryPromise(body.cancel.bind(body)).pipe(
        Effect.timeout('3 seconds'),
        Effect.matchEffect({
          onFailure: (cause) => Effect.logDebug('Owner approval response disposal failed', cause),
          onSuccess: () => Effect.void,
        }),
      );
};

const matchingFrozenProposal = (scope: OperationalScope, { frozen, proposal }: ApprovalOwnerTransportInput) =>
  proposal.tenantId === scope.tenantId &&
  frozen.tenantId === scope.tenantId &&
  frozen.proposalId === proposal.id &&
  frozen.scopeId === proposal.scopeId &&
  frozen.commandDigest === proposal.commandDigest &&
  proposal.status === 'pending';

const selectOwner = Effect.fn('ApprovalOwnerTransport.selectOwner')(function* selectOwner(
  catalog: ShellInstalledCatalog,
  owningModuleKey: string,
  operation: keyof typeof operationKeys,
) {
  const owners = catalog.composition.modules.filter(({ moduleId }) => moduleId === owningModuleKey);
  const contracts = catalog.contracts.filter(({ manifest }) => manifest.module.id === owningModuleKey);
  const [owner] = owners;
  const [contract] = contracts;
  if (
    owners.length !== 1 ||
    contracts.length !== 1 ||
    owner === undefined ||
    contract === undefined ||
    owner.deployment.appId !== contract.deployment.appId ||
    owner.deployment.buildMarker !== contract.deployment.buildMarker ||
    !contract.manifest.publicSurface.api.some(
      ({ key, operationKeys: publishedOperations }) =>
        key === `${owningModuleKey}.owner-action-approvals` && publishedOperations.includes(operationKeys[operation]),
    )
  ) {
    return yield* Effect.fail(unavailable());
  }
  return owner;
});

/** Only the approved owner release receives the original human's fresh audience-bound assertion. */
export const makeApprovalOwnerTransport = Effect.gen(function* makeApprovalOwnerTransport() {
  const identity = yield* ApprovalOwnerIdentity;
  const issuer = yield* GatewayIssuer;
  const catalogService = yield* ShellInstalledModuleCatalog;
  const transport = yield* ApprovalOwnerModuleTransport;
  const requestOwner = Effect.fn('ApprovalOwnerTransport.request')(function* requestOwner(
    scope: OperationalScope,
    { frozen, headers, proposal }: ApprovalOwnerTransportInput,
    operation: keyof typeof operationKeys,
  ) {
    if (!matchingFrozenProposal(scope, { frozen, headers, proposal })) {
      return yield* Effect.fail(refused());
    }
    const routing = yield* readOwnerActionApprovalRouting(frozen).pipe(Effect.mapError(refused));
    if (routing.scope.tenantId !== scope.tenantId) {
      return yield* Effect.fail(refused());
    }
    const catalog = yield* catalogService.load.pipe(Effect.mapError(unavailable));
    // An unpublished owner route must fail before asking the session provider for another identity.
    const { owner, principal } = yield* selectOwner(catalog, routing.owningModuleKey, operation).pipe(
      Effect.flatMap((admittedOwner) =>
        identity
          .resolve(headers, scope, routing.scope.legalEntityId)
          .pipe(Effect.map((resolvedPrincipal) => ({ owner: admittedOwner, principal: resolvedPrincipal }))),
      ),
    );
    const assertion = yield* issuer
      .issue({
        audience: owner.deployment.appId,
        compositionRevision: catalog.composition.revision,
        principal: yield* Schema.encodeEffect(TrustedPrincipalContextSchema)(principal).pipe(
          Effect.mapError(unavailable),
        ),
      })
      .pipe(Effect.mapError(unavailable));
    const response = yield* transport
      .send(
        new Request(new URL(`/${owner.deployment.appId}-api${operationPaths[operation]}`, 'https://module.invalid'), {
          body: yield* encodeRequest({
            compositionRevision: catalog.composition.revision,
            expectedCommandDigest: frozen.commandDigest,
            expectedOwner: { deployment: owner.deployment, moduleKey: routing.owningModuleKey },
            expectedStatus: 'pending',
            proposalId: frozen.proposalId,
            scopeId: frozen.scopeId,
          }).pipe(Effect.mapError(unavailable)),
          headers: {
            accept: 'application/json',
            authorization: `Bearer ${assertion.token}`,
            'content-type': 'application/json',
            'x-correlation-id': scope.correlationId,
            'x-ontos-composition-revision': catalog.composition.revision,
          },
          method: 'POST',
        }),
        owner,
      )
      .pipe(Effect.mapError(unavailable));
    if (response.status === 401 || response.status === 403) {
      yield* discardResponse(response);
      return yield* Effect.fail(refused());
    }
    if (response.status === 409) {
      yield* discardResponse(response);
      return yield* Effect.fail(conflict());
    }
    if (response.status !== 200) {
      yield* discardResponse(response);
      return yield* Effect.fail(unavailable());
    }
    return yield* Effect.tryPromise(response.text.bind(response)).pipe(
      Effect.timeout('10 seconds'),
      Effect.mapError(unavailable),
    );
  });
  return {
    approve: Effect.fn('ApprovalOwnerTransport.approve')(function* approveOwner(scope, input) {
      const approved = yield* requestOwner(scope, input, 'approve').pipe(
        Effect.flatMap((text) => decodeResponse(text).pipe(Effect.mapError(unavailable))),
      );
      if (approved.proposalId !== input.proposal.id || approved.status !== 'approved') {
        return yield* Effect.fail(unavailable());
      }
      return yield* Effect.void;
    }),
    inspect: Effect.fn('ApprovalOwnerTransport.inspect')(function* inspectOwner(scope, input) {
      const inspection = yield* requestOwner(scope, input, 'inspect').pipe(
        Effect.flatMap((text) => decodeInspection(text).pipe(Effect.mapError(unavailable))),
      );
      if (inspection.proposalId !== input.proposal.id) {
        return yield* Effect.fail(unavailable());
      }
      return inspection.canApprove;
    }),
  } satisfies ApprovalOwnerTransportService;
});

export const ApprovalOwnerTransportLive = Layer.effect(ApprovalOwnerTransport, makeApprovalOwnerTransport);
