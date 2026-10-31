// @rstest-environment node
import { expect, it } from 'effect-rstest';

import { relayModuleResponse } from '../../src/module-api/response-relay.ts';

const timingHeader = (value: string) =>
  relayModuleResponse(new Response(null, { headers: { 'server-timing': value } })).headers.get('server-timing');

it('relays fixed numeric owner phases without descriptions or unapproved diagnostics', () => {
  expect(
    timingHeader(
      [
        ' read-owner ; dur=1.25 ',
        'read-encode;dur=0.0000001',
        'private-principal;dur=1',
        'owner-dispatch;dur=999',
        'read-audit;dur=1;desc="secret"',
        'private;desc="prefix, read-owner;dur=123456, suffix"',
        String.raw`private;desc="escaped \" quote, read-owner;dur=123456, suffix"`,
        'read-rls;dur=NaN',
        'read-rls;dur=Infinity',
        'read-rls;dur=-1',
        'read-rls;dur=-0',
        'read-rls;dur=+1',
        'read-rls;dur=1e3',
        'read-rls;dur=0x10',
        'read-rls;dur=.5',
        'read-rls;dur=5.',
        'read-rls;dur=1.2.3',
        'read-rls;dur=2ms',
        `read-rls;dur=${'9'.repeat(309)}`,
      ].join(', '),
    ),
  ).toBe('read-owner;dur=1.25, read-encode;dur=0.0000001');
});

it.each([
  '',
  'private;dur=1, read-owner;dur=NaN',
  'private;desc="unclosed, read-owner;dur=123456, read-encode;dur=2',
  `read-owner;dur=1, ${'private'.repeat(600)}`,
])('omits an empty, unsafe, malformed or oversized timing header: %s', (header) => {
  expect(timingHeader(header)).toBeNull();
});

it('bounds relayed metrics before any gateway collector runs', () => {
  expect(timingHeader(Array.from({ length: 70 }, () => 'read-owner;dur=1').join(', '))).toBe(
    Array.from({ length: 64 }, () => 'read-owner;dur=1').join(', '),
  );
});

it('does not change the separately admitted realm cookie policy', () => {
  const approved = 'portal.session_token=opaque; Path=/; HttpOnly; SameSite=Lax';
  const response = relayModuleResponse(
    new Response(null, {
      headers: [
        ['server-timing', 'read-owner;dur=1, private;desc="secret"'],
        ['set-cookie', approved],
        ['set-cookie', 'portal.session_token=unsafe; Path=/; HttpOnly; SameSite=Lax; Domain=shell.test'],
        ['set-cookie', 'staff.session_token=private; Path=/; HttpOnly; SameSite=Lax'],
      ],
    }),
    'https://shell.test',
    ['portal.session_token'],
  );
  expect(response.headers.get('server-timing')).toBe('read-owner;dur=1');
  expect(response.headers.getSetCookie()).toEqual([approved]);
});
