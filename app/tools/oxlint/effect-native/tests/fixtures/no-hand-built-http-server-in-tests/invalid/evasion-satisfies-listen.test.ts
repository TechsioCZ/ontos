// expect-count: 3
// `as T` is unwrapped by the rule but `satisfies T` is not, so the listen binding is lost.
import { createServer } from "node:http";

interface Listening {
	readonly listen: (port: number, host: string) => void;
}

const server = createServer(() => {}) satisfies Listening;
server.listen(0, "127.0.0.1");
