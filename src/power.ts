/**
 * Is this Mac going to fall asleep with the bots still running?
 *
 * A sleeping Mac suspends its processes rather than killing them, so a bot
 * survives: it is frozen, not dead. On wake its timers fire late, its sockets
 * are gone, and messages that arrived in the meantime were delivered to a
 * socket nobody was reading — Slack's Socket Mode does not replay them. So a
 * bot that is asleep is not broken, it is silent, and the silence looks
 * exactly like a bot nobody is talking to.
 *
 * `caffeinate`, which ships with macOS, is the cure: `caffeinate -i <cmd>`
 * holds an idle-sleep assertion for as long as `<cmd>` runs and drops it the
 * moment `<cmd>` exits. `scripts/runtime.sh` wraps every bot that way, so the
 * assertion can never outlive the bot that asked for it. Amphetamine and
 * friends do the same job for the whole machine; this module exists so the UI
 * can say out loud whether anything is actually holding the Mac awake.
 *
 * This is a Mac-only concern. On Linux and Windows it reports `darwin:false`
 * and every caller carries on as before.
 */
import { existsSync } from "node:fs";

const CAFFEINATE = "/usr/bin/caffeinate";

/** `pmset -g assertions`: the system-wide list of what is holding sleep off. */
async function pmsetAssertions(): Promise<string> {
  const proc = Bun.spawn(["pmset", "-g", "assertions"], { stdout: "pipe", stderr: "ignore" });
  const [text] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return text;
}

/** Where a process's binary lives: the test for "Apple did this, not you". */
async function binaryPath(pid: number): Promise<string> {
  const proc = Bun.spawn(["ps", "-o", "comm=", "-p", String(pid)], { stdout: "pipe", stderr: "ignore" });
  const [out] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return out.trim();
}

/**
 * Apple keeps its own sleep assertions and hands them out for its own
 * reasons — `powerd` while the display is on, `runningboardd` for the second
 * a system service needs, `dasd` while a disk spins up. Those are always on,
 * so counting them would mean the warning could never appear, which is the
 * wrong way round: a bot that silently sleeps is the one failure this exists
 * to prevent.
 *
 * So a holder counts only when its binary is somewhere a person chose to put
 * it. `/usr/bin` is deliberately not on the list: Apple ships `caffeinate`
 * and other user tools there, and this is exactly the one that matters.
 */
const SYSTEM_DIRS = ["/System/", "/usr/libexec/", "/usr/sbin/", "/usr/lib/"];

/** The assertions that mean "this Mac will not sleep on its own". */
const HOLDING = new Set(["PreventUserIdleSystemSleep", "PreventSystemSleep"]);

export type PowerState = {
  /** True on macOS, where sleep is something we can be asked to prevent. */
  darwin: boolean;
  /** Where `caffeinate` is, or null when it isn't there to be used. */
  caffeinate: string | null;
  /** Something is deliberately keeping the Mac awake while it sits idle. */
  held: boolean;
  /** Who is holding it, so the warning can name them instead of guessing. */
  holders: string[];
};

/** One line of `Listed by owning process:` that keeps the Mac awake. */
export type Assertion = { process: string; pid: number; kind: string };

/**
 * Read `pmset -g assertions` and pull out the assertions worth arguing about.
 *
 * Parsing is exported on its own because the output is the only interesting
 * input here, and a test can hand it a real assertion dump instead of needing
 * the assertions of the machine the test runs on.
 */
export function parseAssertions(text: string): Assertion[] {
  const out: Assertion[] = [];
  const owned = text.split("Listed by owning process:")[1] ?? "";
  for (const line of owned.split("\n")) {
    // "  pid 4446(Amphetamine): [0x…] 03:45:27 PreventUserIdleSystemSleep named: "…""
    const m = line.match(/^\s*pid\s+(\d+)\(([^)]*)\):.*?\s(\S+)\s+named:/);
    if (!m) continue;
    const [, pid, process, kind] = m as [string, string, string, string];
    if (!HOLDING.has(kind)) continue;
    out.push({ process, pid: Number(pid), kind });
  }
  return out;
}

/**
 * Of the assertions that hold sleep off, the ones a person meant. Apple keeps
 * its own for its own reasons; those are filtered out by where the binary
 * lives.
 */
export async function awakeKeepers(
  list: Assertion[],
  where: (pid: number) => Promise<string>,
): Promise<{ held: boolean; holders: string[] }> {
  const holders: string[] = [];
  for (const a of list) {
    let path = "";
    try {
      path = await where(a.pid);
    } catch {
      continue; // a process that ended between the two reads
    }
    if (SYSTEM_DIRS.some((dir) => path.startsWith(dir))) continue;
    if (!holders.includes(a.process)) holders.push(a.process);
  }
  return { held: holders.length > 0, holders };
}

const NOT_DARWIN: PowerState = { darwin: false, caffeinate: null, held: true, holders: [] };

/**
 * What the Mac is doing about sleep right now. Never throws: a missing
 * `pmset` or a Mac that won't answer is reported as "we don't know", and the
 * caller falls back to its own behaviour.
 */
export async function powerState(
  deps: { platform?: string; pmset?: () => Promise<string>; where?: (pid: number) => Promise<string>; which?: string | null } = {},
): Promise<PowerState> {
  if ((deps.platform ?? process.platform) !== "darwin") return NOT_DARWIN;
  const caffeinate = deps.which === undefined ? (existsSync(CAFFEINATE) ? CAFFEINATE : null) : deps.which;
  try {
    const { held, holders } = await awakeKeepers(parseAssertions(await (deps.pmset ?? pmsetAssertions)()), deps.where ?? binaryPath);
    return { darwin: true, caffeinate, held, holders };
  } catch {
    // A Mac that won't answer is treated as one that will sleep.
    return { darwin: true, caffeinate, held: false, holders: [] };
  }
}

/**
 * The wrapper a command needs to keep the Mac awake while it runs: the
 * command under `caffeinate -i`, or the command itself on other systems.
 *
 * `-i` only holds idle system sleep, not display sleep, so the screen still
 * dims and the Mac still respects a closed lid — a bot should not be the
 * reason a laptop stays open and hot.
 */
export function awakeWrap(cmd: string, platform: string = process.platform): string {
  if (platform !== "darwin") return cmd;
  return `caffeinate -i ${cmd}`;
}
