// expect-count: 2
// tests/support/** is in scope: a shared bridge is still three copies of node:http in one place.
import { createServer } from "node:http";

export const bridge = createServer(() => {});
