import type * as http from "node:http";
import { type createServer } from "node:http";

export type Factory = typeof createServer;
export type Handler = http.RequestListener;
