import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Select } from '@techsio/ui-kit/molecules/select';

import type { WhySubjectOptions } from './why-view-model.ts';

export const WhySubjectPicker = ({
  onChange,
  onMore,
  options,
  pending,
  value,
}: {
  readonly onChange: (value: string) => void;
  readonly onMore?: (() => void) | undefined;
  readonly options: WhySubjectOptions;
  readonly pending: boolean;
  readonly value: string;
}) => {
  const { t } = useModernI18n();
  if (options.state === 'hidden') {
    return null;
  }
  if (options.state === 'unavailable') {
    return (
      <div className="shell:grid shell:gap-2">
        <StatusText aria-live="polite" status="default">
          {t('shell.accessAdmin.why.subjectPickerUnavailable')}
        </StatusText>
        <Button disabled={pending || onMore === undefined} onClick={onMore} type="button" variant="secondary">
          {t('shell.accessAdmin.common.retry')}
        </Button>
      </div>
    );
  }
  const items = [{ label: t('shell.accessAdmin.why.currentPersonChoice'), value: '' }, ...options.people];
  return (
    <div className="shell:grid shell:gap-2">
      <Select
        disabled={pending}
        items={items}
        name="subject"
        onValueChange={({ value: values }) => {
          const [selected] = values;
          if (selected !== undefined && items.some((item) => item.value === selected)) {
            onChange(selected);
          }
        }}
        value={[value]}
      >
        <Select.Label>{t('shell.accessAdmin.why.subjectPickerLabel')}</Select.Label>
        <Select.Control>
          <Select.Trigger aria-label={t('shell.accessAdmin.why.subjectPickerLabel')}>
            <Select.ValueText />
          </Select.Trigger>
        </Select.Control>
        <Select.Positioner>
          <Select.Content>
            {items.map((item) => (
              <Select.Item item={item} key={item.value}>
                <Select.ItemText />
                <Select.ItemIndicator />
              </Select.Item>
            ))}
          </Select.Content>
        </Select.Positioner>
      </Select>
      {options.nextCursor === null ? null : (
        <Button disabled={pending || onMore === undefined} onClick={onMore} type="button" variant="secondary">
          {t('shell.accessAdmin.why.morePeople')}
        </Button>
      )}
    </div>
  );
};
