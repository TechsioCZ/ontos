// expect-count: 2
import { createServer } from "node:http";

export const started = createServer(() => {}).listen(0, "127.0.0.1");
