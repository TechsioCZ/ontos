"use client";

import { useMemo, useState, type FormEvent, type KeyboardEvent } from "react";
import { NumericInput } from "@techsio/ui-kit/atoms/numeric-input";
import { Slider } from "@techsio/ui-kit/molecules/slider";
import type {
  NumericRange,
  VariantRangeFilter as FilterDefinition,
} from "@/lib/product-variant-filters";
import { useDictionary } from "@/ontos/market-context";

// The kit's numeric inputs parse Czech decimals (comma) in every market; a typed dot is normalized below.
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
  const cs = useDictionary();
  const label = filter.dimension
    ? cs.variants.dimensionLabel(cs.variants.dimensions[filter.dimension], filter.unit ?? "mm")
    : filter.label;
  // Controlled strings preserve empty/trailing-decimal text and accept both separators.
  const [inputs, setInputs] = useState(() => value.map((number) => formatter.format(number)));
  const [sliderRevision, setSliderRevision] = useState(0);
  const stops = useMemo(
    () => [...new Set(filter.values.values())].sort((left, right) => left - right),
    [filter.values],
  );
  const updateSlider = (next: NumericRange) => {
    onChange(next);
    setInputs(next.map((number) => formatter.format(number)));
    setSliderRevision((revision) => revision + 1);
  };
  const snap = (number: number, index: 0 | 1) =>
    stops
      .filter((stop) => (index === 0 ? stop <= value[1] : stop >= value[0]))
      .reduce((closest, stop) =>
        Math.abs(stop - number) < Math.abs(closest - number) ? stop : closest,
      );
  // Keep the real measurement scale (including ARIA values). The kit supports a fixed
  // step, so keyboard arrows must move to the next existing dimension across uneven gaps.
  const stepSlider = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!(event.target instanceof HTMLElement) || event.target.getAttribute("role") !== "slider")
      return;
    const forward = event.key === "ArrowRight" || event.key === "ArrowUp";
    const backward = event.key === "ArrowLeft" || event.key === "ArrowDown";
    if (!forward && !backward) return;
    const index = event.target.getAttribute("data-index") === "0" ? 0 : 1;
    const next = forward
      ? stops.find((stop) => stop > value[index])
      : stops.findLast((stop) => stop < value[index]);
    event.preventDefault();
    event.stopPropagation();
    if (next === undefined || (index === 0 ? next > value[1] : next < value[0])) return;
    updateSlider(index === 0 ? [next, value[1]] : [value[0], next]);
  };
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
    <div
      className="sf-variant-filter-range w-full min-w-0 py-(--dimension-12) md:w-(--sf-variant-filter-measurement-width) md:px-(--dimension-12) md:py-0"
      onKeyDownCapture={stepSlider}
    >
      <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-end gap-(--dimension-8)">
        <NumericInput
          key={`minimum-${sliderRevision}`}
          className="w-(--sf-variant-filter-input-width)"
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
              aria-label={`${cs.filters.minimum} – ${label}`}
              onBeforeInput={validateDecimalInput}
            />
          </NumericInput.Control>
        </NumericInput>
        <Slider
          aria-label={[`${cs.filters.minimum} – ${label}`, `${cs.filters.maximum} – ${label}`]}
          className="[&>div:first-child]:justify-center [&_label]:whitespace-nowrap [&_label]:text-(length:--sf-variant-filter-label-font-size) [&_label]:leading-(--sf-variant-filter-label-line-height) [&_[data-part=control]]:min-h-(--height-form-control-sm)"
          formatValue={(next) => formatter.format(next)}
          label={label}
          max={filter.bounds[1]}
          min={filter.bounds[0]}
          minStepsBetweenThumbs={0}
          onChange={(next) => {
            if (next[0] !== undefined && next[1] !== undefined) {
              updateSlider([
                next[0] === value[0] ? value[0] : snap(next[0], 0),
                next[1] === value[1] ? value[1] : snap(next[1], 1),
              ]);
            }
          }}
          size="sm"
          step={filter.step}
          value={value}
        />
        <NumericInput
          key={`maximum-${sliderRevision}`}
          className="w-(--sf-variant-filter-input-width)"
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
              aria-label={`${cs.filters.maximum} – ${label}`}
              onBeforeInput={validateDecimalInput}
            />
          </NumericInput.Control>
        </NumericInput>
      </div>
    </div>
  );
}
