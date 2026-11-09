import { describe, expect, it } from "vitest";
import { CronError, isValidTimeZone, nextRun, parseCron } from "../../../src/scheduler/cron.js";
import type { CronSchedule } from "../../../src/scheduler/cron.js";

/** The next `count` run times after `fromIso`, as ISO strings. */
function runs(expression: string, fromIso: string, timeZone: string, count: number): string[] {
  const out: string[] = [];
  let at = new Date(fromIso);
  for (let i = 0; i < count; i++) {
    at = nextRun(expression, at, timeZone);
    out.push(at.toISOString());
  }
  return out;
}

/** All run times in (fromIso, toIso]. */
function runsUntil(expression: string, fromIso: string, toIso: string, timeZone: string): string[] {
  const out: string[] = [];
  const end = new Date(toIso).getTime();
  let at = new Date(fromIso);
  for (;;) {
    at = nextRun(expression, at, timeZone);
    if (at.getTime() > end) return out;
    out.push(at.toISOString());
  }
}

const z = (iso: string): string => new Date(iso).toISOString();

describe("parseCron", () => {
  it("parses lists, ranges, steps and wildcards", () => {
    const s = parseCron("1,2,3-5,*/30 */6 1-10/3 * *");
    expect(s.minutes).toEqual([0, 1, 2, 3, 4, 5, 30]);
    expect(s.hours).toEqual([0, 6, 12, 18]);
    expect(s.daysOfMonth).toEqual([1, 4, 7, 10]);
    expect(s.months).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(s.daysOfWeek).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(s.dayOfMonthStar).toBe(false);
    expect(s.dayOfWeekStar).toBe(true);
  });

  it("treats a/s as from a to the end of the field, every s", () => {
    expect(parseCron("5/15 * * * *").minutes).toEqual([5, 20, 35, 50]);
    expect(parseCron("10-20/5 * * * *").minutes).toEqual([10, 15, 20]);
  });

  it("accepts month and weekday names in any case, and 7 as Sunday", () => {
    expect(parseCron("0 9 1 JAN,jul *").months).toEqual([1, 7]);
    expect(parseCron("0 9 * * MON-FRI").daysOfWeek).toEqual([1, 2, 3, 4, 5]);
    expect(parseCron("0 9 * * mon,Wed,FRI").daysOfWeek).toEqual([1, 3, 5]);
    for (const sunday of ["0", "7", "SUN", "sun", "0,7"]) {
      expect(parseCron(`0 0 * * ${sunday}`).daysOfWeek).toEqual([0]);
    }
    expect(parseCron("0 0 * * 5-7").daysOfWeek).toEqual([0, 5, 6]);
    expect(parseCron("0 0 * * FRI-SUN").daysOfWeek).toEqual([0, 5, 6]);
    expect(parseCron("0 0 * * */7").daysOfWeek).toEqual([0]);
  });

  it("normalises whitespace and keeps the expression", () => {
    expect(parseCron("  0\t9  *  * 1-5 ").expression).toBe("0 9 * * 1-5");
  });

  it("marks day fields that start with * as unrestricted", () => {
    expect(parseCron("0 0 */2 * MON")).toMatchObject({ dayOfMonthStar: true, dayOfWeekStar: false });
    expect(parseCron("0 0 1 * *")).toMatchObject({ dayOfMonthStar: false, dayOfWeekStar: true });
  });

  it("accepts a 30th or 31st in months that have one, and 29 February", () => {
    expect(() => parseCron("0 0 31 1-12 *")).not.toThrow();
    expect(() => parseCron("0 0 29 2 *")).not.toThrow();
    // Both day fields restricted: Mondays in February still match, so this can run.
    expect(() => parseCron("0 0 31 2 MON")).not.toThrow();
  });

  const invalid: Array<[string, RegExp]> = [
    ["", /it is empty/],
    ["   ", /it is empty/],
    ["* * * *", /expected 5 fields \(minute hour day-of-month month day-of-week\), got 4/],
    ["0 * * * * *", /expected 5 fields .*got 6/],
    ["@daily", /macros such as @daily are not supported/],
    ["60 * * * *", /minute 60 is out of range 0-59/],
    ["* 24 * * *", /hour 24 is out of range 0-23/],
    ["* * 0 * *", /day-of-month 0 is out of range 1-31/],
    ["* * 32 * *", /day-of-month 32 is out of range 1-31/],
    ["* * * 0 *", /month 0 is out of range 1-12/],
    ["* * * 13 *", /month 13 is out of range 1-12/],
    ["* * * * 8", /day-of-week 8 is out of range 0-7/],
    ["*/0 * * * *", /minute step "0" must be a whole number from 1 to 59/],
    ["*/60 * * * *", /minute step "60" must be a whole number from 1 to 59/],
    ["*/x * * * *", /minute step "x"/],
    ["5-1 * * * *", /minute range "5-1" runs backwards/],
    ["* * * DEC-JAN *", /month range "DEC-JAN" runs backwards/],
    ["a * * * *", /minute "a" is not a number/],
    ["* * * FOO *", /month "FOO" is not a number or a name \(JAN-DEC\)/],
    ["* * * * MONDAY", /day-of-week "MONDAY" is not a number or a name \(SUN-SAT\)/],
    ["* MON * * *", /hour "MON" is not a number/],
    ["1,,2 * * * *", /empty list item/],
    ["1, * * * *", /empty list item/],
    ["1-2-3 * * * *", /"1-2-3" is not a valid range/],
    ["*/5/2 * * * *", /more than one "\/"/],
    ["-5 * * * *", /minute "-5" is missing a value/],
    ["0 0 L * *", /day-of-month "L" is not a number/],
    ["0 0 ? * *", /day-of-month "\?" is not a number/],
    ["0 0 * * 5#2", /day-of-week "5#2" is not a number or a name/],
    ["0 0 1W * *", /day-of-month "1W" is not a number/],
    ["٥ * * * *", /minute "٥" is not a number/],
    ["0 0 30 2 *", /it never runs, because none of its months has day 30/],
    ["0 0 30,31 2 *", /never runs/],
    ["0 0 31 4,6,9,11 *", /never runs/],
    ["0 0 31 2 */7", /never runs/],
  ];
  for (const [expression, message] of invalid) {
    it(`rejects ${JSON.stringify(expression)} with a clear error`, () => {
      expect(() => parseCron(expression)).toThrow(CronError);
      expect(() => parseCron(expression)).toThrow(message);
    });
  }

  it("rejects values that are not strings", () => {
    expect(() => parseCron(null as unknown as string)).toThrow(/expected a string, got null/);
    expect(() => parseCron(5 as unknown as string)).toThrow(/expected a string, got number/);
  });

  it("rejects very long input without echoing it", () => {
    const long = `${"1,".repeat(600)}2 * * * *`;
    expect(() => parseCron(long)).toThrow(/longer than 1024 characters/);
    expect(() => parseCron(long)).not.toThrow(/1,1,1,1/);
  });

  it("escapes control characters and shortens hostile values in messages", () => {
    let message = "";
    try {
      parseCron("0 0 * * *\u0000");
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("\\u0000");
    expect(message).not.toContain("\u0000");
    expect(() => parseCron(`${"9".repeat(200)} * * * *`)).toThrow(/minute 9{50,}\.\.\. is out of range/);
  });
});

describe("nextRun in UTC", () => {
  it("is strictly after the given time, on whole minutes", () => {
    expect(nextRun("* * * * *", new Date("2026-11-05T10:00:00.000Z"), "UTC").toISOString()).toBe(
      z("2026-11-05T10:01:00Z"),
    );
    expect(nextRun("* * * * *", new Date("2026-11-05T10:00:59.999Z"), "UTC").toISOString()).toBe(
      z("2026-11-05T10:01:00Z"),
    );
    expect(nextRun("0 10 * * *", new Date("2026-11-05T10:00:00.000Z"), "UTC").toISOString()).toBe(
      z("2026-11-06T10:00:00Z"),
    );
  });

  it("runs every five minutes", () => {
    expect(runs("*/5 * * * *", "2026-11-05T10:02:30Z", "UTC", 3)).toEqual([
      z("2026-11-05T10:05:00Z"),
      z("2026-11-05T10:10:00Z"),
      z("2026-11-05T10:15:00Z"),
    ]);
    expect(runs("*/5 * * * *", "2026-11-05T10:05:00Z", "UTC", 1)).toEqual([z("2026-11-05T10:10:00Z")]);
    expect(runs("*/5 * * * *", "2026-12-31T23:57:00Z", "UTC", 2)).toEqual([
      z("2027-01-01T00:00:00Z"),
      z("2027-01-01T00:05:00Z"),
    ]);
  });

  it("never fires on the 31st in a 30-day month (or in February)", () => {
    expect(runsUntil("0 0 31 * *", "2026-01-01T00:00Z", "2026-12-31T23:59Z", "UTC")).toEqual([
      z("2026-01-31T00:00Z"),
      z("2026-03-31T00:00Z"),
      z("2026-05-31T00:00Z"),
      z("2026-07-31T00:00Z"),
      z("2026-08-31T00:00Z"),
      z("2026-10-31T00:00Z"),
      z("2026-12-31T00:00Z"),
    ]);
    expect(runs("0 0 30 * *", "2026-02-01T00:00Z", "UTC", 1)).toEqual([z("2026-03-30T00:00Z")]);
  });

  it("finds leap days, including across a century that is not a leap year", () => {
    expect(runs("0 12 29 2 *", "2026-01-01T00:00Z", "UTC", 2)).toEqual([
      z("2028-02-29T12:00Z"),
      z("2032-02-29T12:00Z"),
    ]);
    expect(runs("0 0 29 2 *", "2096-03-01T00:00Z", "UTC", 1)).toEqual([z("2104-02-29T00:00Z")]);
    // 29 February that is a Sunday (day-of-week starts with *, so both must match): every 28 years here.
    expect(runs("0 0 29 2 */7", "2026-01-01T00:00Z", "UTC", 2)).toEqual([
      z("2032-02-29T00:00Z"),
      z("2060-02-29T00:00Z"),
    ]);
  });

  it("matches either day field when both are restricted", () => {
    // 2026-11-01 is a Sunday. "1st of the month OR Monday".
    expect(runs("0 0 1 * MON", "2026-11-01T00:00Z", "UTC", 7)).toEqual([
      z("2026-11-02T00:00Z"),
      z("2026-11-09T00:00Z"),
      z("2026-11-16T00:00Z"),
      z("2026-11-23T00:00Z"),
      z("2026-11-30T00:00Z"),
      z("2026-12-01T00:00Z"),
      z("2026-12-07T00:00Z"),
    ]);
  });

  it("uses only the restricted day field when the other is *", () => {
    expect(runs("0 0 * * MON", "2026-11-01T00:00Z", "UTC", 2)).toEqual([
      z("2026-11-02T00:00Z"),
      z("2026-11-09T00:00Z"),
    ]);
    expect(runs("0 0 1 * *", "2026-11-01T00:00Z", "UTC", 2)).toEqual([z("2026-12-01T00:00Z"), z("2027-01-01T00:00Z")]);
  });

  it("requires both day fields when one starts with * (Vixie cron)", () => {
    // Days 1, 11, 21, 31 that are Mondays: none in November 2026; 21 December 2026 is a Monday.
    expect(runs("0 0 */10 * MON", "2026-11-01T00:00Z", "UTC", 1)).toEqual([z("2026-12-21T00:00Z")]);
  });

  it("treats 0, 7 and SUN alike", () => {
    const expected = [z("2026-11-08T00:00Z")];
    for (const sunday of ["0", "7", "SUN"]) expect(runs(`0 0 * * ${sunday}`, "2026-11-05T12:00Z", "UTC", 1)).toEqual(expected);
  });

  it("accepts a parsed schedule", () => {
    const schedule: CronSchedule = parseCron("0 9 * * *");
    const after = new Date("2026-11-05T12:00Z");
    expect(nextRun(schedule, after, "UTC")).toEqual(nextRun("0 9 * * *", after, "UTC"));
  });
});

describe("nextRun in a time zone", () => {
  it("runs on weekdays at 07:30 in Europe/Stockholm (CET in winter, CEST in summer)", () => {
    // 2026-11-05 is a Thursday.
    expect(runs("30 7 * * 1-5", "2026-11-05T06:30Z", "Europe/Stockholm", 3)).toEqual([
      z("2026-11-06T06:30Z"),
      z("2026-11-09T06:30Z"),
      z("2026-11-10T06:30Z"),
    ]);
    expect(runs("30 7 * * MON-FRI", "2026-07-03T12:00Z", "Europe/Stockholm", 1)).toEqual([z("2026-07-06T05:30Z")]);
  });

  it("runs at 09:00 local time in America/New_York", () => {
    // Friday 2026-11-06 10:00 EST → Monday 09:00 EST.
    expect(runs("0 9 * * 1-5", "2026-11-06T15:00Z", "America/New_York", 1)).toEqual([z("2026-11-09T14:00Z")]);
    // 12:00Z is 08:00 EDT (UTC-4), so 09:00 EDT is later the same day.
    expect(runs("0 9 * * *", "2026-07-01T12:00Z", "America/New_York", 2)).toEqual([
      z("2026-07-01T13:00Z"),
      z("2026-07-02T13:00Z"),
    ]);
  });

  it("accepts time zone names in any case", () => {
    expect(nextRun("0 9 * * *", new Date("2026-11-05T12:00Z"), "europe/stockholm").toISOString()).toBe(
      z("2026-11-06T08:00Z"),
    );
  });
});

describe("DST in Europe/Stockholm, spring forward on 2026-03-29 (02:00 → 03:00)", () => {
  const tz = "Europe/Stockholm";

  it("skips a wall-clock time that does not exist", () => {
    expect(runs("30 2 * * *", "2026-03-27T12:00Z", tz, 3)).toEqual([
      z("2026-03-28T01:30Z"), // 02:30 CET
      z("2026-03-30T00:30Z"), // 02:30 CEST; 2026-03-29 02:30 never happened
      z("2026-03-31T00:30Z"),
    ]);
    expect(runs("0 2 * * *", "2026-03-28T12:00Z", tz, 1)).toEqual([z("2026-03-30T00:00Z")]);
  });

  it("runs the times on either side of the gap", () => {
    expect(runs("59 1 * * *", "2026-03-28T12:00Z", tz, 1)).toEqual([z("2026-03-29T00:59Z")]); // 01:59 CET
    expect(runs("0 3 * * *", "2026-03-28T12:00Z", tz, 1)).toEqual([z("2026-03-29T01:00Z")]); // 03:00 CEST
  });

  it("keeps frequent jobs on real time across the gap", () => {
    expect(runs("*/30 * * * *", "2026-03-29T00:00Z", tz, 3)).toEqual([
      z("2026-03-29T00:30Z"), // 01:30 CET
      z("2026-03-29T01:00Z"), // 03:00 CEST
      z("2026-03-29T01:30Z"),
    ]);
    expect(runs("0 * * * *", "2026-03-28T23:00Z", tz, 3)).toEqual([
      z("2026-03-29T00:00Z"), // 01:00 CET
      z("2026-03-29T01:00Z"), // 03:00 CEST
      z("2026-03-29T02:00Z"),
    ]);
  });
});

describe("DST in Europe/Stockholm, fall back on 2026-10-25 (03:00 → 02:00)", () => {
  const tz = "Europe/Stockholm";

  it("runs a repeated wall-clock time once, at its first occurrence", () => {
    expect(runs("30 2 * * *", "2026-10-24T12:00Z", tz, 2)).toEqual([
      z("2026-10-25T00:30Z"), // 02:30 CEST (first); 02:30 CET at 01:30Z is not a run
      z("2026-10-26T01:30Z"), // 02:30 CET
    ]);
    expect(runs("30 2 * * *", "2026-10-25T00:30Z", tz, 1)).toEqual([z("2026-10-26T01:30Z")]);
    // Asked from inside the repeated hour (02:15 CET), the day's run is already past.
    expect(runs("30 2 * * *", "2026-10-25T01:15Z", tz, 1)).toEqual([z("2026-10-26T01:30Z")]);
    expect(runs("0 2 * * *", "2026-10-24T12:00Z", tz, 1)).toEqual([z("2026-10-25T00:00Z")]);
    expect(runs("0 3 * * *", "2026-10-24T12:00Z", tz, 1)).toEqual([z("2026-10-25T02:00Z")]);
  });

  it("pauses frequent jobs during the repeated hour", () => {
    expect(runs("0 * * * *", "2026-10-24T21:30Z", tz, 5)).toEqual([
      z("2026-10-24T22:00Z"), // 00:00 CEST
      z("2026-10-24T23:00Z"), // 01:00 CEST
      z("2026-10-25T00:00Z"), // 02:00 CEST
      z("2026-10-25T02:00Z"), // 03:00 CET (02:00 CET at 01:00Z repeats 02:00)
      z("2026-10-25T03:00Z"),
    ]);
    expect(runs("*/15 * * * *", "2026-10-25T00:45Z", tz, 2)).toEqual([z("2026-10-25T02:00Z"), z("2026-10-25T02:15Z")]);
  });

  it("never runs any wall-clock minute twice", () => {
    const all = runsUntil("* * * * *", "2026-10-24T23:00Z", "2026-10-25T03:00Z", tz);
    const fmt = new Intl.DateTimeFormat("en-GB", { timeZone: tz, dateStyle: "short", timeStyle: "short" });
    const labels = all.map((iso) => fmt.format(new Date(iso)));
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels.filter((label) => label.endsWith("02:30"))).toHaveLength(1);
  });
});

