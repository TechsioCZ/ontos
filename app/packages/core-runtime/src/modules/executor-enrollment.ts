import { Option, Schema } from 'effect';

import { WorkloadKeySchema, workloadKeyBelongsToModule } from '../authorization/access-declaration.ts';
import { registeredWorkloadCallReceiverIssue } from './registered-workload-calls.ts';
import type { OntosRegisteredWorkloadCall, RegisteredWorkloadCallReceiver } from './registered-workload-calls.ts';

/** Receiver-owned permission to select a canonical company executor, not permission to call an operation. */
export const OntosExecutorEnrollmentSchema = Schema.Struct({
  uses: Schema.NonEmptyArray(Schema.Literals(['admission', 'assertion', 'recovery'])).check(Schema.isUnique()),
  workloadKey: WorkloadKeySchema,
});
export const OntosExecutorEnrollmentsSchema = Schema.Array(OntosExecutorEnrollmentSchema).check(
  Schema.isMaxLength(256),
  Schema.makeFilter((declarations) =>
    new Set(declarations.map(({ workloadKey }) => workloadKey)).size === declarations.length
      ? undefined
      : 'executor enrollment must declare each workload once',
  ),
);
export type OntosExecutorEnrollment = typeof OntosExecutorEnrollmentSchema.Type;
export type OntosExecutorEnrollmentInput = typeof OntosExecutorEnrollmentSchema.Encoded;
export type ExecutorEnrollmentUse = OntosExecutorEnrollment['uses'][number];
export type ExecutorEnrollmentReceiver = RegisteredWorkloadCallReceiver & {
  readonly deployment: { readonly buildMarker: string };
  readonly manifest: {
    readonly executorEnrollments?: readonly OntosExecutorEnrollment[] | undefined;
    readonly module: { readonly id: string };
  };
};
type ReceiverOperation = Pick<
  OntosRegisteredWorkloadCall,
  'audience' | 'declarationKey' | 'entrypointKey' | 'legalEntityScope' | 'schemaVersion' | 'workloadKey'
>;

/** Checked on both authored projection and downloaded deployment contracts. */
export const executorEnrollmentsIssue = (manifest: ExecutorEnrollmentReceiver['manifest']): string | undefined => {
  for (const declaration of manifest.executorEnrollments ?? []) {
    if (!workloadKeyBelongsToModule(declaration.workloadKey, manifest.module.id)) {
      return 'executor enrollment must belong to the receiving module';
    }
    const published = [
      ...manifest.publicSurface.actions.flatMap((action) => action.accessWorkload?.workloads ?? []),
      ...(manifest.publicSurface.operationContracts ?? []).flatMap(
        (operation) => operation.workloadCarrier?.workloads ?? [],
      ),
    ];
    if (!published.includes(declaration.workloadKey)) {
      return 'executor enrollment must name a published receiver workload';
    }
  }
  return undefined;
};

class ReceiverExecutorEnrollmentValue {
  readonly #receiver;
  readonly enrollmentMode: 'system' | 'system-or-canonical-company-service';
  readonly workloadKey: ReceiverOperation['workloadKey'];
  constructor(receiver: ExecutorEnrollmentReceiver, operation: ReceiverOperation, use: ExecutorEnrollmentUse) {
    this.#receiver = Object.freeze({
      appId: receiver.deployment.appId,
      buildMarker: receiver.deployment.buildMarker,
      declarationKey: operation.declarationKey,
      entrypointKey: operation.entrypointKey,
      schemaVersion: operation.schemaVersion,
      use,
    });
    this.workloadKey = operation.workloadKey;
    this.enrollmentMode =
      receiver.manifest.executorEnrollments?.some(
        (declaration) => declaration.workloadKey === operation.workloadKey && declaration.uses.includes(use),
      ) === true
        ? 'system-or-canonical-company-service'
        : 'system';
    Object.freeze(this);
  }
  /** Keeps the checked receiving release attached to the enrollment capability. */
  get receiver() {
    return this.#receiver;
  }
}
export type ReceiverExecutorEnrollment = ReceiverExecutorEnrollmentValue;

/** Missing exact operations refuse; a published operation without enrollment metadata stays SYSTEM-only. */
export const resolveReceiverExecutorEnrollment = (
  receiver: ExecutorEnrollmentReceiver,
  operation: ReceiverOperation,
  use: ExecutorEnrollmentUse,
): Option.Option<ReceiverExecutorEnrollment> => {
  if (
    executorEnrollmentsIssue(receiver.manifest) !== undefined ||
    registeredWorkloadCallReceiverIssue(operation, receiver) !== undefined
  ) {
    return Option.none();
  }
  // An Action may also publish its API contract. Each projection must agree; duplicates within either surface refuse.
  const actions = receiver.manifest.publicSurface.actions.filter(
    (candidate) =>
      candidate.entrypoint.entrypointKey === operation.entrypointKey &&
      candidate.schemaVersion === operation.schemaVersion,
  );
  const contracts = (receiver.manifest.publicSurface.operationContracts ?? []).filter(
    (candidate) =>
      candidate.entrypoint.entrypointKey === operation.entrypointKey &&
      candidate.schemaVersion === operation.schemaVersion,
  );
  if (actions.length > 1 || contracts.length > 1) {
    return Option.none();
  }
  return Option.some(new ReceiverExecutorEnrollmentValue(receiver, operation, use));
};
