import { Context } from 'effect';
import type { Ref } from 'effect';

export class State extends Context.Service<
  State,
  { readonly id: number; readonly migrated: Ref.Ref<boolean>; readonly todos: Ref.Ref<string[]> }
>()('@app/effect-rstest/tests/support/state') {}
