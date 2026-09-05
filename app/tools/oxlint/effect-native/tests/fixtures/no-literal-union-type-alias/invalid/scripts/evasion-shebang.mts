#!/usr/bin/env node
// A shebang plus top-level await must not stop the visitor. (No `expect-count`: the shebang has to
// stay on line 1.)
export type ScaffoldPhase = 'apply' | 'plan';

await Promise.resolve();
