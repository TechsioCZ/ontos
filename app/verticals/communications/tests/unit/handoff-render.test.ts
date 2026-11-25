import { Result } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { approvedMessageTypes } from '../../src/domain/catalog/approved-registry.ts';
import { templateContractOf } from '../../src/domain/catalog/template-contract.ts';
import type { TemplateContract } from '../../src/domain/catalog/template-contract.ts';
import { renderPinnedRevision } from '../../src/domain/language/handoff-render.ts';

/**
 * #1399 D.5-D.7, L-06..L-09, AC-05/06/08 at the last stoppable handoff: the pinned revision is rendered against the contract
 * of its approved type. A missing required value or an invalid link stops the message with a distinct closed code, a secret
 * slot is left for its owner, and none of the refusals carries a value. The texts are FICTIONAL.
 */

const RESET = 'commerce.customer-context.portal-auth.reset-password-message';
const resetContract = (): TemplateContract => {
  const type = approvedMessageTypes.find(({ typeId }) => typeId === RESET);
  return type === undefined ? { placeholders: [] } : templateContractOf(type);
};
const secretOnly = {
  body: '[FICTIONAL TEST COPY]\n\n{{reset_link}}',
  optionalPlaceholders: [],
  requiredPlaceholders: ['reset_link'],
  subject: '[FICTIONAL TEST COPY] subject',
};
const failureOf = (result: ReturnType<typeof renderPinnedRevision>) =>
  Result.isFailure(result) ? result.failure : undefined;

/** A FICTIONAL type with generic placeholders and a link policy, the way a source owner would declare one. */
const genericContract: TemplateContract = {
  linkPolicy: { allowedOrigins: ['https://portal.fictional.test'] },
  placeholders: [
    { kind: 'text', name: 'customer_name', required: true },
    { kind: 'link', name: 'portal_link', omission: 'omit-paragraph', required: false },
  ],
};
const generic = {
  body: '[FICTIONAL TEST COPY] Hello {{customer_name}}\n\nOpen: {{portal_link}}',
  optionalPlaceholders: ['portal_link'],
  requiredPlaceholders: ['customer_name'],
  subject: '[FICTIONAL TEST COPY] for {{customer_name}}',
};

describe('The pinned revision is rendered against its type contract at the last stoppable handoff', () => {
  it('passes a Portal Auth revision whose only placeholder is the secret slot and leaves that slot to Auth', () => {
    const result = renderPinnedRevision({ contract: resetContract(), language: 'cs', revision: secretOnly });
    expect(Result.isSuccess(result)).toBe(true);
    const message = Result.getOrThrow(result);
    expect(message.ownerSlots).toEqual(['reset_link']);
    // the slot is still a token in text and HTML: Communications holds no secret
    expect(message.text).toContain('{{reset_link}}');
    expect(message.html).toContain('{{reset_link}}');
  });

  it('stops a revision whose required secret slot never reaches the message', () => {
    expect(
      failureOf(
        renderPinnedRevision({
          contract: resetContract(),
          language: 'cs',
          revision: { ...secretOnly, body: '[FICTIONAL TEST COPY] no slot here' },
        }),
      ),
    ).toEqual({ code: 'required_owner_slot_missing', placeholders: ['reset_link'] });
  });

  it('stops a revision with a secret slot in the subject, which no owner step completes', () => {
    expect(
      failureOf(
        renderPinnedRevision({
          contract: resetContract(),
          language: 'cs',
          revision: { ...secretOnly, subject: '[FICTIONAL TEST COPY] {{reset_link}}' },
        }),
      ),
    ).toEqual({ code: 'owner_slot_in_subject', placeholders: ['reset_link'] });
  });

  it('stops a revision that needs a generic value nobody published, naming the placeholder and never a value', () => {
    const refusal = failureOf(renderPinnedRevision({ contract: genericContract, language: 'cs', revision: generic }));
    expect(refusal).toEqual({ code: 'required_value_missing', placeholders: ['customer_name'] });
  });

  it('shows a published value escaped and stops a link outside the owner policy with its own code', () => {
    const shown = Result.getOrThrow(
      renderPinnedRevision({
        contract: genericContract,
        language: 'cs',
        revision: generic,
        values: { customer_name: { kind: 'text', value: '<b>Novák & syn</b>' } },
      }),
    );
    expect(shown.html).toContain('&lt;b&gt;Novák &amp; syn&lt;/b&gt;');
    expect(shown.html).not.toContain('<b>');
    expect(
      failureOf(
        renderPinnedRevision({
          contract: genericContract,
          language: 'cs',
          revision: generic,
          values: {
            customer_name: { kind: 'text', value: 'Novák' },
            portal_link: { kind: 'link', url: 'https://evil.fictional.test/steal' },
          },
        }),
      ),
    ).toEqual({ code: 'link_not_permitted', placeholders: ['portal_link'] });
    const linked = Result.getOrThrow(
      renderPinnedRevision({
        contract: genericContract,
        language: 'cs',
        revision: generic,
        values: {
          customer_name: { kind: 'text', value: 'Novák' },
          portal_link: { kind: 'link', url: 'https://portal.fictional.test/orders/42' },
        },
      }),
    );
    expect(linked.text).toContain('https://portal.fictional.test/orders/42');
  });

  it('approves no link at all for a type that declares no link policy', () => {
    const { linkPolicy: _dropped, ...withoutPolicy } = genericContract;
    expect(
      failureOf(
        renderPinnedRevision({
          contract: withoutPolicy,
          language: 'cs',
          revision: generic,
          values: {
            customer_name: { kind: 'text', value: 'Novák' },
            portal_link: { kind: 'link', url: 'https://portal.fictional.test/orders/42' },
          },
        }),
      ),
    ).toEqual({ code: 'link_not_permitted', placeholders: ['portal_link'] });
  });

  it('stops a revision that declares a placeholder its type does not publish', () => {
    expect(
      failureOf(
        renderPinnedRevision({
          contract: resetContract(),
          language: 'cs',
          revision: { ...secretOnly, requiredPlaceholders: ['reset_link', 'invoice_number'] },
        }),
      )?.code,
    ).toBe('contract_mismatch');
  });
});
