import { useLocalizedLocation, useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { useNavigate } from '@modern-js/plugin-tanstack/runtime';
import { Select } from '@techsio/ui-kit/molecules/select';
import type { ReactNode } from 'react';
import { Header, StatusBadge } from './vertical-components';

interface ShellFrameProps {
  children: ReactNode;
}

export default function ShellFrame({ children }: ShellFrameProps) {
  const { language, t } = useModernI18n();
  const { alternates } = useLocalizedLocation();
  const navigate = useNavigate();
  const languageItems = [
    { label: `🇬🇧 ${t('shell.language.en')}`, value: 'en' },
    { label: `🇨🇿 ${t('shell.language.cs')}`, value: 'cs' },
  ];

  return (
    <main className="shell:min-h-screen shell:bg-um-canvas shell:px-4 shell:py-5 shell:text-um-foreground shell:sm:px-6 shell:lg:px-12">
      <div className="shell:mx-auto shell:flex shell:min-h-20 shell:max-w-7xl shell:flex-col shell:items-start shell:gap-3 shell:bg-white/90 shell:px-4 shell:py-3 shell:shadow-xl shell:shadow-stone-900/10 shell:sm:px-6 shell:md:flex-row shell:md:flex-wrap shell:md:items-center shell:md:justify-between">
        <Header />
        <div className="shell:flex shell:min-w-0 shell:flex-wrap shell:items-center shell:gap-2 shell:md:ml-auto">
          <div className="shell:w-36">
            <Select
              items={languageItems}
              name="language"
              onValueChange={({ value }) => {
                const target = alternates[value[0] ?? ''];
                if (target !== undefined) {
                  void navigate({ to: target });
                }
              }}
              size="xs"
              value={[language]}
            >
              <Select.Label className="shell:sr-only">{t('shell.language.switcher')}</Select.Label>
              <Select.Control>
                <Select.Trigger aria-label={t('shell.language.switcher')}>
                  <Select.ValueText />
                </Select.Trigger>
              </Select.Control>
              <Select.Positioner>
                <Select.Content>
                  {languageItems.map((item) => (
                    <Select.Item item={item} key={item.value}>
                      <Select.ItemText />
                      <Select.ItemIndicator />
                    </Select.Item>
                  ))}
                </Select.Content>
              </Select.Positioner>
            </Select>
          </div>
          <StatusBadge />
        </div>
      </div>
      {children}
    </main>
  );
}
