import { expect, test } from "bun:test";
import { linkMentions, TurnBudget } from "../src/peers.ts";
import { toMrkdwn } from "../src/mrkdwn.ts";

test("a peer bot gets N turns per thread, then needs a grant; a person resets it", () => {
  const b = new TurnBudget(2);
  expect(b.take("t1")).toBe(true);
  expect(b.take("t1")).toBe(true);
  expect(b.take("t1")).toBe(false);
  expect(b.take("t2")).toBe(true); // other threads have their own budget
  expect(b.used("t1")).toBe(2);
  b.grant("t1");
  expect(b.take("t1")).toBe(true);
  expect(b.take("t1")).toBe(true);
  expect(b.take("t1")).toBe(false);
  b.reset("t1");
  expect(b.take("t1")).toBe(true);
});

test("@peer becomes a Slack mention; code, emails and longer names don't", () => {
  const peers = new Map([["hee", "U0HEE"]]);
  expect(linkMentions("Hey @hee, your turn", peers)).toBe("Hey <@U0HEE>, your turn");
  expect(linkMentions("@Hee: hi", peers)).toBe("<@U0HEE>: hi");
  expect(linkMentions("`@hee` and ```\n@hee\n```", peers)).toBe("`@hee` and ```\n@hee\n```");
  expect(linkMentions("me@hee.io @heelo @hee-bot", peers)).toBe("me@hee.io @heelo @hee-bot");
  expect(linkMentions("hi @hee", new Map())).toBe("hi @hee");
});

test("Slack mentions survive mrkdwn conversion", () => {
  expect(toMrkdwn("ask <@U0HEE> & **me**")).toBe("ask <@U0HEE> &amp; *me*");
});
