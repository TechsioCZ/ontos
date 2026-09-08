// Inline `type` specifiers are erased: no runtime parser is introduced.
import { type ParseArgsConfig } from "node:util";
import type { argv } from "node:process";
import { type Options } from "yargs";

export type { Options, ParseArgsConfig, argv };
