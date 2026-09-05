// The blessed seam, in a TSX file, with a cast around the argv argument.
import { Command } from "effect/unstable/cli";

declare const command: never;

const run = Command.run(command, { name: "scaffold", version: "1.0.0" });
export const main = run(process.argv as readonly string[]);

export const Badge = () => <b>{String(main)}</b>;
