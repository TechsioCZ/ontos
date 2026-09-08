// Type-only imports are erased, and handing the raw array to a CLI runner is the intended seam.
import type { ParseArgsConfig } from "node:util";
import type { Options as YargsOptions } from "yargs";

declare const runCli: (argumentVector: readonly string[]) => string;

const rendered = runCli(process.argv);

export const Panel = () => <div data-rendered={rendered}>{rendered}</div>;
export type { ParseArgsConfig, YargsOptions };
