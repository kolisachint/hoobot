import { describe, expect, test } from "bun:test";
import { awakeKeepers, awakeWrap, parseAssertions, powerState } from "../src/power.ts";

// A real `pmset -g assertions` dump: Apple's own holders, plus the two kinds
// that mean somebody is actually trying to stay awake.
const DUMP = `2026-10-03 01:15:00 +0530
Assertion status system-wide:
   BackgroundTask                 0
   PreventUserIdleDisplaySleep    1
   PreventSystemSleep             0
   PreventUserIdleSystemSleep     1
Listed by owning process:
   pid 734(sharingd): [0x000037600001963a] 00:00:13 PreventUserIdleSystemSleep named: "Handoff"
   pid 446(WindowServer): [0x000036c0000995cf] UserIsActive named: "com.apple.iohideventsystem.queue.tickle"
   pid 389(powerd): [0x000001e20001855c] 03:48:26 PreventUserIdleSystemSleep named: "Powerd - Prevent sleep while display is on"
   pid 451(runningboardd): [0x00003857000196b4] 00:00:00 PreventUserIdleSystemSleep named: "osservice<com.apple.mobileassetd>451-23462:com.apple.CFNetwork.StorageDB"
   pid 1288(dasd): [0x0000385700111111] 00:00:02 PreventUserIdleSystemSleep named: "Disk Arbitration"
   pid 4446(Amphetamine): [0x00000296000185e2] 03:45:27 PreventUserIdleSystemSleep named: "Amphetamine (Single-Use - System)"
   pid 900(caffeinate): [0x0000029600ffff01] 00:00:04 PreventSystemSleep named: "caffeinate -i"
`;

/** Where each of those pids actually lives, as `ps -o comm=` reports it. */
const PATHS: Record<string, string> = {
  "734": "/usr/sbin/sharingd",
  "446": "/System/Library/CoreServices/WindowServer",
  "389": "/usr/libexec/powerd",
  "451": "/usr/libexec/runningboardd",
  "1288": "/usr/sbin/dasd",
  "4446": "/Applications/Amphetamine.app/Contents/MacOS/Amphetamine",
  // caffeinate is an Apple binary in /usr/bin and is the one that matters.
  "900": "/usr/bin/caffeinate",
};

const paths = async (pid: number): Promise<string> => PATHS[String(pid)] ?? "";

describe("parseAssertions", () => {
  test("keeps only the assertions that hold idle or system sleep", () => {
    expect(parseAssertions(DUMP).map((a) => a.process)).toEqual([
      "sharingd",
      "powerd",
      "runningboardd",
      "dasd",
      "Amphetamine",
      "caffeinate",
    ]);
  });

  test("a user-active assertion is not a sleep assertion", () => {
    expect(parseAssertions(DUMP).some((a) => a.process === "WindowServer")).toBe(false);
  });

  test("display sleep alone doesn't count: a dim screen still sleeps", () => {
    const displayOnly = DUMP.replace(/Prevent(UserIdle)?SystemSleep named/g, "PreventUserIdleDisplaySleep named");
    expect(parseAssertions(displayOnly)).toEqual([]);
  });

  test("an empty or truncated dump holds nothing", () => {
    expect(parseAssertions("")).toEqual([]);
    expect(parseAssertions("Assertion status system-wide:\n   PreventSystemSleep 0")).toEqual([]);
  });
});

describe("awakeKeepers", () => {
  test("names only the holders a person chose", async () => {
    expect(await awakeKeepers(parseAssertions(DUMP), paths)).toEqual({ held: true, holders: ["Amphetamine", "caffeinate"] });
  });

  test("Apple's own assertions are not keepers", async () => {
    // powerd holds sleep off only while the display is on, runningboardd for a
    // second on another service's behalf, dasd while a disk spins up. If those
    // counted, the warning could never appear on any Mac at all.
    const onlyApple = parseAssertions(DUMP).filter((a) => /^(powerd|runningboardd|dasd|sharingd)$/.test(a.process));
    expect(await awakeKeepers(onlyApple, paths)).toEqual({ held: false, holders: [] });
  });

  test("one keeper named twice is one holder", async () => {
    const twice = [
      ...parseAssertions(DUMP).filter((a) => a.process === "caffeinate"),
      { process: "caffeinate", pid: 901, kind: "PreventSystemSleep" },
    ];
    expect((await awakeKeepers(twice, async () => "/usr/bin/caffeinate")).holders).toEqual(["caffeinate"]);
  });

  test("a holder that ended between the two reads is skipped, not counted", async () => {
    const dying = async (pid: number) => {
      if (pid === 4446) throw new Error("no such process");
      return PATHS[String(pid)] ?? "";
    };
    expect((await awakeKeepers(parseAssertions(DUMP), dying)).holders).toEqual(["caffeinate"]);
  });
});

describe("powerState", () => {
  const where = async (pid: number) => paths(pid);
  const on = (pmset: () => Promise<string>, which: string | null = "/usr/bin/caffeinate") =>
    powerState({ platform: "darwin", pmset, where, which });

  test("is not a Mac elsewhere, and never warns", async () => {
    expect(await powerState({ platform: "linux" })).toEqual({ darwin: false, caffeinate: null, held: true, holders: [] });
  });

  test("a Mac with only Apple's own assertions is a Mac that will sleep", async () => {
    const state = await on(async () => DUMP.replace(/\n.*(Amphetamine|caffeinate).*/g, ""));
    expect(state).toEqual({ darwin: true, caffeinate: "/usr/bin/caffeinate", held: false, holders: [] });
  });

  test("reports who is holding a Mac awake", async () => {
    const state = await on(async () => DUMP);
    expect(state.held).toBe(true);
    expect(state.holders).toEqual(["Amphetamine", "caffeinate"]);
  });

  test("a Mac that won't answer is treated as one that sleeps", async () => {
    const state = await on(async () => {
      throw new Error("pmset is unhappy");
    });
    expect(state.held).toBe(false);
    expect(state.caffeinate).toBe("/usr/bin/caffeinate");
  });

  test("no caffeinate on the Mac means it can't be offered", async () => {
    const state = await on(async () => DUMP, null);
    expect(state.caffeinate).toBeNull();
    expect(state.held).toBe(true);
  });
});

describe("awakeWrap", () => {
  test("holds idle sleep on a Mac, never display sleep", () => {
    // -d would keep the screen on; -i just keeps the machine up while idle.
    expect(awakeWrap("bun src/index.ts", "darwin")).toBe("caffeinate -i bun src/index.ts");
    expect(awakeWrap("bun src/index.ts", "darwin")).not.toContain("-d ");
  });

  test("leaves other systems alone", () => {
    expect(awakeWrap("bun src/index.ts", "linux")).toBe("bun src/index.ts");
    expect(awakeWrap("bun src/index.ts", "win32")).toBe("bun src/index.ts");
  });
});
