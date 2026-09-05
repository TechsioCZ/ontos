import { type IncomingMessage, type ServerResponse } from "node:http";

export type FixtureHandler = (request: IncomingMessage, response: ServerResponse) => void;
