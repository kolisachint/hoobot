/**
 * Timestamped logging, in one place.
 *
 * Every line this process writes carries the time it was written. Before
 * this, the bot logged bare lines — `[slack] …`, `Shutting down…` — and
 * reconstructing *when* something happened meant inferring it from file
 * mtimes. An incident at 09:14 was undiagnosable for exactly that reason.
 *
 * Log format is one line: `HH:MM:SS.mmm LEVEL message`. The date is on the
 * line only when it changes, so a midnight rollover stays readable without
 * repeating it 500 times. Callers keep using `console.log` for ad-hoc
 * output; these helpers are what the source should use.
 *
 * Anything written to stdout/stderr still goes to the same place the
 * supervisor reads (`runtime/<name>/<name>.log`), so this is purely a
 * change of prefix, not of destination.
 */

/** `true` while the last line printed was on today's date. */
let lastDay = "";

/** `HH:MM:SS.mmm`, plus `YYYY-MM-DD` when the day has changed since the last line. */
function stamp(): string {
  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  const time = now.toTimeString().slice(0, 12);
  // The day only repeats when it rolls over, so a long log stays compact.
  if (day !== lastDay) {
    lastDay = day;
    return `${day} ${time}`;
  }
  return time;
}

/** Force the next line to repeat the date (tests, and after a manual call). */
export function resetLogDay(): void {
  lastDay = "";
}

function write(level: string, args: unknown[], to: (line: string) => void) {
  const parts = args.map((a) => (typeof a === "string" ? a : inspect(a)));
  to(`${stamp()} ${level} ${parts.join(" ")}`);
}

/** `inspect` without importing node:util eagerly for the common string case. */
function inspect(value: unknown): string {
  if (value instanceof Error) return value.stack ?? `${value.name}: ${value.message}`;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** An ordinary event: startup, a message arriving, a turn starting. */
export function log(...args: unknown[]): void {
  write("INFO ", args, console.log);
}

/** Something recoverable and unexpected. */
export function warn(...args: unknown[]): void {
  write("WARN ", args, console.error);
}

/** A failure: a rejected call, a dead app-server, a wedged turn. */
export function error(...args: unknown[]): void {
  write("ERROR", args, console.error);
}