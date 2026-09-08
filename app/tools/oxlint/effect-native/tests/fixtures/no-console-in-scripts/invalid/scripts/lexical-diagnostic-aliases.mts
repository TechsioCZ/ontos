// expect-count: 3
import * as sinks from "node:console";
const sink = sinks;
export function report(message: string) {
 sink[`error`](message);
 (globalThis.console as Console)["warn" as string](message);
 const { stderr: output } = process;
 output["write"](message);
}
