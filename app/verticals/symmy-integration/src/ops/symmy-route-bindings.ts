/**
 * The bindings one route needs, derived from the installed manifests of the active Application Composition, and their
 * check against the holders Core reports. Core is the only writer of bindings; nothing here grants one.
 *
 * Every call is matched the way the gateway admits it: the calling module's installed manifest registers it
 * (`registeredWorkloadCalls`), one of its requirements names the receiving module, operation and version as the
 * provider of the operation it serves (`conditionalProviderAllows` in the Shell's gateway policy), and the installed
 * receiver publishes it (`registeredWorkloadCallReceiverIssue`).
 *
 * The route's own calls are its executor operations, the reads the adapters make for them and the recoveries Symmy's
 * code declares of them, each found in Symmy's installed manifest in the route's admission mode: a route whose deployed
 * Symmy declares no caller for one of them is refused. The nested calls start from the requirements: every requirement
 * the owner of a reached operation declares for exactly that operation needs one call the owner registers under the
 * workload the operation is served with, to the required provider, so a requirement without its call is refused by
 * name and a route needs only what its own operations can call, at any depth. A call the owner names as an intrinsic
 * requirement, which the gateway admits from any of its operations, is followed when it is registered.
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

import { admitSymmyJobAction } from '../actions/admit-symmy-job.action.ts';
import { admitSymmySyncAction } from '../actions/admit-symmy-sync.action.ts';
import { symmyJobStatusRead } from '../api/symmy-job-status.read.ts';
import { symmyRouteContextRead } from '../api/symmy-route-context.read.ts';
import { symmySyncAdmissionRead } from '../api/symmy-sync-admission.read.ts';
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
/** A provider operation as a requirement names it: its owning module, entrypoint and version. */
interface Provider extends RequiredOperation {
  readonly moduleId: string;
}
interface OperationRequirement {
  readonly entrypointKey: string;
  readonly key: string;
  readonly provider: Provider;
}
/** The published parts of an installed module contract the derivation reads. */
export interface SymmyRouteContract extends RegisteredWorkloadCallReceiver {
  readonly manifest: RegisteredWorkloadCallReceiver['manifest'] & {
    readonly module: { readonly id: string };
    readonly registeredWorkloadCalls?: readonly Call[] | undefined;
    readonly requirements?:
      | {
          readonly intrinsic: readonly {
            readonly moduleId: string;
            readonly requiredOperations: readonly RequiredOperation[];
          }[];
          readonly operations: readonly OperationRequirement[];
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

const sameVersion = (left: RequiredOperation, right: RequiredOperation) =>
  left.entrypointKey === right.entrypointKey && left.schemaVersion === right.schemaVersion;
const providerName = ({ moduleId, ...operation }: Provider) => `${moduleId} ${symmyOperationName(operation)}`;

/**
 * The requirements the caller declares for exactly the operation it serves, except those on a Core provider, which Core
 * runs in-process with no registered call (`isCoreOperationProvider`: a `core.` module).
 */
const operationRequirements = (caller: Contract, served: string) =>
  (caller.manifest.requirements?.operations ?? []).filter(
    ({ entrypointKey, provider }) => entrypointKey === served && !provider.moduleId.startsWith('core.'),
  );

/** The installed module of the app a call is addressed to. */
const receivingModule = (contracts: readonly Contract[], call: Call) =>
  contracts.find((contract) => contract.deployment.appId === call.audience)?.manifest.module.id;

const publishedAs =
  (operation: SymmyRouteCallRef) =>
  (candidate: { readonly entrypoint: { readonly entrypointKey: string }; readonly schemaVersion: string }) =>
    candidate.entrypoint.entrypointKey === operation.entrypointKey &&
    candidate.schemaVersion === operation.schemaVersion;

/** The workloads a published operation admits: an Action's own carrier or a read's published carrier. */
const publishedWorkloads = (contract: Contract | undefined, operation: SymmyRouteCallRef): readonly string[] => {
  if (contract === undefined) {
    return [];
  }
  const { actions, operationContracts } = contract.manifest.publicSurface;
  const matches = publishedAs(operation);
  return [
    ...actions.flatMap((action) => (matches(action) ? (action.accessWorkload?.workloads ?? []) : [])),
    ...(operationContracts ?? []).flatMap((contractRead) =>
      matches(contractRead) ? (contractRead.workloadCarrier?.workloads ?? []) : [],
    ),
  ];
};

/**
 * Symmy's own operations the integration principal uses on a route of this admission kind. Symmy publishes no
 * workload carrier for its reads, so the workloads each admits come from its own descriptor, which Symmy enforces when
 * it serves the operation; the installed Symmy must still publish the operation at the descriptor's version.
 */
const symmyCarriers = (admission: SymmyRouteInventory['admission']) => [
  { descriptor: symmyRouteContextRead.descriptor, purpose: 'route context' },
  ...(admission === 'job'
    ? [
        { descriptor: admitSymmyJobAction.descriptor, purpose: 'job admission' },
        { descriptor: symmyJobStatusRead.descriptor, purpose: 'job read' },
      ]
    : []),
  ...(admission === 'sync'
    ? [
        { descriptor: admitSymmySyncAction.descriptor, purpose: 'synchronous admission' },
        { descriptor: symmySyncAdmissionRead.descriptor, purpose: 'synchronous receipt' },
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
 * makes while it serves the call's operation: one registered call for each requirement it declares for that operation,
 * refused by name when it registers none or several, and each call it names as an intrinsic requirement. A company
 * reaches a call unless a call before it runs without one.
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
  const moduleId = receiver.manifest.module.id;
  state.moduleKeys.add(moduleId);
  state.calls.push({ call, live });
  const nested = { company: company && call.legalEntityScope !== 'forbidden', live };
  // The calls the gateway admits from this operation as served: the same job, workload and recovery mode.
  const served = (receiver.manifest.registeredWorkloadCalls ?? []).filter(
    (candidate) =>
      candidate.jobKey === SYMMY_JOB_KEY &&
      candidate.sourceWorkloadKey === call.workloadKey &&
      (candidate.allowRecoverySource === true) === !live &&
      candidate.workerKey === undefined &&
      candidate.sourceActionKey === undefined &&
      candidate.recoveryOf === undefined,
  );
  for (const requirement of operationRequirements(receiver, call.entrypointKey)) {
    const required = `requirement ${requirement.key} of ${symmyOperationName(call)} (${providerName(requirement.provider)})`;
    const [declared, ...others] = served.filter((candidate) => sameVersion(candidate, requirement.provider));
    const reaches = declared === undefined ? undefined : receivingModule(contracts, declared);
    if (declared === undefined || others.length > 0) {
      state.refusals.push(
        notDeclared(
          `The installed ${moduleId} declares no single ${live ? '' : 'recovery '}call under ${call.workloadKey} for ${required}`,
        ),
      );
    } else if (reaches !== undefined && reaches !== requirement.provider.moduleId) {
      state.refusals.push(notDeclared(`The installed ${moduleId} calls ${reaches}, not the provider of ${required}`));
    } else {
      followCall(contracts, state, { ...nested, call: declared });
    }
  }
  for (const intrinsic of served.filter((candidate) =>
    (receiver.manifest.requirements?.intrinsic ?? []).some(
      (requirement) =>
        requirement.moduleId === receivingModule(contracts, candidate) &&
        requirement.requiredOperations.some((operation) => sameVersion(operation, candidate)),
    ),
  )) {
    followCall(contracts, state, { ...nested, call: intrinsic });
  }
};

/**
 * The route's own calls in Symmy's installed manifest, each named by a requirement of the job worker or synchronous
 * admission it is made from on its receiving module, operation and version, followed to every nested call.
 */
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
        sameVersion(candidate, reference) &&
        candidate.recoveryOf?.actionKey === recoveryOf &&
        (recoveryOf !== undefined || candidate.allowRecoverySource !== true),
    );
    if (call === undefined || others.length > 0) {
      state.refusals.push(
        notDeclared(`The installed ${SYMMY_MODULE} declares no single ${admission} call of ${label}`),
      );
      return;
    }
    // An uninstalled receiver is refused when the call is followed.
    const moduleId = receivingModule(input.contracts, call);
    if (
      moduleId !== undefined &&
      !operationRequirements(symmy, served).some(
        ({ provider }) => provider.moduleId === moduleId && sameVersion(provider, call),
      )
    ) {
      state.refusals.push(
        notDeclared(`The installed ${SYMMY_MODULE} names ${label} on ${moduleId} as no requirement of ${served}`),
      );
      return;
    }
    followCall(input.contracts, state, { call, company: input.companyScoped, live: recoveryOf === undefined });
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
  const symmy = byModule(SYMMY_MODULE);
  for (const { descriptor, purpose } of symmyCarriers(inventory.admission)) {
    const operation = { entrypointKey: descriptor.entrypoint.entrypointKey, schemaVersion: descriptor.schemaVersion };
    const published = [
      ...(symmy?.manifest.publicSurface.actions ?? []),
      ...(symmy?.manifest.publicSurface.operationContracts ?? []),
    ].some(publishedAs(operation));
    const [first, ...rest] = descriptor.accessWorkload?.workloads ?? [];
    if (!published || first === undefined) {
      refusals.push(notPublished(`${symmyOperationName(operation)} is not published by ${SYMMY_MODULE}`));
    } else {
      bindings.push({ identity: 'integration', purpose, workloads: [first, ...rest] });
    }
  }
  const reads = [...enrolled.filter(({ caller }) => caller === 'integration'), ...(inventory.admissionReads ?? [])];
  for (const operation of reads) {
    const [first, ...rest] = publishedWorkloads(byModule(operation.moduleId), operation);
    if (first === undefined) {
      refusals.push(notPublished(`${symmyOperationName(operation)} is not published by ${operation.moduleId}`));
    } else {
      moduleKeys.add(operation.moduleId);
      bindings.push({ identity: 'integration', purpose: symmyOperationName(operation), workloads: [first, ...rest] });
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
