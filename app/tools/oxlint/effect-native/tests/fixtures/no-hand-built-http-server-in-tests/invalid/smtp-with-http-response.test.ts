// expect-count: 2
import { createServer } from 'node:net';

// An SMTP greeting does not exempt a handler that also sends HTTP responses.
export const server = createServer((socket) => {
  socket.write('220 fake.smtp ESMTP\r\n');
  socket.on('data', () => socket.end('HTTP/1.1 500 Internal Server Error\r\n\r\n'));
});
server.listen(0);
