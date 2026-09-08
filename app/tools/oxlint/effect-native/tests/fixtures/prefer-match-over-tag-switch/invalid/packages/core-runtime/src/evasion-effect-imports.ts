// expect-count: 3
import { Effect as E, Match as M } from 'effect';
import * as ExitNs from 'effect/Exit';
import * as OptionNs from 'effect/Option';

declare const option: OptionNs.Option<number>;
declare const exit: ExitNs.Exit<number, string>;
declare const program: E.Effect<number, { readonly _tag: 'Denied' }>;

void M.value;
void program;

/** Aliased root imports and `effect/*` namespace imports do not excuse raw ADT inspection. */
export const describeOption = (): string => {
  switch (option._tag) {
    case 'Some': {
      return 'present';
    }
    case 'None': {
      return 'absent';
    }
  }
};

export const describeExit = (): string => {
  switch (exit._tag) {
    case 'Success': {
      return 'ok';
    }
    case 'Failure': {
      return 'bad';
    }
  }
};

/** A cast to a structural shape is still the ADT tag. */
export const describeCast = (): string => {
  switch ((option as { readonly _tag: 'Some' | 'None' })._tag) {
    case 'Some': {
      return 'present';
    }
    default: {
      return 'absent';
    }
  }
};
