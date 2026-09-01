import { Predicate } from 'effect';
import type { AnyOutboxWorkerRegistration } from '../outbox/definition.ts';
import { validateOutboxWorkerRegistrations } from '../outbox/definition.ts';
import type {
  OntosActionContract,
  OntosManifestActionValue,
  OntosModuleId,
  OntosModuleManifest,
  OntosOutboxSubscriptionContract,
} from './manifest.ts';
import type { OntosShellContributions } from './shell-contribution.ts';

const runtimeRegistrationBrand: unique symbol = Symbol(
  '@app/core-runtime/modules/runtime-registration',
);

interface PrivateVerticalRuntime {
  readonly actions: readonly OntosManifestActionValue[];
  readonly entrypoints: VerticalRuntimeEntrypointBindings;
  readonly outboxWorkers: readonly AnyOutboxWorkerRegistration[];
  readonly shellContributions: OntosShellContributions;
}

const privateRuntime = new WeakMap<object, PrivateVerticalRuntime>();

export interface VerticalRuntimeRegistration<ModuleId extends string = string> {
  readonly [runtimeRegistrationBrand]: true;
  readonly moduleId: ModuleId;
}

export interface VerticalRuntimeRegistrationInput<
  Manifest extends OntosModuleManifest = OntosModuleManifest,
> {
  readonly actions: readonly OntosManifestActionValue[];
  readonly entrypoints?: VerticalRuntimeEntrypointBindings;
  readonly manifest: Manifest;
  readonly outboxWorkers: readonly AnyOutboxWorkerRegistration[];
}

export type VerticalRuntimeEntrypointThunk = () => PromiseLike<object>;

export interface VerticalRuntimeEntrypointBindings {
  readonly api: Readonly<Record<string, VerticalRuntimeEntrypointThunk>>;
  readonly components: Readonly<Record<string, VerticalRuntimeEntrypointThunk>>;
  readonly pages: Readonly<Record<string, VerticalRuntimeEntrypointThunk>>;
  readonly reports: Readonly<Record<string, VerticalRuntimeEntrypointThunk>>;
  readonly search: Readonly<Record<string, VerticalRuntimeEntrypointThunk>>;
}

const emptyEntrypoints = (): VerticalRuntimeEntrypointBindings => ({
  api: {},
  components: {},
  pages: {},
  reports: {},
  search: {},
});

const assertUnique = (values: readonly string[], label: string): void => {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      throw new TypeError(`duplicate ${label} ${value}`);
    }
    seen.add(value);
  }
};

export const defineVerticalRuntimeRegistration = <const Manifest extends OntosModuleManifest>(
  input: VerticalRuntimeRegistrationInput<Manifest>,
): VerticalRuntimeRegistration<Manifest['module']['id']> => {
  const allowed = new Set(['actions', 'entrypoints', 'manifest', 'outboxWorkers']);
  for (const key of Reflect.ownKeys(input)) {
    if (!Predicate.isString(key) || !allowed.has(key)) {
      throw new TypeError(`runtime registration contains unsupported field ${String(key)}`);
    }
  }
  const manifestActions = new Set(input.manifest.publicSurface.actions);
  assertUnique(
    input.actions.map(({ descriptor }) => descriptor.actionKey),
    'runtime Action',
  );
  for (const action of input.actions) {
    if (action.descriptor.owningModuleKey !== input.manifest.module.id) {
      throw new TypeError('runtime Action owner must match the manifest module ID');
    }
    if (!manifestActions.has(action)) {
      throw new TypeError('runtime Action must be the same value published by the manifest');
    }
  }
  const workers = validateOutboxWorkerRegistrations(input.outboxWorkers);
  for (const worker of workers) {
    if (worker.descriptor.consumerModuleKey !== input.manifest.module.id) {
      throw new TypeError('runtime Outbox Worker owner must match the manifest module ID');
    }
  }
  const entrypoints = input.entrypoints ?? emptyEntrypoints();
  const entrypointCategories = new Set(['api', 'components', 'pages', 'reports', 'search']);
  for (const key of Reflect.ownKeys(entrypoints)) {
    if (!Predicate.isString(key) || !entrypointCategories.has(key)) {
      throw new TypeError(`runtime entrypoints contain unsupported field ${String(key)}`);
    }
  }
  for (const [category, bindings] of Object.entries(entrypoints)) {
    if (Object.values(bindings).some((value) => !Predicate.isFunction(value))) {
      throw new TypeError(`runtime ${category} entrypoints must be lazy thunks`);
    }
  }
  const registration = Object.freeze({
    [runtimeRegistrationBrand]: true as const,
    moduleId: input.manifest.module.id,
  });
  privateRuntime.set(registration, {
    actions: Object.freeze([...input.actions]),
    entrypoints: Object.freeze({
      api: Object.freeze({ ...entrypoints.api }),
      components: Object.freeze({ ...entrypoints.components }),
      pages: Object.freeze({ ...entrypoints.pages }),
      reports: Object.freeze({ ...entrypoints.reports }),
      search: Object.freeze({ ...entrypoints.search }),
    }),
    outboxWorkers: workers,
    shellContributions: input.manifest.publicSurface.shellContributions,
  });
  return registration;
};

