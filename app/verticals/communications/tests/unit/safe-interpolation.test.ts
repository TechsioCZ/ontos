import { Option, Result, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';
import { htmlToPlainText, renderMessage } from '../../src/domain/language/interpolation.ts';
import type {
  PlaceholderContract,
  RenderInput,
  RenderRefusal,
  RenderedMessage,
} from '../../src/domain/language/interpolation.ts';
import { GenericValueSchema, amountDigits, formatDate, formatMoney } from '../../src/domain/language/values.ts';
import type { GenericValue } from '../../src/domain/language/values.ts';

const NBSP = '\u00A0';
// the owner approves one origin and declares the only two query parameters its links carry
const linkPolicy = { allowedOrigins: ['https://portal.fictional.test'], allowedQueryParameters: ['lang', 'tab'] };
// Clearly labelled FICTIONAL copy: no production wording, no recipient, no secret.
const template = {
  body: [
    '[FICTIONAL TEST COPY] Hello {{customer_name}}.',
    'Order {{order_number}} total: {{total}}.\nDue: {{due_date}}',
    'Invoice number: {{invoice_number}}',
    'Open your order: {{portal_link}}',
  ].join('\n\n'),
  optionalPlaceholders: ['invoice_number', 'portal_link'],
  requiredPlaceholders: ['customer_name', 'due_date', 'order_number', 'total'],
  subject: '[FICTIONAL TEST COPY] Order {{order_number}}',
};
const contract: readonly PlaceholderContract[] = [
  { kind: 'text', name: 'customer_name' },
  { kind: 'date', name: 'due_date' },
  { kind: 'text', name: 'order_number' },
  { kind: 'money', name: 'total' },
  { kind: 'text', name: 'invoice_number', omission: 'omit-paragraph' },
  { kind: 'link', name: 'portal_link', omission: 'omit-paragraph' },
];
const text = (value: string): GenericValue => ({ kind: 'text', value });
const baseValues = {
  customer_name: text('Zoë Novák'),
  due_date: { kind: 'date', value: '2026-12-31' },
  order_number: text('OBJ-2026-0042'),
  total: { amount: '1200.50', currency: 'CZK', kind: 'money' },
} satisfies Record<string, GenericValue>;
const renderExact = (overrides: Partial<RenderInput> = {}) =>
  renderMessage({ contract, language: 'cs', linkPolicy, template, values: baseValues, ...overrides });
/** The values of the call are added to the complete base values; `renderExact` takes them exactly. */
const render = (overrides: Partial<RenderInput> = {}) =>
  renderExact({ ...overrides, values: { ...baseValues, ...overrides.values } });
const rendered = (result: Result.Result<RenderedMessage, RenderRefusal>): RenderedMessage => {
  expect(Result.isSuccess(result)).toBe(true);
  return Result.getOrThrow(result);
};
const refusal = (result: Result.Result<RenderedMessage, RenderRefusal>): RenderRefusal => {
  expect(Result.isFailure(result)).toBe(true);
  return Result.isFailure(result) ? result.failure : { code: 'contract_mismatch', placeholders: [] };
};
const omitting = (...names: string[]): Record<string, GenericValue> =>
  Object.fromEntries(Object.entries(baseValues).filter(([name]) => !names.includes(name)));

const linkTo = (url: string) => render({ values: { portal_link: { kind: 'link', url } } });

describe('Business values are shown exactly as the owner published them (L-06, S12, S14, S18)', () => {
  it('[S12 AC-05] an English message keeps exactly 1200.50 CZK: only separators change, no conversion, no tax', () => {
    const message = rendered(render({ language: 'en' }));
    expect(message.text).toContain(`Order OBJ-2026-0042 total: 1,200.50${NBSP}CZK.`);
    expect(message.text).not.toMatch(/EUR|USD|VAT|DPH/u);
    expect(message.subject).toBe('[FICTIONAL TEST COPY] Order OBJ-2026-0042');
  });

  it('[S18 AC-05] the Czech revision shows Czech separators and the identical amount, digits and currency', () => {
    expect(rendered(render({ language: 'cs' })).text).toContain(`total: 1${NBSP}200,50${NBSP}CZK.`);
    for (const amount of ['1200.50', '0.5', '1000000', '-1234.5', '999999999999999.999999', '0', '12']) {
      const czech = Result.getOrThrow(formatMoney(amount, 'CZK', 'cs'));
      const english = Result.getOrThrow(formatMoney(amount, 'CZK', 'en'));
      const digits = amount.replaceAll('.', '');
      expect(Option.getOrUndefined(amountDigits(czech))).toBe(digits);
      expect(Option.getOrUndefined(amountDigits(english))).toBe(digits);
      expect(czech.endsWith(`${NBSP}CZK`) && english.endsWith(`${NBSP}CZK`)).toBe(true);
    }
  });

  it('[S12 AC-05] a price in EUR stays EUR in an English message: the locale is no currency conversion', () => {
    const message = rendered(
      render({ language: 'en', values: { total: { amount: '49.90', currency: 'EUR', kind: 'money' } } }),
    );
    expect(message.text).toContain(`49.90${NBSP}EUR`);
    expect(message.text).not.toContain('CZK');
  });

  it('[S14 AC-05] the Czech and the English message of one order carry the same Accepted facts', () => {
    const czech = rendered(render({ language: 'cs' }));
    const english = rendered(render({ language: 'en' }));
    for (const fact of ['OBJ-2026-0042', 'CZK', 'Zoë Novák']) {
      expect(czech.text).toContain(fact);
      expect(english.text).toContain(fact);
    }
    expect(czech.text).toContain('31. 12. 2026');
    expect(english.text).toContain('31 December 2026');
  });

  it('[AC-05] an amount is never rounded, padded, defaulted or computed: a malformed one is refused', () => {
    for (const amount of [
      '',
      '0,5',
      '1e3',
      '1 200',
      '+5',
      '.5',
      '5.',
      '01',
      '1.1234567',
      'NaN',
      '12345678901234567',
      '-',
    ]) {
      expect(refusal(render({ values: { total: { amount, currency: 'CZK', kind: 'money' } } }))).toEqual({
        code: 'value_malformed',
        placeholders: ['total'],
      });
    }
    for (const currency of ['', 'czk', 'CZ', 'CZKK', '€']) {
      expect(refusal(render({ values: { total: { amount: '1', currency, kind: 'money' } } })).code).toBe(
        'value_malformed',
      );
    }
  });

  it('[AC-05] a date is the owner calendar date: impossible dates are refused and nothing is replaced by today', () => {
    expect(Result.getOrThrow(formatDate('2028-02-29', 'en'))).toBe('29 February 2028');
    for (const value of [
      '2026-02-30',
      '2027-02-29',
      '2026-13-01',
      '2026-00-10',
      '2026-04-31',
      '26-01-01',
      'today',
      '',
    ]) {
      expect(Result.isFailure(formatDate(value, 'cs'))).toBe(true);
    }
  });
});

describe('Required values and approved omission (L-07, L-08, S13)', () => {
  it('[S13 AC-06] a missing required value stops the message and names the placeholder, never a default', () => {
    for (const name of ['customer_name', 'order_number', 'total', 'due_date']) {
      expect(refusal(renderExact({ values: omitting(name) }))).toEqual({
        code: 'required_value_missing',
        placeholders: [name],
      });
    }
    const missingInvoice = {
      ...template,
      optionalPlaceholders: ['portal_link'],
      requiredPlaceholders: [...template.requiredPlaceholders, 'invoice_number'],
    };
    expect(
      refusal(
        renderExact({
          contract: contract.map((entry): PlaceholderContract =>
            entry.name === 'invoice_number' ? { kind: 'text', name: entry.name } : entry,
          ),
          template: missingInvoice,
        }),
      ),
    ).toEqual({ code: 'required_value_missing', placeholders: ['invoice_number'] });
  });

  it('[AC-06] an optional value with an approved omission rule drops its whole paragraph, leaving no broken text', () => {
    const message = rendered(renderExact({ values: omitting('invoice_number', 'portal_link') }));
    expect(message.text).not.toContain('Invoice number');
    expect(message.text).not.toContain('Open your order');
    expect(message.text).not.toMatch(/\{\{|\}\}|undefined|null|0\.00/u);
    expect(message.html).not.toContain('Invoice number');
    expect(htmlToPlainText(message.html)).toBe(message.text);
  });

  it('[AC-06] an optional value without an approved omission rule is not silently omitted', () => {
    const unapproved: readonly PlaceholderContract[] = contract.map((entry) =>
      entry.name === 'invoice_number' ? { kind: 'text', name: entry.name } : entry,
    );
    expect(refusal(renderExact({ contract: unapproved, values: omitting('invoice_number') }))).toEqual({
      code: 'optional_omission_not_approved',
      placeholders: ['invoice_number'],
    });
  });

  it('[AC-06] an omission rule cannot hide a placeholder of the subject or turn a required value optional', () => {
    const inSubject = { ...template, subject: '[FICTIONAL TEST COPY] Order {{invoice_number}}' };
    expect(refusal(renderExact({ template: inSubject, values: omitting('invoice_number') })).code).toBe(
      'optional_omission_not_approved',
    );
    const requiredWithRule = contract.map((entry) =>
      entry.name === 'total' ? { ...entry, omission: 'omit-paragraph' as const } : entry,
    );
    expect(refusal(render({ contract: requiredWithRule })).code).toBe('contract_mismatch');
  });

  it('[AC-06] a template that would render no content is refused', () => {
    const only = {
      body: 'Invoice number: {{invoice_number}}',
      optionalPlaceholders: ['invoice_number'],
      requiredPlaceholders: [],
      subject: '[FICTIONAL TEST COPY] Notice',
    };
    expect(
      refusal(
        renderExact({
          contract: [{ kind: 'text', name: 'invoice_number', omission: 'omit-paragraph' }],
          template: only,
          values: {},
        }),
      ),
    ).toEqual({ code: 'rendered_content_empty', placeholders: [] });
  });

  it('[AC-06] a value the revision never declared, a wrong kind and an undeclared placeholder are refused', () => {
    expect(refusal(render({ values: { extra_field: text('x') } }))).toEqual({
      code: 'value_not_declared',
      placeholders: ['extra_field'],
    });
    expect(refusal(render({ values: { order_number: { amount: '1', currency: 'CZK', kind: 'money' } } }))).toEqual({
      code: 'value_kind_mismatch',
      placeholders: ['order_number'],
    });
    expect(refusal(render({ template: { ...template, body: `${template.body}\n\n{{surprise}}` } })).code).toBe(
      'contract_mismatch',
    );
    expect(refusal(render({ contract: contract.slice(1) })).code).toBe('contract_mismatch');
  });
});

describe('Escaping, Unicode and HTML equivalence (L-09, S16, AC-08)', () => {
  const hostile = `<script>alert(1)</script> & "Co" 'x' <img src=x onerror=y>`;

  it('[S16 AC-08] a business name with HTML characters shows as text and creates no executable markup', () => {
    const message = rendered(render({ values: { customer_name: text(hostile) } }));
    expect(message.text).toContain(hostile);
    expect(message.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;Co&quot; &#39;x&#39;');
    expect(message.html).not.toMatch(/<script|<img|onerror=y>/u);
    expect(htmlToPlainText(message.html)).toBe(message.text);
  });

  it('[AC-08] the approved template text is escaped too: only the renderer adds markup', () => {
    const message = rendered(
      render({ template: { ...template, body: `${template.body}\n\nTerms <b>apply</b> & more` } }),
    );
    expect(message.html).toContain('Terms &lt;b&gt;apply&lt;/b&gt; &amp; more');
    expect(htmlToPlainText(message.html)).toBe(message.text);
  });

  it('[AC-08] Czech and English Unicode, emoji and composed forms are kept and normalized to NFC', () => {
    const decomposed = 'Zoë Novák';
    const message = rendered(render({ values: { customer_name: text(decomposed) } }));
    expect(message.text).toContain('Zoë Novák');
    for (const name of ['Žluťoučký kůň úpěl ďábelské ódy', 'Zoë Müller 東京 😀', 'Ǧ Ø ß ñ']) {
      expect(rendered(render({ values: { customer_name: text(name) } })).text).toContain(name);
    }
  });

  it('[AC-06 AC-08] control, line-break, bidi and malformed Unicode values are refused', () => {
    for (const value of [
      'a\nb',
      'a\rb',
      'a\u0000b',
      'a\u202Eb',
      'a\u2028b',
      // invisible format characters (Unicode Cf): soft hyphen, zero-width space, joiners, marks, word joiner, BOM
      'a\u00ADb',
      'a\u200Bb',
      'a\u200Cb',
      'a\u200Db',
      'a\u200Eb',
      'a\u2060b',
      'a\u2062b',
      'a\u2064b',
      'a\u2066b',
      'a\uFEFFb',
      '\u200Bsomeone',
      'a\u0085b',
      '\uD800',
      ' leading',
      'trailing ',
      '',
      'x'.repeat(501),
    ]) {
      expect(refusal(render({ values: { customer_name: text(value) } })).code).toBe('value_malformed');
    }
  });

  it('[AC-08] a value cannot inject a header line into the subject or a placeholder into the text', () => {
    expect(refusal(render({ values: { order_number: text('1\nBcc: attacker@example.test') } })).code).toBe(
      'value_malformed',
    );
    // a value that carries a placeholder token could be completed by a later owner step: it is refused outright
    for (const value of ['{{portal_link}}', 'a {{ otp_code }} b', '}}']) {
      expect(refusal(render({ values: { customer_name: text(value) } })).code).toBe('value_malformed');
    }
  });

  it('[AC-08] a placeholder named like an inherited member gets no value from the prototype', () => {
    const inherited = {
      body: 'Reference {{constructor}}',
      optionalPlaceholders: [],
      requiredPlaceholders: ['constructor'],
      subject: 'Subject',
    };
    const inheritedContract: readonly PlaceholderContract[] = [{ kind: 'text', name: 'constructor' }];
    const run = (values: Record<string, GenericValue>) =>
      renderMessage({ contract: inheritedContract, language: 'cs', linkPolicy, template: inherited, values });
    // no own value: the required value is missing, not "the Object constructor"
    expect(refusal(run({}))).toEqual({ code: 'required_value_missing', placeholders: ['constructor'] });
    // an own value is used as usual
    expect(rendered(run({ constructor: text('REF-1') })).text).toBe('Reference REF-1');
    // an own `__proto__` key is an undeclared value, never a way to reach a prototype
    expect(refusal(run(JSON.parse('{"__proto__":{"kind":"text","value":"x"}}'))).code).toBe('value_not_declared');
    // an optional placeholder with an approved omission is omitted, not filled from the prototype
    const optional = renderMessage({
      contract: [{ kind: 'text', name: 'constructor', omission: 'omit-paragraph' }],
      language: 'cs',
      linkPolicy,
      template: {
        ...inherited,
        body: 'Always\n\nReference {{constructor}}',
        optionalPlaceholders: ['constructor'],
        requiredPlaceholders: [],
      },
      values: {},
    });
    expect(rendered(optional).text).toBe('Always');
  });

  it('[L-09] HTML and text say the same thing for every rendering of the template', () => {
    const cases: Record<string, GenericValue>[] = [
      {},
      { customer_name: text(hostile) },
      { invoice_number: text('FV-2026-0001') },
      { portal_link: { kind: 'link', url: 'https://portal.fictional.test/orders/42?tab=details&lang=en' } },
      { total: { amount: '-5.5', currency: 'EUR', kind: 'money' } },
    ];
    for (const values of cases) {
      for (const language of ['cs', 'en'] as const) {
        const message = rendered(
          render({
            language,
            values: {
              invoice_number: text('X'),
              portal_link: { kind: 'link', url: 'https://portal.fictional.test/o' },
              ...values,
            },
          }),
        );
        expect(htmlToPlainText(message.html)).toBe(message.text);
      }
    }
  });
});

describe('Links stay inside the owner policy (L-07, S17)', () => {
  it('[S17 AC-06] an https link of an allowed origin is shown as the same normalized URL in text and HTML', () => {
    const message = rendered(linkTo('https://portal.fictional.test/orders/42?tab=details&lang=en'));
    expect(message.text).toContain('https://portal.fictional.test/orders/42?tab=details&lang=en');
    expect(message.html).toContain('<a href="https://portal.fictional.test/orders/42?tab=details&amp;lang=en">');
  });

  it('[S17 AC-06] an unverified, foreign, insecure or customer-steerable link is refused before handoff', () => {
    const refused = [
      'http://portal.fictional.test/orders/42',
      'https://evil.example/orders/42',
      'https://portal.fictional.test.evil.example/x',
      'https://portal.fictional.test:8443/x',
      'https://user:pass@portal.fictional.test/x',
      'https://portal.fictional.test/x#fragment',
      'https://portal.fictional.test/verify?redirect_uri=https://evil.example',
      'https://portal.fictional.test/verify?next=/account',
      'https://portal.fictional.test/verify?lang=//evil.example',
      ['https://portal.fictional.test/verify?u=java', 'script:alert(1)'].join(''),
      ['java', 'script:alert(1)'].join(''),
      'data:text/html,<script>alert(1)</script>',
      '//portal.fictional.test/x',
      '/orders/42',
      'https://portal.fictional.test/a b',
      '',
    ];
    for (const url of refused) {
      expect(refusal(linkTo(url))).toEqual({ code: 'link_not_permitted', placeholders: ['portal_link'] });
    }
  });

  it('[S17 AC-06] a link that carries a brace in any encoding is refused: no owner step can complete {{otp}} into it', () => {
    const base = 'https://portal.fictional.test/orders/42';
    const braced = [
      `${base}?tab={{otp_code}}`,
      `${base}/{{otp_code}}`,
      `${base}?tab=%7B%7Botp_code%7D%7D`,
      `${base}?tab=%7b%7botp_code%7d%7d`,
      `${base}?tab=%257B%257Botp_code%257D%257D`,
      `${base}?tab=%25257B%25257Botp_code%25257D%25257D`,
      `${base}?tab=&#123;&#123;otp_code&#125;&#125;`,
      `${base}?tab=&#x7b;&#x7B;otp_code&#x7d;&#x7D;`,
      `${base}?tab=&lbrace;&lbrace;otp_code&rbrace;&rbrace;`,
      `${base}?tab=&lcub;&lcub;otp_code&rcub;&rcub;`,
      `${base}?tab=&#123&#123otp_code`,
      `${base}?tab=%7B&#123;otp_code`,
      `${base}?tab=%26%23123%3B%26%23123%3Botp_code`,
      `${base}/%7B%7Botp_code%7D%7D`,
      `${base}?tab={`,
      `${base}?tab=}`,
      `${base}?tab=%7B`,
      `${base}?tab=%`,
    ];
    for (const url of braced) {
      expect(refusal(linkTo(url))).toEqual({ code: 'link_not_permitted', placeholders: ['portal_link'] });
    }
  });

  it('[S17 AC-06] an allow-list, not a deny-list: a link is approved only with owner-declared parameters and plain values', () => {
    const refusedLinks = [
      // a URL or path in a parameter nobody declared, whatever its name
      String.raw`https://portal.fictional.test/verify?r=/\evil.example`,
      'https://portal.fictional.test/verify?r=evil.example',
      'https://portal.fictional.test/verify?r=https://evil.example',
      'https://portal.fictional.test/verify?to=%2F%2Fevil.example',
      // a declared parameter must still carry a plain value, never a URL, a host or a path
      'https://portal.fictional.test/verify?lang=evil.example',
      String.raw`https://portal.fictional.test/verify?lang=/\evil.example`,
      'https://portal.fictional.test/verify?lang=%2F%2Fevil.example',
      'https://portal.fictional.test/verify?lang=https%3A%2F%2Fevil.example',
      'https://portal.fictional.test/verify?lang=',
      'https://portal.fictional.test/verify?lang=en&r=en',
      // a path that is itself a URL or a hop elsewhere
      'https://portal.fictional.test/out/https://evil.example',
      'https://portal.fictional.test/out/https%3A%2F%2Fevil.example',
      'https://portal.fictional.test/out/%2F%2Fevil.example',
      'https://portal.fictional.test//evil.example',
      'https://portal.fictional.test/out//evil.example',
      'https://portal.fictional.test/out/..%2F..%2Fevil',
      'https://portal.fictional.test/out/%252e%252e/evil',
      'https://portal.fictional.test/out;url=https://evil.example',
      String.raw`https://portal.fictional.test/out/\evil.example`,
    ];
    for (const url of refusedLinks) {
      expect(refusal(linkTo(url))).toEqual({ code: 'link_not_permitted', placeholders: ['portal_link'] });
    }
    // a legitimate owner link: an allowed origin, plain path segments, declared parameters with plain values
    for (const url of [
      'https://portal.fictional.test/',
      'https://portal.fictional.test/orders/OBJ-2026-0042/',
      'https://portal.fictional.test/orders/42?tab=details&lang=en',
      'https://portal.fictional.test/cs/objednavky/42?lang=cs',
    ]) {
      expect(rendered(linkTo(url)).text).toContain(new URL(url).href);
    }
    // a dot segment is resolved by URL normalization, and what is shown is the resolved, same-origin path
    expect(rendered(linkTo('https://portal.fictional.test/out/%2e%2e/evil')).text).toContain(
      'https://portal.fictional.test/evil',
    );
    // the declared set is the owner's: with none declared, not even a harmless parameter passes
    expect(
      refusal(
        render({
          linkPolicy: { allowedOrigins: ['https://portal.fictional.test'] },
          values: { portal_link: { kind: 'link', url: 'https://portal.fictional.test/orders/42?tab=details' } },
        }),
      ).code,
    ).toBe('link_not_permitted');
  });

  it('[S17] with no approved origin no link is ever permitted', () => {
    expect(
      refusal(
        render({
          linkPolicy: { allowedOrigins: [] },
          values: { portal_link: { kind: 'link', url: 'https://portal.fictional.test/x' } },
        }),
      ).code,
    ).toBe('link_not_permitted');
  });
});

describe('Secret-bearing values never enter the generic path (L-10, S15, AC-08)', () => {
  const secretTemplate = {
    body: '[FICTIONAL TEST COPY] Your one-time code is {{otp_code}}.\n\nReference {{reference}}',
    optionalPlaceholders: [],
    requiredPlaceholders: ['otp_code', 'reference'],
    subject: '[FICTIONAL TEST COPY] Security code',
  };
  const secretContract: readonly PlaceholderContract[] = [
    { kind: 'owner-rendered', name: 'otp_code' },
    { kind: 'text', name: 'reference' },
  ];
  const secretRender = (values: Record<string, GenericValue>) =>
    renderMessage({ contract: secretContract, language: 'cs', linkPolicy, template: secretTemplate, values });

  it('[S15 AC-08] a value offered for an owner-rendered placeholder is refused and never echoed', () => {
    const result = secretRender({ otp_code: text('482913'), reference: text('R-1') });
    expect(refusal(result)).toEqual({ code: 'secret_value_in_generic_path', placeholders: ['otp_code'] });
    expect(JSON.stringify(result)).not.toContain('482913');
  });

  it('[S15 AC-08] without a value the owner slot stays in text and HTML for the owner to complete, holding no secret', () => {
    const message = rendered(secretRender({ reference: text('R-1') }));
    expect(message.ownerSlots).toEqual(['otp_code']);
    expect(message.text).toContain('{{otp_code}}');
    expect(message.html).toContain('{{otp_code}}');
    expect(htmlToPlainText(message.html)).toBe(message.text);
  });

  it('[S15 AC-08] the generic value type has no secret member: any other kind fails decoding', () => {
    for (const candidate of [
      { kind: 'otp', value: '482913' },
      { kind: 'secret', value: 'x' },
      { kind: 'reset-link', url: 'https://portal.fictional.test/reset?t=1' },
      { kind: 'claim-url', url: 'https://portal.fictional.test/claim?t=1' },
    ]) {
      expect(Schema.is(GenericValueSchema)(candidate)).toBe(false);
    }
    expect(Schema.is(GenericValueSchema)(text('ok'))).toBe(true);
  });

  it('[S15] a refusal carries only placeholder names, never a value', () => {
    const failure = refusal(render({ values: { customer_name: text('a\nb'), order_number: text('SECRET-ORDER') } }));
    expect(JSON.stringify(failure)).not.toMatch(/SECRET-ORDER|a\\nb/u);
  });
});
