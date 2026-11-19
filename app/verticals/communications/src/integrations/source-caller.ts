import type { OperationalScope } from '@app/core-runtime';
import { readVerifiedGatewayWorkload } from '@app/core-runtime/auth/system-principal-context-provenance';
import { Option } from 'effect';

/**
 * Who CALLED the intake Action, as Core verified it, never as the payload claims it.
 *
 * `source.moduleKey` in the Communication Request is only a CLAIM of the issuer. The Action's workload binding
 * (`communications.core.request-source`) is one module-wide credential that every registered source worker shares, so
 * the binding alone cannot tell source A from source B. The only verified carrier that names the calling MODULE is the
 * registered gateway workload scope: `readVerifiedGatewayWorkload(scope).workerModuleKey` is set by the Shell only from
 * the issuing source's own verified, live Outbox delivery (`gateway-workload-evidence`, `RegisteredWorkload` subject),
 * and Core seals it on the exact redeemed context (a payload, header or spread copy of the scope cannot carry it).
 *
 * Why not the other carriers:
 * - `readVerifiedGatewayActor(scope)?.appId` names a topology APP, not a module, and a workload context never carries an
 *   actor (Core refuses the combination);
 * - a registered ADMISSION (an Action calling directly, not from an Outbox worker) has no worker module. It is refused
 *   here: a source issues its request AFTER its own authoritative commit, from its own delivery, which is also what
 *   makes a rolled-back source operation unable to reach this Action (AC-07).
 *
 * A human or session principal never reaches the handler: the Action carries `accessWorkload` alone, so Core refuses it
 * at the access seam (`WORKLOAD_ONLY`). This check is the second, module-level line behind that one.
 */
export const verifiedCallerModuleOf = (scope: OperationalScope): Option.Option<string> =>
  Option.fromNullishOr(readVerifiedGatewayWorkload(scope)?.workerModuleKey);

/** True only when Core verified the caller and it IS the module the request claims as its source (fail closed otherwise). */
export const callerIsClaimedSource = (scope: OperationalScope, claimedSourceModuleKey: string): boolean =>
  Option.exists(verifiedCallerModuleOf(scope), (caller) => caller === claimedSourceModuleKey);

/** The caller of ONE invocation, as the Action's own service: bound from the verified scope in production, scripted in boundary tests. */
export interface SourceCallerService {
  readonly isClaimedSource: (claimedSourceModuleKey: string) => boolean;
}

export const sourceCallerOf = (scope: OperationalScope): SourceCallerService => ({
  isClaimedSource: (claimedSourceModuleKey) => callerIsClaimedSource(scope, claimedSourceModuleKey),
});
