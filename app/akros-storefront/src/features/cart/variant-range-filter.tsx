"use client";

import { useState, type FormEvent } from "react";
import { NumericInput } from "@techsio/ui-kit/atoms/numeric-input";
import { Slider } from "@techsio/ui-kit/molecules/slider";
import type {
  NumericRange,
  VariantRangeFilter as FilterDefinition,
} from "@/lib/product-variant-filters";

const formatter = new Intl.NumberFormat("cs-CZ", { maximumFractionDigits: 6 });

export function VariantRangeFilter({
  filter,
  value,
  onChange,
}: {
  filter: FilterDefinition;
  value: NumericRange;
  onChange: (value: NumericRange) => void;
}) {
  // Controlled strings preserve empty/trailing-decimal text and accept both separators.
  const [inputs, setInputs] = useState(() => value.map((number) => formatter.format(number)));
  const [sliderRevision, setSliderRevision] = useState(0);
  const updateEndpoint = (index: 0 | 1, next: number) => {
    if (!Number.isFinite(next) || next < filter.bounds[0] || next > filter.bounds[1]) return;
    if (index === 0 ? next > value[1] : next < value[0]) return;
    onChange(index === 0 ? [next, value[1]] : [value[0], next]);
  };
  const updateInput = (index: 0 | 1, text: string) => {
    const normalized = text.replace(".", ",");
    setInputs((current) =>
      current.map((input, position) => (position === index ? normalized : input)),
    );
    const number = normalized.replace(/\s/g, "").replace(",", ".");
    if (/^\d+(?:\.\d+)?$/.test(number)) updateEndpoint(index, Number(number));
  };
  // The kit's Czech parser rejects a dot before onValueChange can normalize it.
  const validateDecimalInput = (event: FormEvent<HTMLInputElement>) => {
    const data = "data" in event.nativeEvent ? event.nativeEvent.data : null;
    if (typeof data !== "string") return;
    const input = event.currentTarget;
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? start;
    const next = (input.value.slice(0, start) + data + input.value.slice(end)).replace(/\s/g, "");
    if (!/^\d*(?:[.,]\d*)?$/.test(next)) event.preventDefault();
  };

  return (
    <div className="akros-variant-filter-range w-full min-w-0 py-(--dimension-12) md:w-(--akros-variant-filter-measurement-width) md:px-(--dimension-12) md:py-0">
      <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-end gap-(--dimension-8)">
        <NumericInput
          key={`minimum-${sliderRevision}`}
          className="w-(--akros-variant-filter-input-width)"
          locale="cs-CZ"
          min={filter.bounds[0]}
          max={value[1]}
          precision={6}
          step={filter.step}
          value={inputs[0]}
          onValueChange={({ value }) => updateInput(0, value)}
          allowMouseWheel={false}
          size="sm"
        >
          <NumericInput.Control>
            <NumericInput.Input
              aria-label={`Minimum – ${filter.label}`}
              onBeforeInput={validateDecimalInput}
            />
          </NumericInput.Control>
        </NumericInput>
        <Slider
          className="[&>div:first-child]:justify-center [&_label]:whitespace-nowrap [&_label]:text-(length:--akros-variant-filter-label-font-size) [&_label]:leading-(--akros-variant-filter-label-line-height) [&_[data-part=control]]:min-h-(--height-form-control-sm)"
          formatValue={(next) => formatter.format(next)}
          label={filter.label}
          max={filter.bounds[1]}
          min={filter.bounds[0]}
          minStepsBetweenThumbs={0}
          onChange={(next) => {
            if (next[0] !== undefined && next[1] !== undefined) {
              onChange([next[0], next[1]]);
              setInputs(next.map((number) => formatter.format(number)));
              setSliderRevision((revision) => revision + 1);
            }
          }}
          size="sm"
          step={filter.step}
          value={value}
        />
        <NumericInput
          key={`maximum-${sliderRevision}`}
          className="w-(--akros-variant-filter-input-width)"
          locale="cs-CZ"
          min={value[0]}
          max={filter.bounds[1]}
          precision={6}
          step={filter.step}
          value={inputs[1]}
          onValueChange={({ value }) => updateInput(1, value)}
          allowMouseWheel={false}
          size="sm"
        >
          <NumericInput.Control>
            <NumericInput.Input
              aria-label={`Maximum – ${filter.label}`}
              onBeforeInput={validateDecimalInput}
            />
          </NumericInput.Control>
        </NumericInput>
      </div>
    </div>
  );
}
