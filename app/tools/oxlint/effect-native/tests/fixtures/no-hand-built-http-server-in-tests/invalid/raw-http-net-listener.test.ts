// expect-count: 2
import { createServer } from 'node:net';

export const server = createServer((socket) => {
  socket.on('data', () => socket.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nOK'));
});
server.listen(0, '127.0.0.1');
