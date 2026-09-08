import { Context, Effect, Layer } from "effect";

class CoreDatabase extends Context.Tag("CoreDatabase")<CoreDatabase, { readonly query: () => Effect.Effect<string> }>() {}
class ActionRuntime extends Context.Tag("ActionRuntime")<ActionRuntime, { readonly run: () => Effect.Effect<string> }>() {}

// The target pattern: dependencies resolved inside the Layer, graph composed at the root.
export const ActionRuntimeLive = Layer.effect(
  ActionRuntime,
  Effect.gen(function* () {
    const database = yield* CoreDatabase;
    return { run: () => database.query() };
  }),
);

// Return types are untouched: a factory that *produces* a Layer or a service is the healthy shape.
export const makeLayer = (name: string): Layer.Layer<ActionRuntime> => ActionRuntimeLive;
export declare const buildService: (label: string) => (typeof CoreDatabase)["Service"];

// Domain data parameters, including a plain classifier.
class ActionPolicyDenied {
  readonly _tag = "ActionPolicyDenied";
}
export const classify = (error: ActionPolicyDenied) => "denied";
export const format = (rows: readonly string[], limit = 10) => rows.slice(0, limit);