describe("DST in America/New_York", () => {
  const tz = "America/New_York";

  it("skips 02:30 on 2026-03-08 (02:00 EST → 03:00 EDT)", () => {
    expect(runs("30 2 * * *", "2026-03-07T12:00Z", tz, 2)).toEqual([z("2026-03-09T06:30Z"), z("2026-03-10T06:30Z")]);
  });

  it("runs 01:30 once on 2026-11-01 (02:00 EDT → 01:00 EST)", () => {
    expect(runs("30 1 * * *", "2026-10-31T12:00Z", tz, 2)).toEqual([z("2026-11-01T05:30Z"), z("2026-11-02T06:30Z")]);
  });
});

/**
 * An independent reference: scan every UTC minute, read the wall clock with Intl, and keep a minute when it matches
 * and its wall-clock reading has not been seen before (so a repeated time counts once, at its first occurrence).
 */
function bruteForce(expression: string, timeZone: string, fromIso: string, toIso: string): string[] {
  const s = parseCron(expression);
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
  });
  const from = new Date(fromIso).getTime();
  const to = new Date(toIso).getTime();
  const seen = new Set<string>();
  const out: string[] = [];
  for (let t = from - 86_400_000; t <= to; t += 60_000) {
    const parts = Object.fromEntries(fmt.formatToParts(t).map((p) => [p.type, Number(p.value)]));
    const [year, month, day, hour, minute] = [parts.year, parts.month, parts.day, parts.hour, parts.minute].map(Number);
    const key = `${year}-${month}-${day} ${hour}:${minute}`;
    const first = !seen.has(key);
    seen.add(key);
    if (t <= from || !first) continue;
    const dow = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day))).getUTCDay();
    const domOk = s.daysOfMonth.includes(Number(day));
    const dowOk = s.daysOfWeek.includes(dow);
    const dayOk = !s.dayOfMonthStar && !s.dayOfWeekStar ? domOk || dowOk : domOk && dowOk;
    if (dayOk && s.months.includes(Number(month)) && s.hours.includes(Number(hour)) && s.minutes.includes(Number(minute))) {
      out.push(new Date(t).toISOString());
    }
  }
  return out;
}

