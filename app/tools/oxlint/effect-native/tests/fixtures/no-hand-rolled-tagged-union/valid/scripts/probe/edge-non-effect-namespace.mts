/** `Simplify` is only transparent when its qualifier is a real effect binding. */
import * as Types from 'ts-essentials';

export type NotTransparent = Types.Simplify<{ readonly _tag: 'nope' }>;
