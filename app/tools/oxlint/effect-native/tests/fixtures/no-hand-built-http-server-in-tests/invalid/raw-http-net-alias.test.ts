// expect-count: 2
import net from 'net';
import type { Socket } from 'net';

const response = 'HTTP/1.1 200 OK\r\n\r\n';
const handler = (socket: Socket) => socket.end(response);
const listener = handler;
const make = net.createServer;
export const server = make(listener);
server.listen(0);
