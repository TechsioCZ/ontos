// expect-count: 3
const outboxWorkerRegistration: unique symbol = Symbol('@app/core-runtime/outbox/worker-registration');
const outboxWorkerHandler: unique symbol = Symbol(
  '@app/core-runtime/outbox/worker-registration/handler',
);

export interface OutboxWorkerRegistration<Payload> {
  // reported: method-shaped slot is never a brand marker
  [outboxWorkerHandler](payload: Payload): Promise<void>;
  readonly [outboxWorkerRegistration]: true;
}

// reported: symbol-keyed operation record
export interface OutboxWorkerTable {
  readonly [key: symbol]: (payload: unknown) => Promise<void>;
}

export const registerWorker = <Payload>(
  handler: (payload: Payload) => Promise<void>,
): OutboxWorkerRegistration<Payload> =>
  ({
    // reported
    [outboxWorkerHandler]: handler,
    [outboxWorkerRegistration]: true as const,
  }) as unknown as OutboxWorkerRegistration<Payload>;
