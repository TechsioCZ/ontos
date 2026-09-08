/**
 * No `effect` import in this module, so `Effect` below is an ordinary local helper and `.pipe(`
 * is a Node stream. Neither may be mistaken for an Effect program.
 */
const Effect = { gen: (body: () => unknown) => body() };

export const makeAuditEntry = (options: AuditEntryOptions) => Effect.gen(() => ({ options }));

export const createStreamSink = (options: SinkOptions) => sourceStream.pipe(options.target);

export const buildDigest = (entry: AuditEntry) => `${entry.id}`;
