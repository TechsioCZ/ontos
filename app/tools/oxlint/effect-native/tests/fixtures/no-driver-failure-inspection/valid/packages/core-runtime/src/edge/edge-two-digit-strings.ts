const MONTHS = ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12'];

export const isAugust = (month: string): boolean => month === '08' && MONTHS.includes(month);

export const padded = (hour: number): string => String(hour).padStart(2, '0');

// A5 does not forbid native date-prefix operations just because their literals have two digits.
export const monthPrefix = (date: string) => MONTHS.some((month) => date.startsWith(month));
export const augustPrefix = (date: string) => date.startsWith('08') || date.slice(0, 2) === '08';
