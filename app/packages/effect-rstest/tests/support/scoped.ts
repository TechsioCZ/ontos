import { Context } from 'effect';

export class Scoped extends Context.Service<Scoped, 'scoped'>()(
  '@app/effect-rstest/tests/support/scoped',
) {}
