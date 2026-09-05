import * as Types from '@demo/local-types';

/**
 * `Simplify` is only a transparent wrapper when its qualifier is a tracked `effect` binding.
 * A same-named first-party helper stays opaque, so nothing is reported here.
 */
export type LocalWrapped = Types.Simplify<{ readonly _tag: 'local' }>;
