import { Effect, Layer } from "effect";

interface ActionRepositoryService {
  readonly load: (id: string) => Effect.Effect<string>;
}

// Tests are excluded by default: the audit's D tier blesses fixture plumbing.
export const withStub = (
  repository: ActionRepositoryService,
  layer: Layer.Layer<never>,
) => [repository, layer];
