// expect-count: 2
// Control probe: the plain slot shape in a `.mts` module.
const outboxWorkerHandler: unique symbol = Symbol('@app/core-runtime/outbox/mts/handler');
const outboxWorkerRegistration: unique symbol = Symbol('@app/core-runtime/outbox/mts/registration');

export interface OutboxWorkerRegistration<Payload> {
  readonly [outboxWorkerHandler]: (payload: Payload) => Promise<void>;
  readonly [outboxWorkerRegistration]: true;
}

export function registerWorker<Payload>(
  handler: (payload: Payload) => Promise<void>,
): OutboxWorkerRegistration<Payload> {
  return Object.freeze({
    [outboxWorkerHandler]: handler,
    [outboxWorkerRegistration]: true as const,
  });
}
