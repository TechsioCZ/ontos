type NodeServer = import("node:http").Server;
export type Factory = typeof import("node:http").createServer;

declare const server: NodeServer;
export const closed = server;
