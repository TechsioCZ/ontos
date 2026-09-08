// A harness directory is ordinary test code, not a runtime exemption.
import { it } from "effect-rstest";
import { Effect, Layer } from "effect";

it.layer(Layer.empty)("shared layer", (it) => {
  it.effect("uses the shared layer runner", () => Effect.void);
});
