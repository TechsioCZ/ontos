// Nothing from `effect` is imported: identical spellings from another library are inert.
import { Layer, ManagedRuntime } from 'some-other-library';

declare const anything: unknown;

export const a = ManagedRuntime.make(anything);
export const b = Layer.launch(anything);
