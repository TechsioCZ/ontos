import net from 'node:net';

// Generic TCP does not establish that a listener speaks HTTP.
export const server = net.createServer((socket) => {
  socket.end('PONG\r\n');
  const otherSocket = { end(_message: string) {} };
  otherSocket.end('HTTP/1.1 200 OK\r\n\r\n');
});
server.listen(0);
