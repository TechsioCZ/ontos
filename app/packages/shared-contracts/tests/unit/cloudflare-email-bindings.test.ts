import { expect, it } from '@rstest/core';
import { createCloudflareEmailBindings } from '../../tooling/modern-config.ts';

it('omits the Email Service binding unless an onboarded sender build input is set', () => {
  expect(createCloudflareEmailBindings(() => undefined)).toEqual({});
  expect(createCloudflareEmailBindings(() => '')).toEqual({});
});
it('emits only the allowed stage sender, without a wildcard binding', () => {
  expect(
    createCloudflareEmailBindings((key) =>
      key === 'ULTRAMODERN_EMAIL_SENDER' ? 'noreply@ontos-stage.bleeding.dev' : undefined,
    ),
  ).toEqual({
    send_email: [{ name: 'EMAIL', allowed_sender_addresses: ['noreply@ontos-stage.bleeding.dev'] }],
  });
});
it('rejects display names and malformed addresses as sender build inputs', () => {
  for (const sender of ['not-email', 'Name <a@b.dev>', 'a@b.dev\r\nHeader']) {
    expect(() => createCloudflareEmailBindings(() => sender)).toThrow('bare email address');
  }
});
