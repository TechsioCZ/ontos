import { Exit, Option } from 'effect';
import * as ExitNs from 'effect/Exit';

declare const someExit: Exit.Exit<number, string>;
declare const someOption: Option.Option<number>;

/** C2 target: Option.match / Exit.match rather than `_tag` inspection. */
export const describeOption = (): string =>
  Option.match(someOption, { onNone: () => 'absent', onSome: () => 'present' });

export const describeExit = (): string =>
  Exit.match(someExit, { onFailure: () => 'bad', onSuccess: () => 'ok' });

export const isBad = (): boolean => ExitNs.isFailure(someExit);
