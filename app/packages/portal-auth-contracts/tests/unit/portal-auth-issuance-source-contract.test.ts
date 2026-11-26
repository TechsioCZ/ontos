import { Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  PortalAuthIssuanceSourceRequestSchema,
  PortalAuthIssuanceSourceResponseSchema,
  PortalAuthIssuanceSourceStateSchema,
  portalAuthIssuanceSourceOperation,
} from '../../src/apis/portal-auth-issuance-source.ts';
import {
  PORTAL_AUTH_ISSUANCE_REVISION,
  PORTAL_AUTH_ISSUANCE_STATE,
  PortalAuthIssuanceRefSchema,
} from '../../src/portal-auth-issuance.ts';

const issuanceRef = 'issuance-2026-11-19.1';
const decodeRef = Schema.decodeUnknownSync(PortalAuthIssuanceRefSchema);

describe('Portal Auth issuance source public contract', () => {
  it('publishes the closed issuance state vocabulary the answer schema accepts', () => {
    const states = Object.values(PORTAL_AUTH_ISSUANCE_STATE);
    expect(states).toHaveLength(6);
    for (const state of states) {
      expect(Schema.decodeUnknownSync(PortalAuthIssuanceSourceStateSchema)(state)).toBe(state);
    }
    expect(() => Schema.decodeUnknownSync(PortalAuthIssuanceSourceStateSchema)('issuance-unknown')).toThrow();
  });

  it('accepts only an opaque issuance reference, never a link-, token- or address-shaped value', () => {
    expect(decodeRef(issuanceRef)).toBe(issuanceRef);
    for (const refused of [
      '',
      ' padded',
      'holder@example.test',
      'https://portal.example.test/x?token=t',
      'a'.repeat(121),
    ]) {
      expect(() => decodeRef(refused)).toThrow();
    }
  });

  it('decodes the request naming the issuance and, optionally, the recipient account, and nothing else', () => {
    const decode = Schema.decodeUnknownSync(PortalAuthIssuanceSourceRequestSchema, { onExcessProperty: 'error' });
    expect(decode({ issuanceRef })).toEqual({ issuanceRef });
    expect(decode({ issuanceRef, recipientSubjectId: 'subject-1' })).toEqual({
      issuanceRef,
      recipientSubjectId: 'subject-1',
    });
    expect(() => decode({ address: 'holder@example.test', issuanceRef })).toThrow();
    expect(() => decode({ issuanceRef, recipientSubjectId: '' })).toThrow();
  });

  it('decodes state and binding facts only, always at the one issuance revision', () => {
    const decode = Schema.decodeUnknownSync(PortalAuthIssuanceSourceResponseSchema, { onExcessProperty: 'error' });
    expect(decode({ kind: 'NO_FACTS' })).toEqual({ kind: 'NO_FACTS' });
    const facts = {
      issuanceRef,
      kind: 'FACTS',
      latestRevision: PORTAL_AUTH_ISSUANCE_REVISION,
      originalEndpoint: { kind: 'CURRENT', mask: 'h***@example.test' },
      state: PORTAL_AUTH_ISSUANCE_STATE.current,
    };
    expect(decode(facts)).toEqual(facts);
    expect(() => decode({ ...facts, latestRevision: 2 })).toThrow();
    expect(() => decode({ ...facts, address: 'holder@example.test' })).toThrow();
    expect(() => decode({ ...facts, originalEndpoint: { kind: 'CURRENT', mask: '' } })).toThrow();
  });

  it('names the published Read of Auth as the typed operation a consumer calls', () => {
    expect(portalAuthIssuanceSourceOperation).toMatchObject({
      kind: 'read',
      provider: {
        entrypointKey: 'commerce.customer-context.api.portal-auth-issuance-source',
        moduleId: 'commerce.customer-context',
        schemaVersion: '1',
      },
      request: PortalAuthIssuanceSourceRequestSchema,
      response: PortalAuthIssuanceSourceResponseSchema,
    });
    expect(portalAuthIssuanceSourceOperation.route).toMatchObject({ path: '/reads/portal-auth-issuance-source' });
  });
});
