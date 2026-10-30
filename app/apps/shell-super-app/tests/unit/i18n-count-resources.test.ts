import { Effect } from 'effect';
import { expect, it } from 'effect-rstest';
import { createInstance } from 'i18next';

import cs from '../../locales/cs/shell.json';
import en from '../../locales/en/shell.json';

const prefix = 'shell.agents';
const operatorNames = 'QA One, QA Two';
const agentLabel = 'QA Agent';
const cases = [
  {
    language: 'cs',
    messages: [
      { key: 'connections.operators.revoked', text: 'Odpojená připojení: {{count}}' },
      {
        key: 'connections.operators.confirmDescription',
        text: 'Agenta mají připojeného lidé, které odebíráte: {{names}}. Po uložení se tato připojení ({{count}}) hned odpojí.',
      },
      { key: 'section.toast.revoked', text: 'Odpojená připojení: {{count}}' },
      {
        key: 'section.audit.operatorsRevoked',
        text: 'změnil(a), kdo smí připojit agenta {{target}}, a tím odpojil(a) jeho připojení: {{count}}',
      },
    ],
  },
  {
    language: 'en',
    messages: [
      { key: 'connections.operators.revoked', text: 'Disconnected connections: {{count}}' },
      {
        key: 'connections.operators.confirmDescription',
        text: 'People you are removing have the agent connected: {{names}}. Saving disconnects these connections ({{count}}) at once.',
      },
      { key: 'section.toast.revoked', text: 'Revoked connections: {{count}}' },
      {
        key: 'section.audit.operatorsRevoked',
        text: 'changed who may connect agent {{target}} and so disconnected its connections: {{count}}',
      },
    ],
  },
];

for (const { language, messages } of cases) {
  it.effect(`preserves ${language} connection and audit copy across native plural categories`, () =>
    Effect.gen(function* connectionCountTranslations() {
      const i18n = createInstance();
      yield* Effect.promise(() =>
        i18n.init({
          defaultNS: 'shell',
          fallbackLng: false,
          initAsync: false,
          lng: language,
          ns: ['shell'],
          resources: { cs: { shell: cs }, en: { shell: en } },
        }),
      );
      for (const count of [0, 1, 2, 4, 5, 11, 1.5]) {
        for (const { key, text } of messages) {
          expect(i18n.t(`${prefix}.${key}`, { count, names: operatorNames, target: agentLabel })).toBe(
            text
              .replaceAll('{{count}}', String(count))
              .replaceAll('{{names}}', operatorNames)
              .replaceAll('{{target}}', agentLabel),
          );
        }
      }
    }),
  );
}
