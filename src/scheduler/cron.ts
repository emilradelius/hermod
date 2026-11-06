/**
 * Five-field cron expressions, evaluated in an IANA time zone with `Intl` only (no dependencies).
 *
 * Syntax: `minute hour day-of-month month day-of-week`.
 * - minute 0-59, hour 0-23, day-of-month 1-31, month 1-12 or JAN-DEC, day-of-week 0-7 or SUN-SAT (0 and 7 are both
 *   Sunday). Names are case-insensitive.
 * - Each field is a comma-separated list of items: `*`, `n`, `a-b`, `*\/s`, `a-b/s`, or `a/s` (from a to the end of
 *   the field, every s). Ranges do not wrap around, with one convenience: a day-of-week range may end on Sunday
 *   (`FRI-SUN` means Friday, Saturday and Sunday).
 * - Not supported (rejected with a clear error): seconds or year fields, macros such as `@daily`, and the
 *   non-standard `L`, `W`, `#` and `?`.
 *
 * Day rule (as in Vixie cron and cronie): a day-of-month or day-of-week field that starts with `*` (`*` or `*\/n`) is
 * unrestricted. When both day fields are restricted, a day matches when EITHER matches (`0 9 1,15 * MON` runs on the
 * 1st, the 15th and every Monday). Otherwise both must match (`0 9 * * MON` runs only on Mondays, and
 * `0 9 *\/2 * MON` only on odd-numbered days that are Mondays).
 *
 * Daylight saving time. Cron fields describe wall-clock times in the job's zone:
 * - A wall-clock time that does not exist (the spring-forward gap) is skipped. In Europe/Stockholm on 2026-03-29 the
 *   clocks jump from 02:00 to 03:00, so a daily 02:30 job does not run that day; its next run is 02:30 the next day.
 * - A wall-clock time that happens twice (the fall-back overlap) runs once, at its first occurrence. In
 *   Europe/Stockholm on 2026-10-25 the clocks go back from 03:00 to 02:00, so a daily 02:30 job runs at 02:30 CEST
 *   (00:30 UTC) and not again at 02:30 CET. Frequent jobs (`*\/5 * * * *`) therefore pause during the repeated hour
 *   instead of running each wall-clock minute twice.
 */

/** A parsed cron expression. Value lists are sorted and unique. */
export interface CronSchedule {
  /** The expression with its fields joined by single spaces. */
  readonly expression: string;
  readonly minutes: readonly number[];
  readonly hours: readonly number[];
  readonly daysOfMonth: readonly number[];
  readonly months: readonly number[];
  /** 0-6, Sunday = 0 (a 7 in the expression is folded into 0). */
  readonly daysOfWeek: readonly number[];
  /** The day-of-month field starts with "*" (unrestricted for the day rule). */
  readonly dayOfMonthStar: boolean;
  /** The day-of-week field starts with "*" (unrestricted for the day rule). */
  readonly dayOfWeekStar: boolean;
}

/** Thrown for an expression that cannot be parsed or can never run. */
export class CronError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CronError";
  }
}

const MAX_EXPRESSION_LENGTH = 1024;
/** How far ahead nextRun looks before giving up. The rarest valid schedule (29 February on one weekday) recurs
 * within 40 years. */
