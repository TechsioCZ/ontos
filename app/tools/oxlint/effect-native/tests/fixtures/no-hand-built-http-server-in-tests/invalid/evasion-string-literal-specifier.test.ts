// expect-count: 2
import { "createServer" as makeServer } from "node:http";

export const server = makeServer(() => {});
