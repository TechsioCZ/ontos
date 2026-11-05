import { makeAccessDecisionService, makeDrizzleAccessPrincipalKinds } from '@app/core-runtime/access/enforcement';
import type { AccessDecisionPorts, AccessWorkloadBindings } from '@app/core-runtime/access/enforcement';
import { Effect } from 'effect';

import type { CoreDatabaseExecutor } from '../../src/db/types.ts';
import { bindAccessGate } from '../../src/operations/access-gate.ts';
import type { BoundAccessGate } from '../../src/operations/access-gate.ts';

/**
 * The real enforcement seam over a fixed capability set, for suites whose subject is identity
 * mechanics rather than authority resolution. The actor kind comes from Core's own `core.principals`
 * rows, so a workload, an agent and a principal of no known kind are refused by the production rule
 * instead of by the test double, and the engine sees exactly the cells a suite grants here.
 *
 * A workload is admitted only when the suite registers its key (O73): `workloads` maps a principal
 * id to the workload keys it may run, and the default is none, so a workload that is not bound is
 * refused with `deny.workload_unbound`.
 *
 * The suite builds the fixed authority and check ports itself: its witness fixtures belong to its own
 * directory, and this module owns only the composition of the real seam over them.
 */
export const bindFixedAccessGate = (input: {
  readonly authorityFor: AccessDecisionPorts['authorityFor'];
  readonly check: AccessDecisionPorts['check'];
  readonly executor: CoreDatabaseExecutor;
  /** The registered workload keys by principal id; absent means every workload is unbound (O73). */
  readonly workloads?: Readonly<Record<string, readonly string[]>>;
}): BoundAccessGate => {
  const principalKinds = makeDrizzleAccessPrincipalKinds({ executor: input.executor });
  const workloadBindings: AccessWorkloadBindings = {
    readActiveWorkloadKeys: ({ principalId }) => Effect.succeed(new Set(input.workloads?.[principalId])),
  };
  const ports = {
    candidates: { listCandidateIds: () => Effect.succeed([]) },
    check: input.check,
    decisionLog: { record: () => Effect.void },
    intent: { authorityFor: input.authorityFor },
    principalKinds,
    workloadBindings,
  } satisfies Parameters<typeof bindAccessGate>[1];
  const seam = makeAccessDecisionService({
    authorityFor: input.authorityFor,
    check: input.check,
    decisionLog: ports.decisionLog,
    legalEntities: ports.candidates,
    principalKinds,
    workloadBindings,
  });
  return bindAccessGate(seam, ports);
};
