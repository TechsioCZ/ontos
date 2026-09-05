// Every reference to node:fs here is erased before runtime.
import type fsDefault from "node:fs";
import type * as fsNamespace from "node:fs";
import { type BigIntOptions, type Stats } from "node:fs";

export type { Dirent } from "node:fs";
export type * from "node:fs/promises";

export type Namespace = typeof fsNamespace;
export type Default = typeof fsDefault;
export type Options = BigIntOptions;
export type Info = Stats;
