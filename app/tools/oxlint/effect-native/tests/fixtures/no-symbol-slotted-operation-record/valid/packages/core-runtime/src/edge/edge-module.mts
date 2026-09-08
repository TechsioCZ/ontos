/** `.mts` parse probe: named fields only, nothing slotted behind a symbol. */
export interface OutboxWorkerRegistration<Payload> {
  readonly handler: (payload: Payload) => Promise<void>;
  readonly workerKey: string;
}

export function registerWorker<Payload>(
  workerKey: string,
  handler: (payload: Payload) => Promise<void>,
): OutboxWorkerRegistration<Payload> {
  return Object.freeze({ handler, workerKey });
}
