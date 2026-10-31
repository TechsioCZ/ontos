"use client";
import type { ReactNode } from "react";
import { Select } from "@techsio/ui-kit/molecules/select";

export function CheckoutSelect({
  id,
  label,
  value,
  items,
  onChange,
  error,
  indicator,
}: {
  id: string;
  label: string;
  value: string;
  items: { value: string; label: string }[];
  onChange: (value: string) => void;
  error?: string;
  indicator?: ReactNode;
}) {
  return (
    <Select
      id={id}
      items={items}
      value={value ? [value] : []}
      onValueChange={({ value: next }) => onChange(next[0] ?? "")}
      size="sm"
      required
      validateStatus={error ? "error" : "default"}
    >
      <Select.Label>{label}</Select.Label>
      <Select.Control>
        <Select.Trigger
          aria-describedby={error ? `${id}-error` : undefined}
          className={indicator ? "[&>.token-icon-select-indicator]:hidden" : undefined}
        >
          <Select.ValueText placeholder="Vyberte možnost" />
          {indicator}
        </Select.Trigger>
      </Select.Control>
      <Select.Positioner>
        <Select.Content>
          {items.map((item) => (
            <Select.Item key={item.value} item={item}>
              <Select.ItemText>{item.label}</Select.ItemText>
              <Select.ItemIndicator />
            </Select.Item>
          ))}
        </Select.Content>
      </Select.Positioner>
      {error && (
        <Select.StatusText id={`${id}-error`} status="error">
          {error}
        </Select.StatusText>
      )}
    </Select>
  );
}
