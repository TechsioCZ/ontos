/** An imported binding aliased to `Date` is not the global constructor. */
import { Temporal as Date } from "temporal-polyfill";

export const stamp = new Date();
export const again = new Date("2026-01-01T00:00:00Z");