const SEARCH_YEARS = 100;
const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
/** The longest each month can be (February in a leap year). */
const MAX_DAYS_IN_MONTH = [0, 31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

interface FieldSpec {
  readonly label: string;
  readonly min: number;
  readonly max: number;
  readonly names?: ReadonlyMap<string, number>;
  readonly nameHint?: string;
}

const MONTH_NAMES = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const DAY_NAMES = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

const MINUTE: FieldSpec = { label: "minute", min: 0, max: 59 };
const HOUR: FieldSpec = { label: "hour", min: 0, max: 23 };
const DAY_OF_MONTH: FieldSpec = { label: "day-of-month", min: 1, max: 31 };
const MONTH: FieldSpec = {
  label: "month",
  min: 1,
  max: 12,
  names: new Map(MONTH_NAMES.map((name, i) => [name, i + 1])),
  nameHint: "JAN-DEC",
};
const DAY_OF_WEEK: FieldSpec = {
  label: "day-of-week",
  min: 0,
  max: 7,
  names: new Map(DAY_NAMES.map((name, i) => [name, i])),
  nameHint: "SUN-SAT",
};

// ─── Parsing ────────────────────────────────────────────────────────────────────────────────────────────────

/** A problem inside one field; parseCron adds the expression to the message. */
class FieldError extends Error {}

/** Parses a five-field cron expression. Throws a CronError that says what is wrong. */
export function parseCron(expression: string): CronSchedule {
  if (typeof expression !== "string") {
    throw new CronError(`Invalid cron expression: expected a string, got ${describeType(expression)}.`);
  }
  if (expression.length > MAX_EXPRESSION_LENGTH) {
    throw new CronError(`Invalid cron expression: it is longer than ${MAX_EXPRESSION_LENGTH} characters.`);
  }
  const trimmed = expression.trim();
  const fail = (reason: string): CronError => new CronError(`Invalid cron expression ${quote(trimmed)}: ${reason}.`);
  if (trimmed === "") throw fail("it is empty; use five fields: minute hour day-of-month month day-of-week");
  if (trimmed.startsWith("@")) {
    throw fail('macros such as @daily are not supported; use five fields, e.g. "0 0 * * *" for daily at midnight');
  }
  const fields = trimmed.split(/\s+/);
  if (fields.length !== 5) {
    throw fail(`expected 5 fields (minute hour day-of-month month day-of-week), got ${fields.length}`);
  }
  const [minute = "", hour = "", dayOfMonth = "", month = "", dayOfWeek = ""] = fields;
  try {
    const schedule: CronSchedule = {
      expression: fields.join(" "),
      minutes: parseField(minute, MINUTE),
      hours: parseField(hour, HOUR),
      daysOfMonth: parseField(dayOfMonth, DAY_OF_MONTH),
      months: parseField(month, MONTH),
      daysOfWeek: foldSunday(parseField(dayOfWeek, DAY_OF_WEEK)),
      dayOfMonthStar: dayOfMonth.startsWith("*"),
      dayOfWeekStar: dayOfWeek.startsWith("*"),
    };
    checkCanRun(schedule);
    return schedule;
  } catch (err) {
    if (err instanceof FieldError) throw fail(err.message);
    throw err;
  }
}

function parseField(text: string, spec: FieldSpec): number[] {
  const values = new Set<number>();
  for (const item of text.split(",")) {
    if (item === "") throw new FieldError(`the ${spec.label} field ${quote(text)} has an empty list item`);
    for (const value of parseItem(item, spec)) values.add(value);
  }
  return [...values].sort((a, b) => a - b);
}

function parseItem(item: string, spec: FieldSpec): number[] {
  const parts = item.split("/");
  if (parts.length > 2) throw new FieldError(`${spec.label} ${quote(item)} has more than one "/"`);
  const [rangeText = "", stepText] = parts;
  const step = stepText === undefined ? 1 : parseStep(stepText, spec);
  const [low, high] = parseRange(rangeText, spec, stepText !== undefined);
  const values: number[] = [];
  for (let value = low; value <= high; value += step) values.push(value);
  return values;
}

function parseRange(text: string, spec: FieldSpec, hasStep: boolean): [number, number] {
  if (text === "*") return [spec.min, spec.max];
  const parts = text.split("-");
  if (parts.length > 2) throw new FieldError(`${spec.label} ${quote(text)} is not a valid range`);
  const low = parseValue(parts[0] ?? "", spec, text);
  if (parts.length === 1) return hasStep ? [low, spec.max] : [low, low];
  let high = parseValue(parts[1] ?? "", spec, text);
  // "FRI-SUN": a day-of-week range may end on Sunday (0), which then means 7.
  if (spec === DAY_OF_WEEK && high === 0 && low > 0) high = 7;
  if (low > high) {
    throw new FieldError(`${spec.label} range ${quote(text)} runs backwards; ranges do not wrap around`);
  }
  return [low, high];
}

function parseValue(text: string, spec: FieldSpec, context: string): number {
  if (text === "") throw new FieldError(`${spec.label} ${quote(context)} is missing a value`);
  if (/^[0-9]+$/.test(text)) {
    const value = Number(text);
    if (value < spec.min || value > spec.max) {
      throw new FieldError(`${spec.label} ${shorten(text)} is out of range ${spec.min}-${spec.max}`);
    }
    return value;
  }
  const named = spec.names?.get(text.toUpperCase());
  if (named !== undefined) return named;
  if (spec.names) throw new FieldError(`${spec.label} ${quote(text)} is not a number or a name (${spec.nameHint})`);
  throw new FieldError(`${spec.label} ${quote(text)} is not a number`);
}

function parseStep(text: string, spec: FieldSpec): number {
  const step = /^[0-9]+$/.test(text) ? Number(text) : NaN;
  if (!(step >= 1 && step <= spec.max)) {
    throw new FieldError(`${spec.label} step ${quote(text)} must be a whole number from 1 to ${spec.max}`);
  }
  return step;
}

function foldSunday(daysOfWeek: number[]): number[] {
  return [...new Set(daysOfWeek.map((day) => (day === 7 ? 0 : day)))].sort((a, b) => a - b);
}

/** Rejects expressions that can never run, e.g. "0 0 30 2 *" (30 February). */
function checkCanRun(schedule: CronSchedule): void {
  // Only when the day of month must match (the day-of-week field is unrestricted) can the days be impossible: a
  // restricted day of week matches in every month, and a day-of-month field starting with "*" contains the 1st.
  if (schedule.dayOfMonthStar || !schedule.dayOfWeekStar) return;
  const possible = schedule.months.some((month) =>
    schedule.daysOfMonth.some((day) => day <= (MAX_DAYS_IN_MONTH[month] ?? 0)),
  );
  if (!possible) {
    const days = schedule.daysOfMonth.join(", ");
    throw new FieldError(`it never runs, because none of its months has day ${days}`);
  }
}

// ─── Time zones ─────────────────────────────────────────────────────────────────────────────────────────────

/** Formatters are costly to build, so they are cached per zone name (bounded: names are case-insensitive, so a
 * hostile caller could otherwise grow the cache with spellings of one zone). */
const formatters = new Map<string, Intl.DateTimeFormat>();
const MAX_CACHED_FORMATTERS = 256;

/** True for a time zone Intl knows, e.g. "Europe/Stockholm" or "UTC". */
export function isValidTimeZone(timeZone: unknown): boolean {
  try {
    formatterFor(timeZone);
    return true;
  } catch {
    return false;
  }
}

function formatterFor(timeZone: unknown): Intl.DateTimeFormat {
  if (typeof timeZone !== "string" || timeZone.trim() === "" || timeZone.length > 100) {
    // Never fall back to the host's zone: an empty or missing zone is an error.
    throw new RangeError(`Invalid time zone ${describeZone(timeZone)}: use an IANA name such as "Europe/Stockholm".`);
  }
  const cached = formatters.get(timeZone);
  if (cached) return cached;
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat("en-US-u-ca-gregory-nu-latn", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
  } catch {
    throw new RangeError(`Unknown time zone ${quote(timeZone)}: use an IANA name such as "Europe/Stockholm".`);
  }
  if (formatters.size >= MAX_CACHED_FORMATTERS) formatters.clear();
  formatters.set(timeZone, formatter);
  return formatter;
}

interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** The wall-clock reading of an instant in the formatter's zone. */
function wallClockAt(formatter: Intl.DateTimeFormat, instantMs: number): WallClock {
  const clock: WallClock = { year: NaN, month: NaN, day: NaN, hour: NaN, minute: NaN, second: NaN };
  for (const part of formatter.formatToParts(instantMs)) {
    switch (part.type) {
      case "year":
      case "month":
      case "day":
      case "hour":
      case "minute":
      case "second":
        clock[part.type] = Number(part.value);
        break;
      default:
        break;
    }
  }
  if (clock.hour === 24) clock.hour = 0; // some engines print midnight as 24 even with h23
  return clock;
}

/** The zone's UTC offset (ms) at an instant: wall clock minus UTC. */
function offsetAt(formatter: Intl.DateTimeFormat, instantMs: number): number {
  const c = wallClockAt(formatter, instantMs);
  return Date.UTC(c.year, c.month - 1, c.day, c.hour, c.minute, c.second) - Math.floor(instantMs / 1000) * 1000;
}

/**
 * The instants at which the zone's clocks show a wall-clock time (encoded as if it were UTC): none in a
 * spring-forward gap, two in a fall-back overlap, otherwise one. Sorted. The offsets in effect a day before and
 * after are the only candidates (the same approach as the Temporal polyfill).
 */
function instantsFor(formatter: Intl.DateTimeFormat, localMs: number): number[] {
  const offsets = new Set([
    offsetAt(formatter, localMs - DAY_MS),
    offsetAt(formatter, localMs),
    offsetAt(formatter, localMs + DAY_MS),
  ]);
  const instants = new Set<number>();
  for (const offset of offsets) {
    const instant = localMs - offset;
    if (offsetAt(formatter, instant) === offset) instants.add(instant);
  }
  return [...instants].sort((a, b) => a - b);
}

// ─── Next run ───────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The first time strictly after `after` at which the schedule runs, in `timeZone` (see the DST rules at the top of
 * this file). Seconds are ignored: runs are on whole minutes. Throws for an invalid expression or time zone.
 */
