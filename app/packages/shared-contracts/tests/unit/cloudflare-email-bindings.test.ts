import { expect, it } from 'effect-rstest';

import { createCloudflareEmailBindings } from '../../tooling/modern-config.ts';

it('omits the Email Service binding unless an onboarded sender build input is set', () => {
  const unrelatedBuildInputs = new Map([['ULTRAMODERN_RSDOCTOR', '0']]);
  expect(createCloudflareEmailBindings((key) => unrelatedBuildInputs.get(key))).toEqual({});
  expect(createCloudflareEmailBindings(() => '')).toEqual({});
  expect(createCloudflareEmailBindings(() => ' \t\n')).toEqual({});
});

it('emits only the allowed stage sender, without a wildcard binding', () => {
  expect(
    createCloudflareEmailBindings((key) =>
      key === 'ULTRAMODERN_EMAIL_SENDER' ? 'noreply@ontos-stage.bleeding.dev' : undefined,
    ),
  ).toEqual({
    send_email: [{ allowed_sender_addresses: ['noreply@ontos-stage.bleeding.dev'], name: 'EMAIL' }],
  });
});

it('trims the configured sender before emitting the binding', () => {
  expect(createCloudflareEmailBindings(() => '  noreply@ontos-stage.bleeding.dev \t')).toEqual({
    send_email: [{ allowed_sender_addresses: ['noreply@ontos-stage.bleeding.dev'], name: 'EMAIL' }],
  });
});

it('rejects display names and malformed addresses as sender build inputs', () => {
  for (const sender of ['not-email', 'Name <a@b.dev>', 'a@b.dev\r\nHeader', 'a b@c.dev', 'a@b.dev,c@d.dev']) {
    expect(() => createCloudflareEmailBindings(() => sender)).toThrow('bare email address');
  }
});
