// Lookalikes: package names that merely start with a configured module name, unconfigured spawn
// helpers, local modules, and `node:fs` appearing only as data.
import chokidar from "chokidar";
import fsevents from "fsevents";
import memfs from "memfs";
import { spawn } from "cross-spawn";
import helper from "./fs.ts";
import extras from "fs-extraordinary";
import runner from "execa-lite";

export const specifier = "node:fs";
export const emitted = `import fs from "node:fs";`;
export const registry = { "node:fs": true, execa: null, fs: memfs } as const;
export const everything = { chokidar, extras, fsevents, helper, runner, spawn, specifier, emitted, registry };
