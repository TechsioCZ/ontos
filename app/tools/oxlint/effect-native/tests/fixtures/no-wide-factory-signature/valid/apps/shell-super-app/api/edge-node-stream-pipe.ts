import { createReadStream } from 'node:fs';
import { createGzip } from 'node:zlib';

import { Effect } from 'effect';

/**
 * The file imports `effect`, but this factory is a plain value bag: the only `.pipe(` in its body is
 * a Node stream pipeline, not an Effect chain.
 */
export const createArchiveConfig = (options: ArchiveOptions) => ({
  destination: options.destination,
  stream: createReadStream(options.source).pipe(createGzip()),
});

export const ArchiveLive = Effect.succeed(createArchiveConfig);
