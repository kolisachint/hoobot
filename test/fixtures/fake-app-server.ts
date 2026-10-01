// Answers every request with an empty result, one JSON message per line.
import { createInterface } from "node:readline";
createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.id !== undefined) console.log(JSON.stringify({ id: msg.id, result: {} }));
});
