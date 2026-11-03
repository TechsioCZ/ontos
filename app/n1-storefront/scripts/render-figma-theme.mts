import { fileURLToPath } from "node:url";
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Console, Effect, FileSystem, Layer, Schema } from "effect";
import { Command, Flag } from "effect/cli";
import {
  CanonicalThemeJsonSchema,
  renderCanonicalTheme,
  ThemeContractInvalid,
} from "./figma-theme.ts";

const input = fileURLToPath(new URL("../src/tokens/figma/n1.json", import.meta.url));
const output = fileURLToPath(new URL("../src/tokens/figma/n1.css", import.meta.url));
const command = Command.make(
  "n1-theme",
  { check: Flag.Boolean("check").pipe(Flag.withDefault(false)) },
  ({ check }) =>
    Effect.gen(function* generateTheme() {
      const fs = yield* FileSystem.FileSystem;
      const source = yield* fs.readFileString(input);
      const snapshot = yield* Schema.decodeUnknownEffect(CanonicalThemeJsonSchema, {
        onExcessProperty: "error",
      })(source);
      const { count, css } = yield* renderCanonicalTheme(snapshot, source);
      if (check) {
        const current = yield* fs.readFileString(output);
        if (current !== css) {
          yield* new ThemeContractInvalid({ message: "Run theme:generate", reason: "stale" });
        }
      } else {
        yield* fs.writeFileString(output, css);
      }
      yield* Console.log(
        `N1 canonical theme ${check ? "matches" : "generated"} (${count} tokens).`,
      );
    }),
);
const mainLayer = Layer.effectDiscard(Command.run(command, { version: "0.1.0" })).pipe(
  Layer.provide(NodeServices.layer),
);
NodeRuntime.runMain(Effect.scoped(Layer.build(mainLayer)).pipe(Effect.asVoid));