export function nextRun(expression: string | CronSchedule, after: Date, timeZone: string): Date {
  const schedule = typeof expression === "string" ? parseCron(expression) : expression;
  const formatter = formatterFor(timeZone);
  const afterMs = checkDate(after);
  const lookup = compile(schedule);
  const start = wallClockAt(formatter, afterMs);
  const limitMs = Date.UTC(start.year + SEARCH_YEARS, 0, 1);
  let cursor = Date.UTC(start.year, start.month - 1, start.day, start.hour, start.minute) + MINUTE_MS;
  for (;;) {
    const local = nextMatch(lookup, cursor, limitMs);
    if (local === null) {
      throw new CronError(
        `Cron expression ${quote(schedule.expression)} has no run time in ${timeZone} within ${SEARCH_YEARS} ` +
          `years after ${after.toISOString()}.`,
      );
    }
    // Skip a time in a gap (no instants); in an overlap, only the first occurrence counts.
    const first = instantsFor(formatter, local)[0];
    if (first !== undefined && first > afterMs) return new Date(first);
    cursor = local + MINUTE_MS;
  }
}

interface Lookup {
  minute: boolean[];
  hour: boolean[];
  dayOfMonth: boolean[];
  month: boolean[];
  dayOfWeek: boolean[];
  /** Both day fields restricted: a day matches when either matches. */
  eitherDay: boolean;
}

