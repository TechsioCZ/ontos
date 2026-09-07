import { Context } from 'effect';

export class Parent extends Context.Service<Parent, 'parent'>()(
  '@app/effect-rstest/tests/support/parent',
) {}
