/**
 * The bindings one route needs, derived from the installed manifests of the active Application Composition, and their
 * check against the holders Core reports. Core is the only writer of bindings; nothing here grants one.
 *
 * Every call is matched the way the gateway admits it: the calling module's installed manifest registers it
 * (`registeredWorkloadCalls`) and names its receiving operation as a requirement of the operation it serves
 * (`requirements`, `conditionalProviderAllows` in the Shell's gateway policy), and the installed receiver publishes it
 * (`registeredWorkloadCallReceiverIssue`).
 *
 * The route's own calls are its executor operations, the reads the adapters make for them and the recoveries Symmy's
 * code declares of them, each found in Symmy's installed manifest in the route's admission mode: a route whose deployed
 * Symmy declares no caller for one of them is refused. The nested calls of an operation are the calls its owner
 * registers under the workload the operation is served with and names as a requirement of exactly that operation, so a
 * route needs only what its own operations can call, at any depth.
 *
 * The integration principal needs one published workload of every Symmy carrier and Shell read the route uses, and
 * the workload of every live call (the gateway checks that the original integration principal holds it). Every call,
 * recovery included, runs as the one active system principal holding its workload, and a job route also needs exactly
 * one system principal holding the Symmy job workload.
 */
import { registeredWorkloadCallReceiverIssue } from '@app/core-runtime';
import type { OntosRegisteredWorkloadCallInput, RegisteredWorkloadCallReceiver } from '@app/core-runtime';
import type { WorkloadBindingHolder } from '@app/core-runtime/access/enforcement';
import { Option, Schema } from 'effect';

import { symmyIntegrationRegisteredWorkloadCalls } from '../registered-workload-calls.ts';
import type { SymmyRouteEnrollmentRefusal } from './symmy-route-enrollment-refused.ts';
import { SymmyRouteCallerSchema, symmyOperationName } from './symmy-route-enrollment.ts';
import type { SymmyRouteCallRef, SymmyRouteInventory, SymmyRouteInventoryOperation } from './symmy-route-enrollment.ts';

const SYMMY_MODULE = 'integration.symmy';
export const SYMMY_JOB_KEY = 'integration.symmy.execute-symmy-job';
const SYMMY_SYNC_ADMISSION = 'integration.symmy.admit-symmy-sync';

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

type Call = OntosRegisteredWorkloadCallInput;
interface RequiredOperation {
  readonly entrypointKey: string;
  readonly schemaVersion: string;
}
/** The published parts of an installed module contract the derivation reads. */
export interface SymmyRouteContract extends RegisteredWorkloadCallReceiver {
  readonly manifest: RegisteredWorkloadCallReceiver['manifest'] & {
    readonly module: { readonly id: string };
    readonly registeredWorkloadCalls?: readonly Call[] | undefined;
    readonly requirements?:
      | {
          readonly intrinsic: readonly { readonly requiredOperations: readonly RequiredOperation[] }[];
          readonly operations: readonly { readonly entrypointKey: string; readonly provider: RequiredOperation }[];
        }
      | undefined;
  };
}
type Contract = SymmyRouteContract;

const notPublished = (detail: string): SymmyRouteEnrollmentRefusal => ({ code: 'operation_not_published', detail });
const notDeclared = (detail: string): SymmyRouteEnrollmentRefusal => ({ code: 'call_not_declared', detail });

/** Whether Symmy makes a call itself in the route's admission mode: from its job worker or its synchronous admission. */
export const symmyCallInMode =
  (admission: SymmyRouteInventory['admission']) =>
  (call: Call): boolean =>
    call.jobKey === SYMMY_JOB_KEY &&
    call.sourceWorkloadKey === undefined &&
    (admission === 'sync'
      ? call.sourceActionKey === SYMMY_SYNC_ADMISSION && call.workerKey === undefined
      : call.workerKey === SYMMY_JOB_KEY && call.sourceActionKey === undefined);

