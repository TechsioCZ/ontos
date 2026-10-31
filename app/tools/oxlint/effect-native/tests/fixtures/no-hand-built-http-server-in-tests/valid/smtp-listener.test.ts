import { createServer } from 'node:net';

// A native SMTP adapter needs SMTP responses, not an HttpApi test client.
export const server = createServer((socket) => {
  socket.setEncoding('utf-8');
  socket.write('220 fake.smtp ESMTP\r\n');
  socket.on('data', (chunk: string) => {
    if (chunk.startsWith('EHLO')) {
      socket.write('250-fake.smtp\r\n250 8BITMIME\r\n');
    } else if (chunk.startsWith('MAIL FROM') || chunk.startsWith('RCPT TO')) {
      socket.write('250 OK\r\n');
    } else if (chunk === 'DATA\r\n') {
      socket.write('354 go ahead\r\n');
    } else if (chunk === 'QUIT\r\n') {
      socket.end('221 bye\r\n');
    }
  });
});
server.listen(0, '127.0.0.1');
