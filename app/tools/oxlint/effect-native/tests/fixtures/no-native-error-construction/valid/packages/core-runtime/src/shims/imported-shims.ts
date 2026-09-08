// Browser shims imported under the global names: import bindings are not the ambient globals.
import { AggregateError, Error } from "./browser-error-shims.ts";

export const shimmed = new Error("from the shim module");

export const aggregated = new AggregateError([], "from the shim module");

export const isShim = (value: unknown): boolean => value instanceof Error;
