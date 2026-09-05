// expect-count: 3
declare const events: AsyncIterable<{ readonly _tag: 'push' | 'pop' }>;
declare const mode: string;

await Promise.resolve();

/** An async generator body still dispatches on `_tag`. */
export async function* run(): AsyncGenerator<string> {
  for await (const event of events) {
    switch (event._tag) {
      case 'push': {
        yield 'push';
        break;
      }
      case 'pop': {
        yield 'pop';
        break;
      }
    }
  }
}

/** Nested arrow bodies do not hide the classifier. */
export const nested = () => () => (): number => {
  switch (mode) {
    case 'x': {
      return 1;
    }
    case 'y': {
      return 2;
    }
    default: {
      return 0;
    }
  }
};

/** A labelled switch at module top level. */
outer: switch (mode) {
  case 'x': {
    break outer;
  }
  case 'y': {
    break outer;
  }
}