describe("nextRun agrees with a minute-by-minute reference around DST changes", () => {
  const windows: Array<[string, string, string]> = [
    ["Europe/Stockholm", "2026-03-28T00:00Z", "2026-03-30T12:00Z"],
    ["Europe/Stockholm", "2026-10-24T00:00Z", "2026-10-26T12:00Z"],
    ["America/New_York", "2026-03-07T00:00Z", "2026-03-09T12:00Z"],
    ["America/New_York", "2026-10-31T00:00Z", "2026-11-02T12:00Z"],
    // Half-hour DST shifts.
    ["Australia/Lord_Howe", "2026-04-03T12:00Z", "2026-04-05T12:00Z"],
    ["Australia/Lord_Howe", "2026-10-02T12:00Z", "2026-10-04T12:00Z"],
    ["UTC", "2026-11-05T00:00Z", "2026-11-07T00:00Z"],
  ];
  const expressions = ["*/5 * * * *", "30 2 * * *", "0 * * * *", "15,45 1-3 * * *", "*/7 2 * * *", "0 0 * * 0"];
  for (const [tz, from, to] of windows) {
    for (const expression of expressions) {
      it(`${expression} in ${tz} from ${from}`, () => {
        expect(runsUntil(expression, from, to, tz)).toEqual(bruteForce(expression, tz, from, to));
      });
    }
  }
});

