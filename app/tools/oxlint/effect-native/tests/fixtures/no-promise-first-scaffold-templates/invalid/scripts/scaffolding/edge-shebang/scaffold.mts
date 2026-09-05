#!/usr/bin/env node
// expect-count: 1
/** Offset probe: a shebang shifts every source index; the emitted `async` must still be located. */
export const renderLoader = (name: string): string => `export const load${name} = async () => undefined;
`;
