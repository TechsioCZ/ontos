// expect-count: 3
import { Exit, Option } from 'effect';
import * as Result from 'effect/Result';

declare const someExit: Exit.Exit<number, string>;
declare const someOption: Option.Option<number>;
declare const someResult: Result.Result<number, string>;

/** C2: raw Exit `_tag` inspection instead of Exit.match / Exit.isFailure. */
export const describeExit = (): string => {
  switch (someExit._tag) {
    case 'Success': {
      return 'ok';
    }
    case 'Failure': {
      return 'bad';
    }
  }
};

/** C2: raw Option `_tag` inspection instead of Option.match / Option.isSome. */
export const describeOption = (): string => {
  switch (someOption._tag) {
    case 'Some': {
      return 'present';
    }
    case 'None': {
      return 'absent';
    }
  }
};

/** C2: Result is the same ADT shape under a namespace submodule import. */
export const describeResult = (): string => {
  switch (someResult._tag) {
    case 'Success': {
      return 'ok';
    }
    case 'Failure': {
      return 'bad';
    }
  }
};
