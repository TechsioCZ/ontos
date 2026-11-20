/**
 * The bindings one route needs, derived from the active Application Composition, and their check against the
 * holders Core reports. Core is the only writer of bindings; nothing here grants one.
 *
 * The integration principal (the Symmy API key) needs one published workload of every Symmy admission, poll and
 * route context carrier the route uses and of every owner read the Shell or the admission makes for it. A registered
 * call that is not a recovery also checks that the original integration principal holds the call's own workload, so
 * the integration principal needs those as well. Every registered call, recovery included, runs as the one active
 * system principal that holds its workload (`admitRegisteredGatewayWorkload` and the registered assertion admit
 * exactly one); a job route also needs exactly one system principal enrolled for the Symmy job itself.
 *
 * The calls are the executor operations' own published calls, their recoveries, the reads the adapters make for
 * them, and every call the installed owners publish under one of those workloads (a nested owner call such as the
 * Market read Pricing makes while it defines a price), until none is added.
 */
import { registeredWorkloadCallReceiverIssue } from '@app/core-runtime';
import type { OntosRegisteredWorkloadCallInput, RegisteredWorkloadCallReceiver } from '@app/core-runtime';
import type { WorkloadBindingHolder } from '@app/core-runtime/access/enforcement';
import { Option, Schema } from 'effect';

import { symmyIntegrationRegisteredWorkloadCalls } from '../registered-workload-calls.ts';
import type { SymmyRouteEnrollmentRefusal } from './symmy-route-enrollment-refused.ts';
import { SymmyRouteCallerSchema, symmyExecutorCallsOf, symmyOperationName } from './symmy-route-enrollment.ts';
import type { SymmyRouteCallRef, SymmyRouteInventory, SymmyRouteInventoryOperation } from './symmy-route-enrollment.ts';

const SYMMY_MODULE = 'integration.symmy';
export const SYMMY_JOB_KEY = 'integration.symmy.execute-symmy-job';

/** A binding one of the two route identities needs: any one of the named workloads. */
export const SymmyRequiredBindingSchema = Schema.Struct({
  identity: SymmyRouteCallerSchema,
  purpose: Schema.String,
  workloads: Schema.NonEmptyArray(Schema.String),
});
export type SymmyRequiredBinding = typeof SymmyRequiredBindingSchema.Type;

export interface SymmyRouteBindingPlan {
  readonly bindings: readonly SymmyRequiredBinding[];
  /** The modules every call and read of the route reaches, which must be active in the Tenant. */
  readonly moduleKeys: readonly string[];
  readonly refusals: readonly SymmyRouteEnrollmentRefusal[];
}

/** The published parts of an installed module contract the derivation reads. */
export interface SymmyRouteContract extends RegisteredWorkloadCallReceiver {
  readonly manifest: RegisteredWorkloadCallReceiver['manifest'] & {
    readonly module: { readonly id: string };
    readonly registeredWorkloadCalls?: readonly OntosRegisteredWorkloadCallInput[] | undefined;
  };
}
type Contract = SymmyRouteContract;
type Call = Pick<
  OntosRegisteredWorkloadCallInput,
  'audience' | 'declarationKey' | 'entrypointKey' | 'legalEntityScope' | 'schemaVersion' | 'workloadKey'
>;

const notPublished = (detail: string): SymmyRouteEnrollmentRefusal => ({ code: 'operation_not_published', detail });

/** The workloads a published operation admits: an Action's own carrier or a read's published carrier. */
const publishedWorkloads = (contract: Contract | undefined, operation: SymmyRouteCallRef): readonly string[] => {
  if (contract === undefined) {
    return [];
  }
  const { actions, operationContracts } = contract.manifest.publicSurface;
  const matches = (candidate: {
    readonly entrypoint: { readonly entrypointKey: string };
    readonly schemaVersion: string;
  }) =>
    candidate.entrypoint.entrypointKey === operation.entrypointKey &&
    candidate.schemaVersion === operation.schemaVersion;
  return [
    ...actions.flatMap((action) => (matches(action) ? (action.accessWorkload?.workloads ?? []) : [])),
    ...(operationContracts ?? []).flatMap((contractRead) =>
      matches(contractRead) ? (contractRead.workloadCarrier?.workloads ?? []) : [],
    ),
  ];
};

