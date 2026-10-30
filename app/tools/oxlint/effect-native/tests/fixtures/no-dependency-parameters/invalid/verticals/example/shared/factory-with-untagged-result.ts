// expect-count: 1
import { Context, Effect } from 'effect';

interface AccessService { readonly check: Effect.Effect<boolean>; }
interface CurrentService { readonly read: Effect.Effect<string>; }

interface FactoryContract {
  readonly make: (access: AccessService) => CurrentService;
}
class Factory extends Context.Service<Factory, FactoryContract>()('Factory') {}
