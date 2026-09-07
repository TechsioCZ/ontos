import { Context } from 'effect';

export class SharedChild extends Context.Service<SharedChild, { readonly id: number }>()(
  '@app/effect-rstest/tests/support/shared-child/SharedChild',
) {}
