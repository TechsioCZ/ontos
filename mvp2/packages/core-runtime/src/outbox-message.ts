export type OutboxMessage<TTopic extends string, TPayload> = {
  readonly payload: TPayload;
  readonly topic: TTopic;
};

export const defineOutboxMessage =
  <const TTopic extends string>(topic: TTopic) =>
  <TPayload>(payload: TPayload): OutboxMessage<TTopic, TPayload> => ({
    payload,
    topic,
  });
