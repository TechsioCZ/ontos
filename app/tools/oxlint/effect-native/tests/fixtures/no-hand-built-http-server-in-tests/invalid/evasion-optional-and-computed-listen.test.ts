// expect-count: 3
import { createServer } from "node:http";

const server = (createServer(() => {}) as { listen?: (port: number) => void });
server?.["listen"]?.(0);
