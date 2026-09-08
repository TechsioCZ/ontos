// Nothing here is a parameter, so nothing reports: only the parameter list is the finding.
import { Effect, Layer } from "effect";

interface ActionRepositoryService {
  readonly load: (id: string) => Effect.Effect<string>;
}
declare const CoreDatabase: { readonly Service: { readonly query: () => Effect.Effect<string> } };

// Declarations, aliases and variable annotations.
export type Database = (typeof CoreDatabase)["Service"];
export type AppLayer = Layer.Layer<ActionRepositoryService>;
declare const ambientRepository: ActionRepositoryService;
const local: ActionRepositoryService = ambientRepository;

// Return types are how a Live layer or a service value is built.
export const buildRepository = (): ActionRepositoryService => local;
export const buildLayer = (name: string): Layer.Layer<ActionRepositoryService> => {
  throw new Error(name);
};

// Class fields and getters hold, but do not inject, a service.
export class Holder {
  private repository: ActionRepositoryService = local;
  get current(): ActionRepositoryService {
    return this.repository;
  }
}

// Unannotated and primitive parameters.
export const format = (rows, limit: number, label: string, payload: unknown) => [rows, limit, label, payload];
export const guard = () => {
  try {
    return local;
  } catch (error) {
    return error;
  }
};
