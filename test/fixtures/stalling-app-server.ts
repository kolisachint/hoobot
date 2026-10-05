// Answers `initialize` like a healthy server, then goes silent for everything
// else — the shape of a turn that wedges mid-flight.
import { createInterface } from "node:readline";
createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    console.log(JSON.stringify({ id: msg.id, result: { userAgent: "silent/1" } }));
    return;
  }
  // Every later call is ignored on purpose.
});