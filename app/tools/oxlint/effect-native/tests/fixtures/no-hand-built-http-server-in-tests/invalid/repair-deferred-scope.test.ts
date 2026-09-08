// expect-count: 6
export const start = () => server.listen(0);
const server = createServer(() => {}) satisfies { listen(port: number): void };
import { createServer } from 'node:http';
import { createRequire as nodeRequire } from 'node:module';
const load = nodeRequire(import.meta.url);
const { createServer: make } = load('node:https');
const secure = make(() => {});
secure.listen(0);
export const double = (server: { listen(port: number): void }) => server.listen(0);
