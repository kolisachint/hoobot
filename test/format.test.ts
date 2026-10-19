import { expect, test } from "bun:test";
import { describeTool, formatTodos, splitMessage } from "../src/format.ts";

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

test("formatTodos maps each status to its checkbox mark", () => {
  expect(
    formatTodos([
      { content: "write the code", status: "completed" },
      { content: "run the tests", status: "in_progress" },
      { content: "update the docs", status: "pending" },
    ]),
  ).toEqual(["- [x] write the code", "- [~] run the tests", "- [ ] update the docs"]);
});

test("formatTodos renders nothing for no todos", () => {
  expect(formatTodos([])).toEqual([]);
});

test("formatTodos truncates long todos to 80 chars", () => {
  const [row] = formatTodos([{ content: `todo ${"x".repeat(100)}`, status: "pending" }]);
  expect(row).toBe(`- [ ] todo ${"x".repeat(74)}…`);
  expect(row!.length).toBe("- [ ] ".length + 80);
});

test("formatTodos caps the rows and counts the rest", () => {
  const todos = Array.from({ length: 8 }, (_, i) => ({ content: `todo ${i}`, status: "pending" }));
  const rows = formatTodos(todos);
  expect(rows).toHaveLength(7);
  expect(rows.slice(0, 6)).toEqual(todos.slice(0, 6).map((t) => `- [ ] ${t.content}`));
  expect(rows.at(-1)).toBe("-# …and 2 more");
  expect(formatTodos(todos, 2)).toEqual(["- [ ] todo 0", "- [ ] todo 1", "-# …and 6 more"]);
});

test("both spellings of the subagent tools describe the same way", () => {
  expect(describeTool("Agent", { description: "map the repo" })).toBe("agent `map the repo`");
  expect(describeTool("Task", { description: "map the repo" })).toBe(
    describeTool("Agent", { description: "map the repo" }),
  );
  expect(describeTool("AgentOut", { task_id: "explore#1" })).toBe("agentout `explore#1`");
  expect(describeTool("TaskOutput", { list: true })).toBe(describeTool("AgentOut", { list: true }));
});
