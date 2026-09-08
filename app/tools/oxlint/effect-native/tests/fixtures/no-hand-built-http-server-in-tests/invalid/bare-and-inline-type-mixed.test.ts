// expect-count: 3
import "node:net";
import { type IncomingMessage, createServer } from "node:http";

export const server = createServer((_request: IncomingMessage) => {});
