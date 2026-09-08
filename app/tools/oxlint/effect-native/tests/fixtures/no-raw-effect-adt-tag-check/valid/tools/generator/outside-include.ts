import { Exit } from 'effect';

/** `tools/**` is outside the default `include` scope. */
export const check = (exit: Exit.Exit<void>) => exit._tag === 'Failure';