/**
 * Whether the caller names the call's receiving operation as a requirement of the operation it serves, or of every
 * operation (intrinsically). A requirement's provider entrypoint is owned by its provider module, so the entrypoint and
 * version name the receiving operation exactly.
 */
const namesRequirement = (caller: Contract, served: string, call: RequiredOperation) => {
  const named = (operation: RequiredOperation) =>
    operation.entrypointKey === call.entrypointKey && operation.schemaVersion === call.schemaVersion;
  const { requirements } = caller.manifest;
  return (
    (requirements?.operations ?? []).some(
      ({ entrypointKey, provider }) => entrypointKey === served && named(provider),
    ) || (requirements?.intrinsic ?? []).some(({ requiredOperations }) => requiredOperations.some(named))
  );
};

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
        { entrypointKey: SYMMY_SYNC_ADMISSION, purpose: 'synchronous admission', schemaVersion: '1' },
        {
          entrypointKey: 'integration.symmy.api.symmy-sync-admission',
          purpose: 'synchronous receipt',
          schemaVersion: '1',
        },
      ]
    : []),
];

interface RouteCall {
  readonly call: Call;
  /** A live call also checks the original integration principal; a recovery runs on the executor alone. */
  readonly live: boolean;
}
interface RouteCalls {
  readonly calls: RouteCall[];
  readonly moduleKeys: Set<string>;
  readonly refusals: SymmyRouteEnrollmentRefusal[];
  readonly visited: Set<string>;
}

/**
 * Checks one call against its installed receiver and the route's company, then follows the nested calls the receiver
 * makes while it serves the call's operation. A company reaches a call unless a call before it runs without one.
 */
const followCall = (
  contracts: readonly Contract[],
  state: RouteCalls,
  input: { readonly call: Call; readonly company: boolean; readonly live: boolean },
) => {
  const { call, company, live } = input;
  const key = [call.audience, call.declarationKey, call.workloadKey, symmyOperationName(call), live, company].join('|');
  if (state.visited.has(key)) {
    return;
  }
  state.visited.add(key);
  const receiver = contracts.find((contract) => contract.deployment.appId === call.audience);
  const issue = registeredWorkloadCallReceiverIssue(call, receiver);
  if (issue !== undefined || receiver === undefined) {
    state.refusals.push(notPublished(issue ?? `${symmyOperationName(call)} has no installed receiver`));
    return;
  }
  if (call.legalEntityScope === 'required' && !company) {
    state.refusals.push({
      code: 'company_scope_required',
      detail: `${symmyOperationName(call)} is published for a company, which this route does not pass to it`,
    });
  }
  state.moduleKeys.add(receiver.manifest.module.id);
  state.calls.push({ call, live });
  for (const nested of receiver.manifest.registeredWorkloadCalls ?? []) {
    if (
      nested.jobKey === SYMMY_JOB_KEY &&
      nested.sourceWorkloadKey === call.workloadKey &&
      (nested.allowRecoverySource === true) === !live &&
      nested.workerKey === undefined &&
      nested.sourceActionKey === undefined &&
      nested.recoveryOf === undefined &&
      namesRequirement(receiver, call.entrypointKey, nested)
    ) {
      followCall(contracts, state, { call: nested, company: company && call.legalEntityScope !== 'forbidden', live });
    }
  }
};

