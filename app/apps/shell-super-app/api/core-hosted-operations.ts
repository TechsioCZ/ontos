import { GatewayAssertionRedemptionService } from '@app/core-runtime/auth/gateway-assertion-redemption';
import { readVerifiedGatewayActor } from '@app/core-runtime/auth/system-principal-context-provenance';
import { CoreReadReceiverBindings, assetCurrentRead, makeCoreReadReceiverBindings } from '@app/core-runtime';
import { SHELL_HOST_APP_ID, coreOperations } from '@app/core-runtime/sdk/core';
import {
  ActionPrincipalScopeErrorSchema,
  ActionPrincipalUnavailableErrorSchema,
  bindGatewayPrincipalVerifier,
} from '@app/gateway-principal-verifier/server';
import { makeGovernedReadProblems } from '@app/shared-contracts/server/effect-bff-runtime';
import { Effect, Layer } from 'effect';
import type { Redacted } from 'effect';

import { ultramodernDeliveryUnit } from '../shared/ultramodern-build.ts';
import {
  CoreHostedOperationAuthenticationProblemSchema,
  CoreHostedOperationForbiddenProblemSchema,
  CoreHostedOperationInternalProblemSchema,
  CoreHostedOperationInvalidProblemSchema,
  CoreHostedOperationNotFoundProblemSchema,
  CoreHostedOperationPolicyConflictProblemSchema,
  CoreHostedOperationPolicyProblemSchema,
  CoreHostedOperationUnavailableProblemSchema,
} from '../shared/core-hosted-operations.ts';
import { ShellInstalledModuleCatalog } from './modules/installed-module-catalog.ts';

/*
 * The receiving side of the Core operations the Shell host serves to modules (#1443 P2). Everything a vertical's
 * receiver proves, this proves for the Shell deployment, and one thing more: the assertion must have been issued to a
 * MODULE on behalf of a requester, and that module's own installed release must declare exactly this operation.
 *
 * - signature, issuer, exact audience (the Shell app id), approved release, expiry and the calling module's approved
 *   release are verified by the shared verifier bound to this deployment;
 * - the `(issuer, audience, jti)` identity is consumed once, durably, before anything runs;
 * - a direct assertion of a person (no calling module) is refused here: a person reaches Core Media through the
 *   session routes, never through this one;
 * - the read then runs as the REQUESTER: Core re-resolves the principal's binding, tenant and namespace and the
 *   read's own SpiceDB decision answers, so the calling module's service credential adds no permission.
 */

const principalVerifier = bindGatewayPrincipalVerifier(SHELL_HOST_APP_ID, ultramodernDeliveryUnit);

export const coreHostedReadReceiverBindingsLive = Layer.succeed(
  CoreReadReceiverBindings,
  makeCoreReadReceiverBindings([{ callers: ['catalog'], registration: assetCurrentRead }]),
);

const unauthorized = () =>
  Effect.fail(
    ActionPrincipalScopeErrorSchema.make({ reason: 'The Bearer assertion was not issued for this operation' }),
  );

/**
 * The calling module of a verified assertion and what its own installed release declares: a requirement on one of
 * the Shell-hosted operations that relays the requester. Anything else is not authorized to call this endpoint.
 */
const callingModuleDeclaresHostedOperation = Effect.fn('CoreHostedOperation.authorizeCaller')(
  function* callingModuleDeclaresHostedOperation(actor: { readonly appId: string; readonly buildMarker: string }) {
    const catalog = yield* ShellInstalledModuleCatalog;
    const installed = yield* catalog.load.pipe(
      Effect.catchTag('InstalledModuleCatalogUnavailableError', () =>
        Effect.fail(ActionPrincipalUnavailableErrorSchema.make({ reason: 'The installed catalog is unavailable' })),
      ),
    );
    const contract = installed.contracts.find(
      ({ deployment }) => deployment.appId === actor.appId && deployment.buildMarker === actor.buildMarker,
    );
    const declares =
      contract?.manifest.requirements?.operations.some(
        (requirement) =>
          requirement.callers?.some((caller) => caller.kind === 'person') === true &&
          requirement.provider.moduleId === coreOperations.assetCurrent.provider.moduleId &&
          requirement.provider.entrypointKey === coreOperations.assetCurrent.provider.entrypointKey &&
          requirement.provider.schemaVersion === coreOperations.assetCurrent.provider.schemaVersion,
      ) === true;
    return yield* declares ? Effect.void : unauthorized();
  },
);

/** The audience-bound verifier of this endpoint: verified, redeemed once, and issued to a module for its requester. */
export const authenticateHostedOperationPrincipal = Effect.fn('CoreHostedOperation.authenticate')(
  function* authenticateHostedOperationPrincipal(authorization: Redacted.Redacted<string | undefined>) {
    const redemption = yield* GatewayAssertionRedemptionService;
    const principal = yield* principalVerifier.verifyAndRedeem(authorization, { redemption });
    const actor = readVerifiedGatewayActor(principal);
    if (actor === undefined) {
      return yield* unauthorized();
    }
    yield* callingModuleDeclaresHostedOperation(actor);
    return principal;
  },
);

/** The sanitized governed-read problems of the hosted endpoint. */
export const hostedOperationProblems = makeGovernedReadProblems({
  authentication: CoreHostedOperationAuthenticationProblemSchema,
  forbidden: CoreHostedOperationForbiddenProblemSchema,
  internal: CoreHostedOperationInternalProblemSchema,
  invalid: CoreHostedOperationInvalidProblemSchema,
  notFound: CoreHostedOperationNotFoundProblemSchema,
  policyConflict: CoreHostedOperationPolicyConflictProblemSchema,
  policyIneligible: CoreHostedOperationPolicyProblemSchema,
  unavailable: CoreHostedOperationUnavailableProblemSchema,
});

/** Maps the verifier's refusals onto the endpoint's two authentication problems (401 and a retryable 503). */
export const authenticateHostedOperation = (
  authorization: Redacted.Redacted<string | undefined>,
  authenticationProblems: {
    readonly authentication: () => ReturnType<typeof hostedOperationProblems.authentication>;
    readonly unavailable: () => ReturnType<typeof hostedOperationProblems.unavailable>;
  },
) =>
  authenticateHostedOperationPrincipal(authorization).pipe(
    Effect.catchTags({
      ActionPrincipalConfigurationError: () => Effect.fail(authenticationProblems.unavailable()),
      ActionPrincipalExpiredError: () => Effect.fail(authenticationProblems.authentication()),
      ActionPrincipalInvalidError: () => Effect.fail(authenticationProblems.authentication()),
      ActionPrincipalMissingError: () => Effect.fail(authenticationProblems.authentication()),
      ActionPrincipalScopeError: () => Effect.fail(authenticationProblems.authentication()),
      ActionPrincipalUnavailableError: () => Effect.fail(authenticationProblems.unavailable()),
    }),
  );
