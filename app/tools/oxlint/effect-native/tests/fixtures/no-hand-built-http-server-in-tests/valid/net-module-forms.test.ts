import 'node:net';
export * as net from 'net';

// Importing a generic transport does not establish an HTTP test server.
export const load = () => import('node:net');
