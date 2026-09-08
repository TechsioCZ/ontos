import { request, STATUS_CODES } from 'node:http';
import { Agent } from 'node:https';
import { isIP } from 'node:net';
const createServer = () => ({ listen() {} });
const server = createServer();
server.listen();
function fakeRequire(require: (id: string) => { createServer(): { listen(): void } }) {
  require('node:http').createServer().listen();
}
export { request, STATUS_CODES, Agent, isIP, fakeRequire };
