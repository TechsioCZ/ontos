import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { DateTime, Effect, Redacted } from 'effect';

import { GatewayNotificationRejected } from '../psp/psp-errors.ts';
import type { GatewayNotificationRejectedError, GatewayNotificationRejectionReason } from '../psp/psp-errors.ts';

/**
 * Stripe webhook `v1` signature verification (#1157, #1154), per
 * https://docs.stripe.com/webhooks#verify-manually.
 *
 * The header is `t=<unix seconds>,v1=<hex>[,v1=<hex>...][,v0=...]`. The expected signature is
 * HMAC-SHA256(secret, utf8(`${t}.`) || rawBody) in lowercase hex. Only `v1` values count; `v0` and
 * unknown keys are ignored. Time comes only from `verifiedAt`; this module never reads a clock.
 * Nothing here logs or includes the header, the body or the secret in an error.
 */

const TIMESTAMP_PATTERN = /^[0-9]{1,15}$/u;
const SIGNATURE_PATTERN = /^[0-9a-fA-F]{64}$/u;

export interface VerifyStripeSignatureInput {
  readonly header: string;
  readonly rawBody: Uint8Array;
  readonly secret: Redacted.Redacted;
  readonly toleranceSeconds: number;
  readonly verifiedAt: DateTime.Utc;
}

export interface VerifiedStripeSignature {
  readonly timestamp: number;
}

interface ParsedStripeSignatureHeader {
  readonly timestamp: number;
  readonly v1Signatures: readonly Uint8Array[];
}

const rejected = (reason: GatewayNotificationRejectionReason): GatewayNotificationRejectedError =>
  new GatewayNotificationRejected({
    code: 'gateway_notification_rejected',
    family: 'STRIPE',
    reason,
  });

const hexToBytes = (hex: string): Uint8Array => {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
};

const parseHeader = (header: string): ParsedStripeSignatureHeader | null => {
  let timestamp: number | null = null;
  const v1Signatures: Uint8Array[] = [];

  for (const part of header.split(',')) {
    const separator = part.indexOf('=');
    if (separator <= 0) {
      continue;
    }
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();

    if (key === 't') {
      if (timestamp !== null || !TIMESTAMP_PATTERN.test(value)) {
        return null;
      }
      timestamp = Number(value);
    } else if (key === 'v1') {
      if (!SIGNATURE_PATTERN.test(value)) {
        return null;
      }
      v1Signatures.push(hexToBytes(value.toLowerCase()));
    }
  }

  if (timestamp === null || v1Signatures.length === 0) {
    return null;
  }
  return { timestamp, v1Signatures };
};

/**
 * Compares the full length of both arrays and never returns at the first differing byte, so the
 * position of a mismatch does not change how long the comparison runs.
 */
const sameBytes = (left: Uint8Array, right: Uint8Array): boolean => {
  if (left.length !== right.length) {
    return false;
  }
  let mismatch = false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      mismatch = true;
    }
  }
  return !mismatch;
};

const expectedSignature = (timestamp: number, rawBody: Uint8Array, signingKey: Uint8Array): Uint8Array => {
  const prefix = utf8ToBytes(`${timestamp}.`);
  const message = new Uint8Array(prefix.length + rawBody.length);
  message.set(prefix, 0);
  message.set(rawBody, prefix.length);
  return hmac(sha256, signingKey, message);
};

export const verifyStripeSignature = (
  input: VerifyStripeSignatureInput,
): Effect.Effect<VerifiedStripeSignature, GatewayNotificationRejectedError> => {
  const parsed = parseHeader(input.header);
  if (parsed === null) {
    return Effect.fail(rejected('MALFORMED'));
  }

  const expected = expectedSignature(parsed.timestamp, input.rawBody, utf8ToBytes(Redacted.value(input.secret)));
  let matched = false;
  for (const candidate of parsed.v1Signatures) {
    if (sameBytes(candidate, expected)) {
      matched = true;
    }
  }
  if (!matched) {
    return Effect.fail(rejected('SIGNATURE_INVALID'));
  }

  const verifiedAtSeconds = Math.floor(DateTime.toEpochMillis(input.verifiedAt) / 1000);
  if (Math.abs(verifiedAtSeconds - parsed.timestamp) > input.toleranceSeconds) {
    return Effect.fail(rejected('SIGNATURE_STALE'));
  }

  return Effect.succeed({ timestamp: parsed.timestamp });
};
