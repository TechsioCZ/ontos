// expect-count: 2
import { createServer } from 'node:net';

export const server = createServer();
server.on('connection', (socket) => socket.write(`HTTP/1.1 ${200} OK\r\n\r\n`));
server.listen(0);
