// @effect-diagnostics asyncFunction:off
import { db } from '@mvp2/core-runtime/db/client';
import type { OutboxWorkerRegistration } from '@mvp2/core-runtime';
import type { ClaimedDelivery } from './claim.ts';
import type { OutboxWorkerRuntimeConfig } from './config.ts';
import { reconstructWorkerExecutionEnvelope } from './context.ts';
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

export const executeClaimedDelivery = async ({
  claimedDelivery,
  registrations,
  runtimeConfig,
}: ExecuteClaimedDeliveryOptions): Promise<void> => {
  const registration = registrationForClaimedDelivery(registrations, claimedDelivery);

  try {
    if (registration === undefined) {
      throw new Error(`Outbox worker ${claimedDelivery.workerKey} is not installed.`);
    }

    await db.transaction(async (tx) => {
      const envelope = await reconstructWorkerExecutionEnvelope(
        tx,
        claimedDelivery.outboxDeliveryId,
        registration,
      );

      await registration.handler(
        {
          context: envelope.context,
          payload: envelope.payload,
        },
        { tx },
      );

      await persistDeliverySuccess(tx, claimedDelivery);
    });
  } catch (error) {
    await persistDeliveryFailure({
      claimedDelivery,
      error,
      registration,
      runtimeConfig,
    });
  }
};
