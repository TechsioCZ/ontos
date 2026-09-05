// expect-count: 2
import { Layer } from "effect";

interface OutboxRepositoryService {
  readonly claim: () => void;
}

// 1-2: `.mts` entrypoints are ordinary application code, not scripts/**.
export const startWorker = (
  repository: OutboxRepositoryService,
  workerLayer: Layer.Layer<OutboxRepositoryService>,
) => [repository, workerLayer];
