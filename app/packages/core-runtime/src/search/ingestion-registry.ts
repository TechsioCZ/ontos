import { Context, Layer } from 'effect';

/** One post-commit topic a producing module projects into Core Search through its own worker. */
export interface CoreSearchIngestionRegistration {
  readonly consumerModuleKey: string;
  readonly producerModuleKey: string;
  readonly topic: string;
  readonly workerKey: string;
}

/** The ingestion registrations of the module whose worker host runs; the producing module declares them. */
export class CoreSearchIngestionRegistry extends Context.Service<
  CoreSearchIngestionRegistry,
  readonly CoreSearchIngestionRegistration[]
>()('@app/core-runtime/search/ingestion/CoreSearchIngestionRegistry') {}

export const defineCoreSearchIngestionRegistrations = (
  registrations: readonly CoreSearchIngestionRegistration[],
): readonly CoreSearchIngestionRegistration[] =>
  Object.freeze(registrations.map((registration) => Object.freeze({ ...registration })));

export const coreSearchIngestionRegistryLayer = (
  registrations: readonly CoreSearchIngestionRegistration[],
): Layer.Layer<CoreSearchIngestionRegistry> =>
  Layer.succeed(CoreSearchIngestionRegistry, defineCoreSearchIngestionRegistrations(registrations));

export const isCoreSearchIngestionRegistered = (
  registrations: readonly CoreSearchIngestionRegistration[],
  claim: Readonly<{ consumerModuleKey?: string; producerModuleKey: string; topic: string; workerKey: string }>,
): boolean =>
  registrations.some(
    (registration) =>
      registration.producerModuleKey === claim.producerModuleKey &&
      registration.topic === claim.topic &&
      registration.workerKey === claim.workerKey &&
      (claim.consumerModuleKey === undefined || registration.consumerModuleKey === claim.consumerModuleKey),
  );
