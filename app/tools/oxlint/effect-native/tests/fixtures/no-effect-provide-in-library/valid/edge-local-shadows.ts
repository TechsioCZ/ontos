// Scope analysis: a local shadow of an imported name is not the Effect combinator.
import { Effect } from "effect";
import { provide } from "effect/Effect";

declare const RequirementsLayer: never;
declare const program: Effect.Effect<string, never, never>;

// A parameter named `Effect` shadows the import inside this function body.
export function withContainer(Effect: { readonly provide: (token: string) => void }): void {
  Effect.provide("token");
}

// A block-scoped `provide` shadows the direct member import.
export function useContainer(container: { readonly provide: (token: string) => void }): void {
  const provide = container.provide;
  provide("token");
}

// Referenced so the imports are not unused; both live at the blessed outer run seam.
export const seam = Effect.runFork(program.pipe(provide(RequirementsLayer)));
