#!/usr/bin/env node
/* eslint-disable */
interface Failure {
  readonly _tag: string;
}

function decorate(_target: unknown, _context: unknown): void {}

/** Decorators, accessors, static blocks and `using` declarations must not crash the rule. */
@decorate
export class Scaffold {
  @decorate accessor latest: Failure = { _tag: "none" };
  static ready = false;
  static {
    Scaffold.ready = true;
  }
  label(): string {
    return this.latest._tag;
  }
}

export const dispose = (): void => {
  using handle = {
    [Symbol.dispose]() {},
  };
  void handle;
};

export const generatorTag = function* (errors: readonly Failure[]): Generator<string> {
  for (const error of errors) yield error._tag;
};
