import { Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { ShellGatewayBaseUrlSchema } from '../../src/shell-gateway-url.ts';

/** The same address over plain HTTP. */
const plainHttp = (address: string) => {
  const url = new URL(address);
  url.protocol = 'http:';
  return url.toString();
};

it('admits HTTPS anywhere and plain HTTP only to a loopback host, never credentials, query or fragment', () => {
  const admitted = Schema.is(Schema.toType(ShellGatewayBaseUrlSchema));
  const decode = Schema.decodeUnknownOption(ShellGatewayBaseUrlSchema);
  for (const address of [
    'https://shell.example.test/shell-super-app-api',
    plainHttp('https://127.0.0.1:3020/shell-super-app-api'),
    plainHttp('https://localhost:3020/shell-super-app-api'),
    plainHttp('https://[::1]:3020/shell-super-app-api'),
  ]) {
    expect(decode(address)._tag).toBe('Some');
  }
  for (const address of [
    plainHttp('https://shell.internal.example/shell-super-app-api'),
    plainHttp('https://10.0.0.5:3020/shell-super-app-api'),
    'https://user:secret@shell.example.test/shell-super-app-api',
    'https://shell.example.test/shell-super-app-api?next=1',
    'https://shell.example.test/shell-super-app-api#part',
    'ftp://shell.example.test/',
  ]) {
    expect(decode(address)._tag).toBe('None');
  }
  expect(admitted).toBeDefined();
});
