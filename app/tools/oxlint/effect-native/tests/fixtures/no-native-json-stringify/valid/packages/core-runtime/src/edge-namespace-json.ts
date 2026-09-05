// A namespace-imported `JSON` is likewise a local binding.
import * as JSON from "./json-codec.ts";

declare const v: unknown;

export const encoded = JSON.stringify(v);
