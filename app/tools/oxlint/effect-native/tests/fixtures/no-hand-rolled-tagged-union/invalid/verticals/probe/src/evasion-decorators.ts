// expect-count: 1
function inject(): ClassDecorator {
  return () => undefined;
}

export interface InjectedProblem {
  readonly _tag: 'InjectedProblem';
}

@inject()
export class Holder {
  handle(problem: InjectedProblem): string {
    return problem._tag;
  }
}
