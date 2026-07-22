// @effect-diagnostics asyncFunction:off
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { FormCheckbox } from '@techsio/ui-kit/molecules/form-checkbox';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { Select } from '@techsio/ui-kit/molecules/select';
import { toaster } from '@techsio/ui-kit/molecules/toast';
import { useState } from 'react';

export const creatableTaskPropertyDatatypes = [
  'checkbox',
  'date',
  'date_range',
  'email',
  'number',
  'phone',
  'text',
  'url',
  'created_time',
  'created_by',
  'last_edited_time',
  'last_edited_by',
] as const;

export type CreatableTaskPropertyDatatype = (typeof creatableTaskPropertyDatatypes)[number];

export interface TaskPropertyDefinitionDraft {
  readonly datatype: CreatableTaskPropertyDatatype;
  readonly mandatory: boolean;
  readonly name: string;
}

interface TaskPropertyDefinitionFormProps {
  readonly onCreate: (draft: TaskPropertyDefinitionDraft) => Promise<void>;
}

const isCreatableTaskPropertyDatatype = (value: string): value is CreatableTaskPropertyDatatype =>
  creatableTaskPropertyDatatypes.some((datatype) => datatype === value);

export const TaskPropertyDefinitionForm = ({ onCreate }: TaskPropertyDefinitionFormProps) => {
  const { t } = useModernI18n();
  const [datatype, setDatatype] = useState<CreatableTaskPropertyDatatype>();
  const [mandatory, setMandatory] = useState(false);
  const [name, setName] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const items = creatableTaskPropertyDatatypes.map((value) => ({
    label: t(`ticketing.propertyDefinition.types.${value}`),
    value,
  }));

  const handleSubmit = async () => {
    if (datatype === undefined || name.trim().length === 0) {
      return;
    }

    setIsCreating(true);
    try {
      await onCreate({ datatype, mandatory, name: name.trim() });
      setMandatory(false);
      setName('');
    } catch (error) {
      toaster.create({
        description:
          error instanceof Error
            ? error.message
            : t('ticketing.propertyDefinition.createFailedDescription'),
        title: t('ticketing.propertyDefinition.createFailedTitle'),
        type: 'error',
      });
    } finally {
      setIsCreating(false);
    }
  };

  return (
    <section aria-labelledby="task-property-definition-form-title">
      <h2
        className="ticketing:text-xl ticketing:font-bold"
        id="task-property-definition-form-title"
      >
        {t('ticketing.propertyDefinition.heading')}
      </h2>
      <form
        className="ticketing:mt-4 ticketing:grid ticketing:gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void handleSubmit();
        }}
      >
        <Select
          disabled={isCreating}
          items={items}
          name="task-property-datatype"
          onValueChange={({ value }) => {
            const selected = value.at(0);
            if (selected !== undefined && isCreatableTaskPropertyDatatype(selected)) {
              setDatatype(selected);
            }
          }}
          value={datatype === undefined ? [] : [datatype]}
        >
          <Select.Label>{t('ticketing.propertyDefinition.typeLabel')}</Select.Label>
          <Select.Control>
            <Select.Trigger>
              <Select.ValueText placeholder={t('ticketing.propertyDefinition.typePlaceholder')} />
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
        <FormInput
          disabled={isCreating}
          id="task-property-name"
          label={t('ticketing.propertyDefinition.nameLabel')}
          name="task-property-name"
          onChange={(event) => setName(event.currentTarget.value)}
          value={name}
        />
        <FormCheckbox
          checked={mandatory}
          disabled={isCreating}
          helpText={t('ticketing.propertyDefinition.mandatoryHelp')}
          label={t('ticketing.propertyDefinition.mandatoryLabel')}
          name="task-property-mandatory"
          onCheckedChange={setMandatory}
        />
        <div>
          <Button
            disabled={datatype === undefined || name.trim().length === 0}
            isLoading={isCreating}
            loadingText={t('ticketing.propertyDefinition.creating')}
            type="submit"
            variant="secondary"
          >
            {t('ticketing.propertyDefinition.create')}
          </Button>
        </div>
      </form>
    </section>
  );
};
