// A real app-server that works, then wedges mid-turn: the exact shape of the
// morning's failure. initialize, thread/start and turn/start all answer, then
// the event stream simply stops — no turn/completed, ever.
import { createInterface } from "node:readline";

let turn = 0;

createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.id === undefined) return; // a notification; nothing to answer
  const { id, method, params } = msg;

  const reply = (result: any) => console.log(JSON.stringify({ id, result }));

  switch (method) {
    case "initialize":
      return reply({ userAgent: "wedging/1" });
    case "thread/start":
      return reply({ thread: { id: "th-1", turns: [] }, model: "test-model" });
    case "thread/resume":
      return reply({ thread: { id: params?.threadId ?? "th-1", turns: [] }, model: "test-model" });
    case "turn/start": {
      turn = Number(String(id).replace(/\D/g, "")) || ++turn;
      // Acknowledge, exactly like the real server: the reply is immediate and
      // the answer would arrive later as events.
      reply({ turn: { id: `u-${turn}`, status: "inProgress" } });
      console.log(
        JSON.stringify({
          method: "notification",
          params: { threadId: "th-1", turn: { id: `u-${turn}`, status: "inProgress" } },
        }),
      );
      // One progress event, so the watchdog sees a healthy turn first...
      setTimeout(() => {
        console.log(
          JSON.stringify({ method: "notification", params: { threadId: "th-1", item: { type: "agentMessage" } } }),
        );
      }, 100);
      // ...and then the stream dies. No turn/completed is ever sent.
      return;
    }
    case "turn/interrupt":
    case "thread/unsubscribe":
      return reply({});
    default:
      return reply({});
  }
});