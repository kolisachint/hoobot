import { expect, test } from "bun:test";
import { fromMrkdwn, toMrkdwn } from "../src/mrkdwn.ts";

test("Discord Markdown becomes Slack mrkdwn", () => {
  expect(toMrkdwn("**Status**")).toBe("*Status*");
  expect(toMrkdwn("# Title")).toBe("*Title*");
  expect(toMrkdwn("an *italic* and **bold *both* here**")).toBe("an _italic_ and *bold _both_ here*");
  expect(toMrkdwn("~~gone~~")).toBe("~gone~");
  expect(toMrkdwn("-# [PR #7](<https://github.com/o/r/pull/7>) · 3 steps")).toBe("<https://github.com/o/r/pull/7|PR #7> · 3 steps");
  expect(toMrkdwn("[docs](https://x.y/?a=1&b=2)")).toBe("<https://x.y/?a=1&b=2|docs>");
});

test("special characters are escaped; code is left alone apart from that", () => {
  expect(toMrkdwn("a < b && c > d")).toBe("a &lt; b &amp;&amp; c &gt; d");
  expect(toMrkdwn("`**not bold** <x>`")).toBe("`**not bold** &lt;x&gt;`");
  expect(toMrkdwn("```ts\nif (a < b) **x**\n```")).toBe("```\nif (a &lt; b) **x**\n```");
  expect(toMrkdwn("snake_case_name and 2*3*4")).toBe("snake_case_name and 2*3*4");
});

test("Slack text becomes plain text for the model", () => {
  const names = (id: string) => (id === "U1" ? "sam" : undefined);
  expect(fromMrkdwn("hey <@U1> and <@U2>", names)).toBe("hey @sam and @U2");
  expect(fromMrkdwn("in <#C1|dev> and <#C2>")).toBe("in #dev and #C2");
  expect(fromMrkdwn("<https://a.b|the link> <https://c.d> <!here>")).toBe("the link (https://a.b) https://c.d @here");
  expect(fromMrkdwn("a &lt;b&gt; &amp;amp;")).toBe("a <b> &amp;");
});