/** The route's own calls in Symmy's installed manifest, followed to every nested call of their operations. */
const symmyRouteCalls = (input: {
  readonly companyScoped: boolean;
  readonly contracts: readonly Contract[];
  readonly enrolled: readonly SymmyRouteInventoryOperation[];
  readonly inventory: SymmyRouteInventory;
}): RouteCalls => {
  const { admission } = input.inventory;
  const state: RouteCalls = { calls: [], moduleKeys: new Set(), refusals: [], visited: new Set() };
  const symmy = input.contracts.find((contract) => contract.manifest.module.id === SYMMY_MODULE);
  if (symmy === undefined) {
    state.refusals.push(notPublished(`${SYMMY_MODULE} is not installed`));
    return state;
  }
  const inMode = symmyCallInMode(admission);
  const served = admission === 'sync' ? SYMMY_SYNC_ADMISSION : SYMMY_JOB_KEY;
  const declared = (symmy.manifest.registeredWorkloadCalls ?? []).filter(inMode);
  const own = (reference: SymmyRouteCallRef, recoveryOf?: string) => {
    const label =
      recoveryOf === undefined
        ? symmyOperationName(reference)
        : `the recovery of ${recoveryOf} by ${symmyOperationName(reference)}`;
    const [call, ...others] = declared.filter(
      (candidate) =>
        candidate.entrypointKey === reference.entrypointKey &&
        candidate.schemaVersion === reference.schemaVersion &&
        candidate.recoveryOf?.actionKey === recoveryOf &&
        (recoveryOf !== undefined || candidate.allowRecoverySource !== true),
    );
    if (call === undefined || others.length > 0) {
      state.refusals.push(
        notDeclared(`The installed ${SYMMY_MODULE} declares no single ${admission} call of ${label}`),
      );
    } else if (namesRequirement(symmy, served, call)) {
      followCall(input.contracts, state, { call, company: input.companyScoped, live: recoveryOf === undefined });
    } else {
      state.refusals.push(notDeclared(`The installed ${SYMMY_MODULE} names ${label} as no requirement of ${served}`));
    }
  };
  const recoveries: readonly Call[] = symmyIntegrationRegisteredWorkloadCalls;
  for (const operation of input.enrolled.filter(({ caller }) => caller === 'executor')) {
    for (const reference of [operation, ...(operation.reads ?? [])]) {
      own(reference);
    }
    for (const recovery of recoveries.filter(
      (call) => inMode(call) && call.recoveryOf?.actionKey === operation.entrypointKey,
    )) {
      own(recovery, operation.entrypointKey);
    }
  }
  return state;
};

/** The calls of every workload, named for the operator. */
const purposeOf = (workloadKey: string, calls: readonly RouteCall[]) =>
  [...new Set(calls.flatMap(({ call }) => (call.workloadKey === workloadKey ? [symmyOperationName(call)] : [])))].join(
    ', ',
  );

/**
 * Derives every binding the route's integration principal and executors need, with the modules the route reaches,
 * or the reasons the active composition cannot serve the route.
 */
export const deriveSymmyRouteBindings = (input: {
  /** Whether the route names a company, which then reaches every call that runs with one. */
  readonly companyScoped: boolean;
  readonly contracts: readonly Contract[];
  readonly enrolled: readonly SymmyRouteInventoryOperation[];
  readonly inventory: SymmyRouteInventory;
}): SymmyRouteBindingPlan => {
  const { contracts, enrolled, inventory } = input;
  const byModule = (moduleId: string) => contracts.find((contract) => contract.manifest.module.id === moduleId);
  const moduleKeys = new Set([SYMMY_MODULE]);
  const bindings: SymmyRequiredBinding[] = [];
  const refusals: SymmyRouteEnrollmentRefusal[] = [];
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
  const route = symmyRouteCalls(input);
  refusals.push(...route.refusals);
  for (const moduleKey of route.moduleKeys) {
    moduleKeys.add(moduleKey);
  }
  const live = route.calls.filter((call) => call.live);
  for (const workloadKey of new Set(live.map(({ call }) => call.workloadKey))) {
    bindings.push({ identity: 'integration', purpose: purposeOf(workloadKey, live), workloads: [workloadKey] });
  }
  for (const workloadKey of new Set(route.calls.map(({ call }) => call.workloadKey))) {
    bindings.push({ identity: 'executor', purpose: purposeOf(workloadKey, route.calls), workloads: [workloadKey] });
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