/** What Symmy itself publishes for the integration principal to use a route of this admission kind. */
const symmyCarriers = (admission: SymmyRouteInventory['admission']) => [
  { entrypointKey: 'integration.symmy.api.symmy-route-context', purpose: 'route context', schemaVersion: '1' },
  ...(admission === 'job'
    ? [
        { entrypointKey: 'integration.symmy.admit-symmy-job', purpose: 'job admission', schemaVersion: '1' },
        { entrypointKey: 'integration.symmy.api.symmy-job-status', purpose: 'job read', schemaVersion: '1' },
      ]
    : []),
  ...(admission === 'sync'
    ? [
        { entrypointKey: 'integration.symmy.admit-symmy-sync', purpose: 'synchronous admission', schemaVersion: '1' },
        {
          entrypointKey: 'integration.symmy.api.symmy-sync-admission',
          purpose: 'synchronous receipt',
          schemaVersion: '1',
        },
      ]
    : []),
];

/** The calls Symmy registers in the route's admission mode that the predicate selects. */
const symmyCalls = (
  admission: SymmyRouteInventory['admission'],
  predicate: (
    call: Call & {
      readonly recoveryOf?: { readonly actionKey: string };
    },
  ) => boolean,
) =>
  symmyIntegrationRegisteredWorkloadCalls.filter(
    (call) => (admission === 'sync' ? 'sourceActionKey' in call : 'workerKey' in call) && predicate(call),
  );

interface RouteCalls {
  /** Calls that also check the original integration principal: the operations' own calls and their reads. */
  readonly live: ReadonlySet<Call>;
  /** Recoveries, which run on the executor alone. */
  readonly recovering: ReadonlySet<Call>;
}

/** The executor operations' own calls, the reads the adapters make for them, and the recoveries of them. */
const symmyRouteCalls = (inventory: SymmyRouteInventory, enrolled: readonly SymmyRouteInventoryOperation[]) => {
  const refusals: SymmyRouteEnrollmentRefusal[] = [];
  const live = new Set<Call>();
  const recovering = new Set<Call>();
  for (const operation of enrolled.filter(({ caller }) => caller === 'executor')) {
    for (const reference of [operation, ...(operation.reads ?? [])]) {
      const [call, ...others] = symmyExecutorCallsOf(inventory.admission, reference);
      if (call === undefined || others.length > 0) {
        refusals.push(
          notPublished(`Symmy registers no single ${inventory.admission} call of ${symmyOperationName(reference)}`),
        );
      } else {
        live.add(call);
      }
    }
    for (const recovery of symmyCalls(
      inventory.admission,
      (candidate) => candidate.recoveryOf?.actionKey === operation.entrypointKey,
    )) {
      recovering.add(recovery);
    }
  }
  return { calls: { live, recovering }, refusals };
};

/** Adds every call the installed owners publish under a workload the route already calls, until none is added. */
const withNestedCalls = (contracts: readonly Contract[], calls: RouteCalls): RouteCalls => {
  const nested = contracts.flatMap((contract) =>
    (contract.manifest.registeredWorkloadCalls ?? []).filter(
      (call) => call.jobKey === SYMMY_JOB_KEY && call.sourceWorkloadKey !== undefined,
    ),
  );
  const live = new Set(calls.live);
  const recovering = new Set(calls.recovering);
  let size = -1;
  while (size !== live.size + recovering.size) {
    size = live.size + recovering.size;
    const sources = {
      live: new Set([...live].map(({ workloadKey }) => workloadKey)),
      recovering: new Set([...recovering].map(({ workloadKey }) => workloadKey)),
    };
    for (const call of nested) {
      const recovery = call.allowRecoverySource === true;
      if ((recovery ? sources.recovering : sources.live).has(call.sourceWorkloadKey ?? '')) {
        (recovery ? recovering : live).add(call);
      }
    }
  }
  return { live, recovering };
};

/** The calls of every workload, named for the operator. */
const purposeOf = (workloadKey: string, calls: Iterable<Call>) =>
  [...new Set([...calls].flatMap((call) => (call.workloadKey === workloadKey ? [symmyOperationName(call)] : [])))].join(
    ', ',
  );

/**
 * Derives every binding the route's integration principal and executors need, with the modules the route reaches,
 * or the reasons the active composition cannot serve the route.
 */
