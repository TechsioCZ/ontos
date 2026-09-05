#!/usr/bin/env -S node --experimental-strip-types
// A real operational script edge: the shebang shifts every span in the file.
import { execFileSync } from "node:child_process";

export const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf-8" }).trim();
