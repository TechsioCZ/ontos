#!/usr/bin/env node
/** Shebang + top-level await + no Effect import: a local `Success`/`Failure` union, not an ADT. */
type Step = { readonly _tag: 'Success' } | { readonly _tag: 'Failure'; readonly error: string };

const steps: readonly Step[] = await Promise.resolve([{ _tag: 'Success' } as const]);

export const failures = steps.filter((step): step is Extract<Step, { _tag: 'Failure' }> => step._tag === 'Failure');
