import { expect, test } from "bun:test";
import { describeTool, splitMessage } from "../src/format.ts";

test("short text is one chunk", () => {
  expect(splitMessage("hello")).toEqual(["hello"]);
});

test("every chunk fits Discord's 2000 limit", () => {
  const text = Array.from({ length: 400 }, (_, i) => `line ${i} ${"x".repeat(20)}`).join("\n");
  const chunks = splitMessage(text);
  expect(chunks.length).toBeGreaterThan(1);
  for (const c of chunks) expect(c.length).toBeLessThanOrEqual(2000);
  expect(chunks.join("\n").replace(/\s/g, "")).toBe(text.replace(/\s/g, ""));
});

test("code fences are closed and reopened across chunks", () => {
  const body = Array.from({ length: 200 }, (_, i) => `console.log(${i}); // padding padding`).join("\n");
  const chunks = splitMessage("Here:\n```ts\n" + body + "\n```\nDone.");
  expect(chunks.length).toBeGreaterThan(1);
  for (const c of chunks) expect((c.match(/```/g) ?? []).length % 2).toBe(0);
  expect(chunks[1]!.startsWith("```ts")).toBe(true);
});

test("a single huge line is hard-wrapped", () => {
  const chunks = splitMessage("y".repeat(5000));
  for (const c of chunks) expect(c.length).toBeLessThanOrEqual(2000);
});

test("both spellings of the subagent tool describe the same way", () => {
  expect(describeTool("Task", { description: "map the repo" })).toBe(
    describeTool("Dispatch", { description: "map the repo" }),
  );
});
