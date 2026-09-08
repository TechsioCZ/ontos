// The `ManagedRuntime` used here is a parameter that shadows the import, so it builds no Effect runtime.
import { ManagedRuntime } from 'effect';

export type Imported = typeof ManagedRuntime;

export const wrap = (ManagedRuntime: { readonly make: (value: number) => void }): void =>
  ManagedRuntime.make(1);