export const deriveSymmyRouteBindings = (input: {
  readonly contracts: readonly Contract[];
  readonly enrolled: readonly SymmyRouteInventoryOperation[];
  readonly inventory: SymmyRouteInventory;
}): SymmyRouteBindingPlan => {
  const { contracts, enrolled, inventory } = input;
  const byModule = (moduleId: string) => contracts.find((contract) => contract.manifest.module.id === moduleId);
  const byAppId = (appId: string) => contracts.find((contract) => contract.deployment.appId === appId);
  const moduleKeys = new Set([SYMMY_MODULE]);
  const bindings: SymmyRequiredBinding[] = [];
  const own = symmyRouteCalls(inventory, enrolled);
  const refusals: SymmyRouteEnrollmentRefusal[] = [...own.refusals];
  const reads = [
    ...symmyCarriers(inventory.admission).map((carrier) => ({ ...carrier, moduleId: SYMMY_MODULE })),
    ...[...enrolled.filter(({ caller }) => caller === 'integration'), ...(inventory.admissionReads ?? [])].map(
      (operation) => ({ ...operation, purpose: symmyOperationName(operation) }),
    ),
  ];
  for (const operation of reads) {
    const [first, ...rest] = publishedWorkloads(byModule(operation.moduleId), operation);
    if (first === undefined) {
      refusals.push(notPublished(`${symmyOperationName(operation)} is not published by ${operation.moduleId}`));
    } else {
      moduleKeys.add(operation.moduleId);
      bindings.push({ identity: 'integration', purpose: operation.purpose, workloads: [first, ...rest] });
    }
  }
  const { live, recovering } = withNestedCalls(contracts, own.calls);
  const all = new Set([...live, ...recovering]);
  for (const call of all) {
    const receiver = byAppId(call.audience);
    const issue = registeredWorkloadCallReceiverIssue(call, receiver);
    if (issue === undefined && receiver !== undefined) {
      moduleKeys.add(receiver.manifest.module.id);
    } else {
      refusals.push(notPublished(issue ?? `${symmyOperationName(call)} has no installed receiver`));
    }
  }
  for (const workloadKey of new Set([...live].map((call) => call.workloadKey))) {
    bindings.push({ identity: 'integration', purpose: purposeOf(workloadKey, live), workloads: [workloadKey] });
  }
  for (const workloadKey of new Set([...all].map((call) => call.workloadKey))) {
    bindings.push({ identity: 'executor', purpose: purposeOf(workloadKey, all), workloads: [workloadKey] });
  }
  if (inventory.admission === 'job') {
    bindings.push({ identity: 'executor', purpose: 'Symmy job execution', workloads: [SYMMY_JOB_KEY] });
  }
  return { bindings, moduleKeys: [...moduleKeys].toSorted(), refusals };
};

/** Every workload a binding plan names, once. */
export const symmyBindingWorkloads = (bindings: readonly SymmyRequiredBinding[]) => [
  ...new Set(bindings.flatMap(({ workloads }) => workloads)),
];

/**
 * Checks each required binding by name against Core's holders: the integration principal (of kind integration) holds
 * one workload of each of its bindings, and exactly one active system principal holds each executor workload.
 * Returns the refusals, each naming the missing or ambiguous binding, and the executor of each workload.
 */
export const checkSymmyRouteBindings = (input: {
  readonly bindings: readonly SymmyRequiredBinding[];
  readonly holders: ReadonlyMap<string, readonly WorkloadBindingHolder[]>;
  readonly principalId: string;
}) => {
  const holdersOf = (workloadKey: string) => input.holders.get(workloadKey) ?? [];
  const otherKind = [...input.holders.values()]
    .flat()
    .find(({ kind, principalId }) => principalId === input.principalId && kind !== 'integration');
  const refusals: SymmyRouteEnrollmentRefusal[] = Option.match(Option.fromUndefinedOr(otherKind), {
    onNone: () => [],
    onSome: ({ kind }) => [
      { code: 'integration_principal_not_integration', detail: `The route principal is a ${kind} principal` },
    ],
  });
  const executors = new Map<string, string>();
  for (const binding of input.bindings) {
    const [workloadKey] = binding.workloads;
    if (binding.identity === 'integration') {
      if (
        !binding.workloads.some((workload) =>
          holdersOf(workload).some(
            ({ kind, principalId }) => principalId === input.principalId && kind === 'integration',
          ),
        )
      ) {
        refusals.push({
          code: 'integration_binding_missing',
          detail: `The integration principal holds none of ${binding.workloads.join(' or ')}, needed for ${binding.purpose}`,
        });
      }
      continue;
    }
    const systems = holdersOf(workloadKey).filter(({ kind }) => kind === 'system');
    const [system] = systems;
    if (system === undefined) {
      refusals.push({
        code: 'executor_binding_missing',
        detail: `No active system principal holds ${workloadKey}, needed for ${binding.purpose}`,
      });
    } else if (systems.length > 1) {
      refusals.push({
        code: 'executor_binding_not_unique',
        detail: `${String(systems.length)} active system principals hold ${workloadKey}: ${systems.map(({ principalId }) => principalId).join(', ')}`,
      });
    } else {
      executors.set(workloadKey, system.principalId);
    }
  }
  return { executors, refusals };
};