const requirePrivateRuntime = (
  registration: VerticalRuntimeRegistration,
): PrivateVerticalRuntime => {
  const value = privateRuntime.get(registration);
  if (value === undefined || registration[runtimeRegistrationBrand] !== true) {
    throw new TypeError('invalid Vertical Runtime Registration');
  }
  return value;
};

/** Owner-local runtime seam; executable values never appear on the registration object. */
export const getVerticalRuntimeActions = (
  registration: VerticalRuntimeRegistration,
): readonly OntosManifestActionValue[] => requirePrivateRuntime(registration).actions;

/** Owner-local runtime seam; executable values never appear on the registration object. */
export const getVerticalRuntimeOutboxWorkers = (
  registration: VerticalRuntimeRegistration,
): readonly AnyOutboxWorkerRegistration[] => requirePrivateRuntime(registration).outboxWorkers;

/** Owner-local runtime seam; lazy executable values never appear on the registration object. */
export const getVerticalRuntimeEntrypoints = (
  registration: VerticalRuntimeRegistration,
): VerticalRuntimeEntrypointBindings => requirePrivateRuntime(registration).entrypoints;

export interface VerticalRuntimeSafeDescriptors {
  readonly actions: readonly OntosActionContract[];
  readonly moduleId: OntosModuleId;
  readonly outboxSubscriptions: readonly OntosOutboxSubscriptionContract[];
  readonly shellContributions: OntosShellContributions;
}

/** Build-tool seam. Returns copied, frozen data and never returns a handler or Schema value. */
export const extractVerticalRuntimeSafeDescriptors = (
  registration: VerticalRuntimeRegistration,
): VerticalRuntimeSafeDescriptors => {
  const runtime = requirePrivateRuntime(registration);
  return Object.freeze({
    actions: Object.freeze(
      runtime.actions
        .map(({ descriptor }) =>
          Object.freeze({
            actionKey: descriptor.actionKey,
            auditProfile: descriptor.auditProfile,
            idempotency: descriptor.idempotency,
            legalEntityScope: descriptor.legalEntityScope,
            owningModuleId: descriptor.owningModuleKey,
            schemaVersion: descriptor.schemaVersion,
          }),
        )
        .toSorted((left, right) => left.actionKey.localeCompare(right.actionKey)),
    ),
    moduleId: registration.moduleId,
    outboxSubscriptions: Object.freeze(
      runtime.outboxWorkers
        .map(({ descriptor }) =>
          Object.freeze({
            consumerModuleKey: descriptor.consumerModuleKey,
            entrypoint: descriptor.entrypoint,
            producerModuleKey: descriptor.producerModuleKey,
            topic: descriptor.topic,
            workerKey: descriptor.workerKey,
          }),
        )
        .toSorted((left, right) => left.workerKey.localeCompare(right.workerKey)),
    ),
    shellContributions: runtime.shellContributions,
  });
};
