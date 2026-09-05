/** Outside `include` (apps/verticals/packages/scripts): tooling owns its own dispatchers. */
type ToolEvent = { readonly _tag: 'start' } | { readonly _tag: 'stop' };

export const describe = (event: ToolEvent): string => {
  switch (event._tag) {
    case 'start': {
      return 'start';
    }
    case 'stop': {
      return 'stop';
    }
  }
};
