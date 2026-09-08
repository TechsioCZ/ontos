// Type-only references to the tracked namespaces are erased and construct nothing.
import type { Layer, ManagedRuntime } from 'effect';

export type HostRuntime = ManagedRuntime.ManagedRuntime<never, never>;
export type AnyLayer = Layer.Layer<never, never, never>;
export type Maker = typeof ManagedRuntime.make;
export type Launcher = typeof Layer.launch;

export interface Wiring {
  readonly make: Maker;
  readonly launch: Launcher;
}

export declare function receive(wiring: Wiring): HostRuntime;