function compile(schedule: CronSchedule): Lookup {
  const table = (values: readonly number[], size: number): boolean[] => {
    const out = new Array<boolean>(size).fill(false);
    for (const value of values) out[value] = true;
    return out;
  };
  return {
    minute: table(schedule.minutes, 60),
    hour: table(schedule.hours, 24),
    dayOfMonth: table(schedule.daysOfMonth, 32),
    month: table(schedule.months, 13),
    dayOfWeek: table(schedule.daysOfWeek, 7),
    eitherDay: !schedule.dayOfMonthStar && !schedule.dayOfWeekStar,
  };
}

/**
 * The first wall-clock minute at or after `fromMs` that matches, or null past `limitMs`. Wall-clock times are
 * encoded as UTC milliseconds, so this is plain calendar arithmetic with no time zone.
 */
function nextMatch(lookup: Lookup, fromMs: number, limitMs: number): number | null {
  let t = fromMs;
  while (t < limitMs) {
    const d = new Date(t);
    const year = d.getUTCFullYear();
    const month = d.getUTCMonth();
    const day = d.getUTCDate();
    const hour = d.getUTCHours();
    if (!lookup.month[month + 1]) {
      t = Date.UTC(year, month + 1, 1);
    } else if (!dayMatches(lookup, day, d.getUTCDay())) {
      t = Date.UTC(year, month, day + 1);
    } else if (!lookup.hour[hour]) {
      t = Date.UTC(year, month, day, hour + 1);
    } else if (!lookup.minute[d.getUTCMinutes()]) {
      t += MINUTE_MS;
    } else {
      return t;
    }
  }
  return null;
}

function dayMatches(lookup: Lookup, dayOfMonth: number, dayOfWeek: number): boolean {
  const domOk = lookup.dayOfMonth[dayOfMonth] === true;
  const dowOk = lookup.dayOfWeek[dayOfWeek] === true;
  return lookup.eitherDay ? domOk || dowOk : domOk && dowOk;
}

function checkDate(after: Date): number {
  const ms = after instanceof Date ? after.getTime() : NaN;
  if (!Number.isFinite(ms)) throw new TypeError("nextRun: 'after' must be a valid Date.");
  const year = after.getUTCFullYear();
  if (year < 1970 || year > 9999) throw new RangeError("nextRun: 'after' must be between the years 1970 and 9999.");
  return ms;
}

// ─── Messages ───────────────────────────────────────────────────────────────────────────────────────────────

/** JSON-quoted (control characters escaped) and shortened, so hostile input stays readable in an error. */
function quote(text: string): string {
  return JSON.stringify(shorten(text));
}

function shorten(text: string): string {
  return text.length > 60 ? `${text.slice(0, 57)}...` : text;
}

function describeType(value: unknown): string {
  return value === null ? "null" : typeof value;
}

function describeZone(value: unknown): string {
  return typeof value === "string" ? quote(value) : `(${describeType(value)})`;
}
