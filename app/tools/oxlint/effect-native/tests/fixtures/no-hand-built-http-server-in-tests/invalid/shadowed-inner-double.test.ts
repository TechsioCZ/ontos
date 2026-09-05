// expect-count: 1
// Only the import reports: the inner `createServer` is a local test double, not the node:http one.
import { createServer } from "node:http";

export function makeStub() {
	const createServer = (handler: () => void) => ({ listen: (_port: number) => handler() });
	const server = createServer(() => {});
	server.listen(0);
	return server;
}

export const real = typeof createServer;
