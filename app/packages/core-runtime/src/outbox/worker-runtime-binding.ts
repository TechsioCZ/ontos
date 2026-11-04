import { readNativeOutboxClaim } from './native-claim.ts';
import type { OutboxClaim } from './repository.ts';
import { Context, Effect, Option, Schema } from 'effect';

import type { ActiveApplicationCompositionServiceContract } from '../modules/active-application-composition.ts';
import type { OntosDeploymentIdentitySchema } from '../modules/manifest.ts';
import {
  operationCatalogLoader,
  operationIntrinsicDependencies,
  validateBoundOperationOwner,
  withModuleOperationExecution,
  withoutModuleOperationExecution,
} from '../modules/module-operation-execution.ts';
import { ModuleOperationRequirementError } from '../modules/module-operation-requirement-error.ts';
import type { VerticalRuntimeRegistration } from '../modules/runtime-registration.ts';
import type { AnyOutboxWorkerRegistration } from './definition.ts';

interface WorkerBindingInput {
  readonly authority: ActiveApplicationCompositionServiceContract;
  readonly expectedDeployment: typeof OntosDeploymentIdentitySchema.Type;
  readonly ownerRegistration?: VerticalRuntimeRegistration | undefined;
  readonly registrations: readonly AnyOutboxWorkerRegistration[];
}
interface WorkerBindingMint {
  readonly purpose: 'worker-runtime-binding';
}
const mint: WorkerBindingMint = Object.freeze({ purpose: 'worker-runtime-binding' });
class WorkerBinding {
  #active: boolean;
  readonly input: WorkerBindingInput;
  constructor(input: WorkerBindingInput, token: WorkerBindingMint) {
    this.#active = token === mint;
    this.input = Object.freeze({
      ...input,
      expectedDeployment: Object.freeze({ ...input.expectedDeployment }),
      registrations: Object.freeze([...input.registrations]),
    });
    Object.freeze(this);
  }
  static owns(value: WorkerBinding): boolean {
    return #active in value;
  }
  get active(): boolean {
    return this.#active;
  }
  close(): void {
    this.#active = false;
  }
}
Object.freeze(WorkerBinding.prototype);
Object.freeze(WorkerBinding);
const BindingSchema = Schema.instanceOf(WorkerBinding).check(
  Schema.makeFilter((value) => (WorkerBinding.owns(value) ? undefined : 'Expected a genuine worker binding')),
);
const CurrentWorkerBinding = Context.Reference<Option.Option<WorkerBinding>>(
  '@app/core-runtime/outbox/WorkerRuntimeBinding',
  { defaultValue: () => Option.none() },
);
const unavailable = (cause?: unknown) => {
  const error = new ModuleOperationRequirementError({
    code: 'module_operation_requirement_unavailable',
    reason: 'The native worker claim has no current verified receiving authority',
  });
  if (cause !== undefined) {
    Object.defineProperty(error, 'cause', { configurable: true, value: cause });
  }
  return error;
};

/** Bound only by the existing genuine process constructor, never RunCycle caller fields. */
export const withWorkerRuntimeBinding = <Value, Failure, Requirements>(
  input: WorkerBindingInput,
  effect: Effect.Effect<Value, Failure, Requirements>,
) =>
  Effect.suspend(() => {
    const binding = new WorkerBinding(input, mint);
    return effect.pipe(
      Effect.updateService(CurrentWorkerBinding, () => Option.some(binding)),
      Effect.ensuring(Effect.sync(() => binding.close())),
    );
  });

export const prepareNativeOutboxClaimAdmission = Effect.fn('Outbox.prepareNativeClaimAdmission')(
  function* prepareNativeClaimAdmission(registrations: readonly AnyOutboxWorkerRegistration[], revision: string) {
    const selected = yield* Schema.decodeUnknownEffect(Schema.Option(BindingSchema))(yield* CurrentWorkerBinding).pipe(
      Effect.mapError(unavailable),
    );
    const registered = Option.isSome(selected)
      ? new Set(selected.value.input.registrations)
      : new Set<AnyOutboxWorkerRegistration>();
    if (
      Option.isNone(selected) ||
      !selected.value.active ||
      registrations.some((registration) => !registered.has(registration))
    ) {
      return yield* unavailable();
    }
    const binding = selected.value;
    const loadCatalog = operationCatalogLoader(binding.input.authority, revision);
    const catalog = yield* loadCatalog;
    if (!binding.active) {
      return yield* unavailable();
    }
    const intrinsic = new Map<string, readonly string[]>();
    yield* Effect.forEach(
      registrations,
      Effect.fn('Outbox.validateNativeRegistration')(function* validateNativeRegistration(registration) {
        const { consumerModuleKey } = registration.descriptor;
        const owner = catalog.getByModuleId(consumerModuleKey);
        if (
          owner === undefined ||
          owner.deployment.appId !== binding.input.expectedDeployment.appId ||
          owner.deployment.buildMarker !== binding.input.expectedDeployment.buildMarker
        ) {
          return yield* unavailable();
        }
        yield* validateBoundOperationOwner(registration, catalog, binding.input.ownerRegistration);
        const dependencies = yield* operationIntrinsicDependencies(registration, catalog);
        intrinsic.set(consumerModuleKey, dependencies.get(consumerModuleKey) ?? []);
        return yield* Effect.void;
      }),
      { concurrency: 1, discard: true },
    );
    return Object.freeze({ binding, intrinsic, loadCatalog, revision });
  },
);
export type NativeAdmission = Effect.Success<ReturnType<typeof prepareNativeOutboxClaimAdmission>>;
export const nativeOutboxClaimRevision = (
  claim: OutboxClaim,
  registration: AnyOutboxWorkerRegistration,
): string | undefined => {
  const trusted = readNativeOutboxClaim(claim);
  return trusted?.registration === registration && trusted.admission.binding.active
    ? trusted.admission.revision
    : undefined;
};
export const withNativeOutboxClaimExecution = <Value, Failure, Requirements>(
  claim: OutboxClaim,
  registration: AnyOutboxWorkerRegistration,
  effect: Effect.Effect<Value, Failure, Requirements>,
) =>
  Effect.suspend(() => {
    const trusted = readNativeOutboxClaim(claim);
    if (trusted === undefined || trusted.registration !== registration || !trusted.admission.binding.active) {
      return withoutModuleOperationExecution(effect);
    }
    return withModuleOperationExecution(
      {
        loadCatalog: trusted.admission.loadCatalog,
        ownerRegistration: trusted.admission.binding.input.ownerRegistration,
        phase: 'execution',
        registration,
        revision: trusted.admission.revision,
        scope: { tenantId: claim.tenantId },
      },
      effect,
    );
  });

export { attestNativeOutboxClaim } from './native-claim.ts';