describe("nextRun input checks", () => {
  it("rejects unknown, empty and missing time zones (never the host's zone)", () => {
    const at = new Date("2026-11-05T12:00Z");
    expect(() => nextRun("* * * * *", at, "Mars/Olympus")).toThrow(/Unknown time zone "Mars\/Olympus"/);
    expect(() => nextRun("* * * * *", at, "")).toThrow(/Invalid time zone/);
    expect(() => nextRun("* * * * *", at, undefined as unknown as string)).toThrow(/Invalid time zone/);
    expect(() => nextRun("* * * * *", at, "x".repeat(500))).toThrow(/Invalid time zone/);
  });

  it("rejects invalid dates", () => {
    expect(() => nextRun("* * * * *", new Date("nope"), "UTC")).toThrow(/valid Date/);
    expect(() => nextRun("* * * * *", "2026-11-05" as unknown as Date, "UTC")).toThrow(/valid Date/);
    expect(() => nextRun("* * * * *", new Date("1969-12-31T23:00Z"), "UTC")).toThrow(/between the years 1970 and 9999/);
  });

  it("rejects invalid expressions", () => {
    expect(() => nextRun("61 * * * *", new Date(), "UTC")).toThrow(CronError);
  });

  it("tells valid from invalid time zones", () => {
    expect(isValidTimeZone("Europe/Stockholm")).toBe(true);
    expect(isValidTimeZone("UTC")).toBe(true);
    expect(isValidTimeZone("Nope/Nowhere")).toBe(false);
    expect(isValidTimeZone("")).toBe(false);
    expect(isValidTimeZone(undefined)).toBe(false);
    expect(isValidTimeZone(42)).toBe(false);
  });
});
