// expect-count: 1
import { Context, Effect } from 'effect';

interface AccessService { readonly check: Effect.Effect<boolean>; }
interface CurrentService { readonly read: Effect.Effect<string>; }
class Current extends Context.Service<Current, CurrentService>()('Current') {}
interface FactoryContract {
  readonly make: (access: AccessService) => CurrentService;
}

