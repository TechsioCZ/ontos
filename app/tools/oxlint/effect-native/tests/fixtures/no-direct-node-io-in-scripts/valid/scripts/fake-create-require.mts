// createRequire spelling alone is not Node loader identity.
import { createRequire as fake } from "./loader.mjs";
const createRequire = fake;
const load = createRequire(import.meta.url);
load("node:fs");
export { type Stats } from "node:fs";
