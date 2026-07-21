const daysInMonth = (year: number, month: number): number => {
  if (month === 2) {
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return leap ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
};

export const canonicalCalendarDate = (year: number, month: number, day: number): string | null => {
  if (
    year < 1 ||
    year > 9999 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth(year, month)
  ) {
    return null;
  }
  return [year, month, day]
    .map((part, index) => String(part).padStart(index === 0 ? 4 : 2, '0'))
    .join('-');
};

export const isCanonicalCalendarDate = (value: string): boolean => {
  const matched = /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})$/u.exec(value);
  return (
    matched?.groups !== undefined &&
    canonicalCalendarDate(
      Number(matched.groups['year']),
      Number(matched.groups['month']),
      Number(matched.groups['day']),
    ) === value
  );
};
