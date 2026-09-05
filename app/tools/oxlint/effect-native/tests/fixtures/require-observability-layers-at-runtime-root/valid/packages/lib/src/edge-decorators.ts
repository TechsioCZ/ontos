// Decorators plus a local runtime lookalike: nothing here is an `effect` binding.
import { ManagedRuntime } from './fake-runtime.ts';

declare function Injectable(): ClassDecorator;

@Injectable()
export class LocalBoot {
  static readonly runtime = ManagedRuntime.make({});
}
