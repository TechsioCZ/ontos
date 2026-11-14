// The Effect-native shape: the command line is declared once and argv crosses exactly one seam.
import { Effect } from "effect";
import { Args, Command, Options } from "effect/unstable/cli";

const mode = Args.choice("mode", ["prepare", "verify", "finalize"]);
const verbose = Options.boolean("verbose");
const command = Command.make("migrate", { mode, verbose }, ({ mode: selected }) => Effect.log(selected));
const run = Command.run(command, { name: "migrate", version: "1.0.0" });

export const main = run(process.argv);
