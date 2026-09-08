// expect-count: 3
import { createServer } from "node:http";

export const server = createServer(() => {});
server.listen(0, "127.0.0.1");
