import { Context } from 'effect';

export class Child extends Context.Service<Child, { readonly id: number }>()(
  '@app/effect-rstest/tests/support/child',
) {}
