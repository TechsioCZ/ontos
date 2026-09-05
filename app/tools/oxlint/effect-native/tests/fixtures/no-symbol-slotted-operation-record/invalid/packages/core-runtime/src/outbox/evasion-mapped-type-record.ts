// expect-count: 2
// Evasion: the operation record is spelled as a mapped type / `Record<typeof slot, Handler>`
// instead of a computed property signature. Same symbol slot, same invisibility to Layer/Schema.
const outboxWorkerHandler: unique symbol = Symbol('@app/core-runtime/outbox/worker/handler');

export type OutboxWorkerRegistration<Payload> = {
  readonly [Slot in typeof outboxWorkerHandler]: (payload: Payload) => Promise<void>;
};

export type OutboxWorkerTable = Record<typeof outboxWorkerHandler, (payload: unknown) => Promise<void>>;
