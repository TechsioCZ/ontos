// A default-imported `JSON` codec is an imported binding, never the ambient global.
import JSON from "./json-codec.ts";

declare const v: unknown;

export const encoded = JSON.stringify(v);
