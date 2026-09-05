// expect-count: 2
import { createRequire as loader } from "node:module";
const factory = loader;
const load = factory(import.meta.url);
load("node:fs" as const);
await import("node:child_process"!);
