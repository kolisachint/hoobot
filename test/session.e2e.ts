// End-to-end: real hoocode, fake Discord thread. Run: bun test/session.e2e.ts
process.env.DISCORD_TOKEN ??= "x";
process.env.ALLOWED_USER_IDS ??= "1";
process.env.HOO_WORKDIR ??= "/tmp/hoo-bot-e2e";
const { prepareWorkspace } = await import("../src/config.ts");
const { ThreadSession } = await import("../src/session.ts");
prepareWorkspace();

const log: string[] = [];
const fakeMsg = (content: any) => ({
  edit: async (c: any) => { log.push(`EDIT  ${typeof c === "string" ? c : c.content}`); },
  awaitMessageComponent: async () => ({
    customId: "ui:0", user: { username: "tester" },
    update: async (c: any) => { log.push(`CLICK ${c.content}`); },
  }),
});
const thread: any = {
  id: "e2e-thread",
  send: async (c: any) => { log.push(`SEND  ${typeof c === "string" ? c : c.content + "  [buttons]"}`); return fakeMsg(c); },
  sendTyping: async () => {},
};

let done!: () => void;
const finished = new Promise<void>((r) => (done = r));
const s = new ThreadSession(thread, () => done());
await s.prompt("Run the bash command `echo hello-discord` then say in one sentence what it printed.");
// wait for the run to end, then close
const t0 = Date.now();
while (!log.some((l) => l.startsWith("SEND") && l.includes("hello-discord") && !l.includes("[buttons]")) && Date.now() - t0 < 90_000)
  await Bun.sleep(500);
await Bun.sleep(2000);
s.close();
await finished;
console.log(log.join("\n"));
