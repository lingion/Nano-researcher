export type DateWindow = {
  start: string | Date;
  end: string | Date;
};

export type DateWindowStatus = 'in_window' | 'out_of_window' | 'date_unknown';

export type DateClassification = {
  status: DateWindowStatus;
  date?: string;
};

const ISO_DATE = /\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b/g;
const CHINESE_DATE = /(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日?/g;

function asDay(value: string | Date): number | undefined {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function calendarDay(year: string, month: string, day: string): string | undefined {
  const candidate = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  const parsed = new Date(`${candidate}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.getUTCFullYear() !== Number(year) || parsed.getUTCMonth() + 1 !== Number(month) || parsed.getUTCDate() !== Number(day)) return undefined;
  return candidate;
}

function extractDates(text: string): string[] {
  const dates: string[] = [];
  for (const match of text.matchAll(ISO_DATE)) {
    const date = calendarDay(match[1], match[2], match[3]);
    if (date) dates.push(date);
  }
  for (const match of text.matchAll(CHINESE_DATE)) {
    const date = calendarDay(match[1], match[2], match[3]);
    if (date) dates.push(date);
  }
  return dates;
}

/** Classify an explicitly stated ISO or Chinese calendar date against an inclusive window. */
export function classifyDate(text: string, window: DateWindow): DateClassification {
  const start = asDay(window.start);
  const end = asDay(window.end);
  if (start === undefined || end === undefined || start > end) {
    throw new RangeError('DateWindow must contain valid, ordered dates');
  }
  const date = extractDates(text).sort().at(-1);
  if (!date) return { status: 'date_unknown' };
  const day = asDay(date)!;
  return { date, status: day >= start && day <= end ? 'in_window' : 'out_of_window' };
}

export function extractExplicitDates(text: string): string[] {
  return extractDates(text);
}
