import type { OutboxWorkerRegistration } from '@mvp2/core-runtime/outbox';
import { Effect } from 'effect';
import type { ClaimedDelivery } from './claim.ts';
import type { OutboxWorkerRuntimeConfig } from './config.ts';
import { reconstructWorkerExecutionEnvelope } from './context.ts';
import { runCoreTransaction } from './db-effect.ts';
import { type OutboxWorkerError, outboxWorkerError } from './errors.ts';
import { persistDeliveryFailure, persistDeliverySuccess } from './outcomes.ts';

export type ExecuteClaimedDeliveryOptions = {
  readonly claimedDelivery: ClaimedDelivery;
  readonly registrations: readonly OutboxWorkerRegistration<unknown>[];
  readonly runtimeConfig: OutboxWorkerRuntimeConfig;
};

const registrationForClaimedDelivery = (
  registrations: readonly OutboxWorkerRegistration<unknown>[],
  claimedDelivery: ClaimedDelivery,
): OutboxWorkerRegistration<unknown> | undefined =>
  registrations.find(
    (registration) => registration.descriptor.workerKey === claimedDelivery.workerKey,
  );

const parsePayload = (
  registration: OutboxWorkerRegistration<unknown>,
  payload: unknown,
): Effect.Effect<unknown, OutboxWorkerError> =>
  Effect.try({
    try: () => registration.descriptor.payloadSchema?.parse(payload) ?? payload,
    catch: (error) => outboxWorkerError('Outbox worker payload validation failed.', error),
  });

export const executeClaimedDelivery = ({
  claimedDelivery,
  registrations,
  runtimeConfig,
}: ExecuteClaimedDeliveryOptions): Effect.Effect<void, OutboxWorkerError> => {
  const registration = registrationForClaimedDelivery(registrations, claimedDelivery);

  const execute = Effect.gen(function* () {
    if (registration === undefined) {
      return yield* outboxWorkerError(
        `Outbox worker ${claimedDelivery.workerKey} is not installed.`,
      );
    }

    yield* runCoreTransaction((tx) =>
      Effect.gen(function* () {
        const envelope = yield* reconstructWorkerExecutionEnvelope(
          tx,
          claimedDelivery.outboxDeliveryId,
          registration,
        );
        const payload = yield* parsePayload(registration, envelope.payload);

        yield* Effect.tryPromise({
          try: () =>
            Promise.resolve(
              registration.handler(
                {
                  context: envelope.context,
                  payload,
                },
                { tx },
              ),
            ),
          catch: (error) => outboxWorkerError('Outbox worker handler failed.', error),
        });

        yield* persistDeliverySuccess(tx, claimedDelivery);
      }),
    );
  });

  return execute.pipe(
    Effect.catchAll((error) =>
      persistDeliveryFailure({
        claimedDelivery,
        error,
        registration,
        runtimeConfig,
      }),
    ),
  );
};
