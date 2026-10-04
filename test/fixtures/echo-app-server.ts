// A stand-in app-server: it does the handshake, starts a thread, and answers a
// turn with whatever the prompt asked for (`Reply with exactly: X`).
//
// It exists so the end-to-end scripts run deterministically, offline and
// without API credits. Point APP_SERVER at a real `hoocode app-server` to run
// the same script against a real model.
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const send = (message: unknown) => console.log(JSON.stringify(message));

const DEFAULT_THREAD = "thread-echo-1";
let turn = 0;

createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  const { id, method, params } = JSON.parse(line);
  if (id === undefined) return; // a notification; nothing to answer
  const reply = (result: unknown) => send({ id, result });
  switch (method) {
    case "initialize":
      return reply({ userAgent: "echo-app-server" });
    case "thread/start":
      return reply({ thread: { id: DEFAULT_THREAD } });
    case "thread/resume":
      return reply({ thread: { id: params?.threadId ?? DEFAULT_THREAD } });
    case "model/list":
      return reply({ items: [{ id: "echo/free", displayName: "Echo" }] });
    case "turn/start": {
      const threadId = params?.threadId ?? DEFAULT_THREAD;
      const turnId = `turn-${++turn}`;
      reply({ turn: { id: turnId, status: "inProgress" } });
      const prompt = (params?.input ?? [])
        .filter((i: any) => i.type === "text")
        .map((i: any) => i.text)
        .join("\n");
      // ECHO_PROMPT_LOG lets a test read the prompt it actually received.
      if (process.env.ECHO_PROMPT_LOG) appendFileSync(process.env.ECHO_PROMPT_LOG, `${prompt}\n---\n`);
      const asked = /Reply with exactly:\s*(.+)/.exec(prompt);
      const item = { type: "agentMessage", text: asked ? asked[1]!.trim() : "echo" };
      send({ method: "turn/started", params: { threadId, turn: { id: turnId, status: "inProgress" } } });
      send({ method: "item/completed", params: { threadId, item: { id: `item-${turn}`, ...item } } });
      send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed", items: [item] } } });
      return;
    }
    default:
      return reply({});
  }
});