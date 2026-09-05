import { ManagedRuntime } from 'effect';
let runtime = ManagedRuntime;
runtime = { make: () => 'domain object' };
export const domainValue = runtime.make();
