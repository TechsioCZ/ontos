import { ColorSelect } from '@techsio/ui-kit/molecules/color-select';

export interface SelectOptionAvailableColor {
  readonly color: string;
  readonly label?: string;
}

export interface SelectOptionColorEditorProps {
  readonly availableColors: readonly SelectOptionAvailableColor[];
  readonly currentColor: string;
  readonly onColorChange: (color: string) => void;
  readonly readOnly?: boolean;
}

const OptionColorEditor = ({
  availableColors,
  currentColor,
  onColorChange,
  readOnly = false,
}: SelectOptionColorEditorProps) => (
  <ColorSelect
    colors={availableColors.map((availableColor) => ({
      ...availableColor,
      id: availableColor.color,
      selected: availableColor.color === currentColor,
    }))}
    disabled={readOnly}
    onColorClick={onColorChange}
    selectionMode="single"
  />
);

export const SelectOptionColorEditor = OptionColorEditor;
export const MultiSelectOptionColorEditor = OptionColorEditor;
