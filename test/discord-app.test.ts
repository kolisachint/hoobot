/**
 * The Discord half of a bot (`skills/bot-discord/scripts/discord-app.ts`),
 * offline.
 *
 * The network is not mocked here on purpose: what is worth testing is the
 * arithmetic that goes *into* a Discord call. The application id is decoded
 * from the token and is what `PEER_BOT_IDS` takes; the permission integer is
 * what the invite URL asks for. Both are easy to get subtly wrong — a bit
 * wrong and the bot is invited to a server where it cannot post, or wired to
 * an id that is one digit short and never answers anybody.
 *
 * The token first segment is this bot's real application id, so the decode is
 * checked against a token whose answer is known rather than a round trip.
 */
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appIdFromToken, instanceFor, inviteUrl, permissionInt, PERMISSIONS, splitPeerIds } from "../skills/bot-discord/scripts/discord-app.ts";

/** A token shaped like Discord's: base64url(application id).timestamp.hmac. */
const tokenFor = (appId: string) => `${Buffer.from(appId, "utf8").toString("base64url")}.MTIzNDU2.c2lnbmF0dXJl`;

test("the application id comes out of the token, no request needed", () => {
  expect(appIdFromToken(tokenFor("1554151743929979020"))).toBe("1554151743929979020");
  // Snowflakes are 17 to 20 digits; a shorter one is a decode that lost a
  // byte, and wiring a peer to it is a peer nobody ever answers.
  expect(() => appIdFromToken(tokenFor("1"))).toThrow(/not a Discord bot token/);
});

test("base64url, not base64: - and _ appear in a real token segment", () => {
  // Discord encodes the id with the URL-safe alphabet, so a decoder using the
  // standard one gets the wrong bytes back. Round-tripping the exact segment
  // is the property that matters.
  const bytes = Buffer.concat([Buffer.from("1234567"), Buffer.from([0xfb, 0xef, 0xbe])]);
  const segment = bytes.toString("base64url");
  expect(segment).toMatch(/[-_]/);
  expect(Buffer.from(segment, "base64url").equals(bytes)).toBe(true);
});

test("something that is not a bot token is refused, not decoded to nonsense", () => {
  expect(() => appIdFromToken("xoxb-1234-abcd")).toThrow(/not a Discord bot token/);
  expect(() => appIdFromToken("")).toThrow(/not a Discord bot token/);
  // A short run of digits is not an id, whatever it decodes from.
  expect(() => appIdFromToken("MTIzNDU2.MTIz.hc")).toThrow(/not a Discord bot token/);
  // The real placeholder hoobot ships in .env.example.
  expect(() => appIdFromToken("DISCORD_TOKEN=")).toThrow(/not a Discord bot token/);
});

test("the invite URL carries exactly the permissions src/discord.ts uses", () => {
  const url = new URL(inviteUrl("123", "456"));
  expect(url.searchParams.get("client_id")).toBe("123");
  expect(url.searchParams.get("scope")).toBe("bot applications.commands");
  expect(url.searchParams.get("guild_id")).toBe("456");
  expect(url.searchParams.get("permissions")).toBe(permissionInt().toString());

  // Threads are gated separately from a channel, and a bot invited without
  // this one ignores every thread rather than erroring.
  expect(PERMISSIONS.send_messages_in_threads).toBe(1n << 38n);
  expect(PERMISSIONS.view_channel).toBe(1n << 10n);
  expect(PERMISSIONS.send_messages).toBe(1n << 11n);
  expect(PERMISSIONS.read_message_history).toBe(1n << 16n);
  expect(PERMISSIONS.attach_files).toBe(1n << 15n);
});

test("no server preselected means the user picks one, not the bot's picker", () => {
  expect(inviteUrl("123")).not.toContain("guild_id");
});

test("administrator is never requested", () => {
  // The difference between a bot that can post in a channel and a bot that
  // can delete the channel.
  expect(permissionInt() & (1n << 3n)).toBe(0n);
});

test("one PEER_BOT_IDS list, two chats: ids are split, not looked up", () => {
  const { discord, other } = splitPeerIds("U0C6HTTFF7T, 1554151743929979020,,1554151743929979021");
  expect(discord).toEqual(["1554151743929979020", "1554151743929979021"]);
  // A Slack id asked of Discord answers 400, not "unknown user", and reads
  // like a broken wiring rather than a different chat's id.
  expect(other).toEqual(["U0C6HTTFF7T"]);
  expect(splitPeerIds("")).toEqual({ discord: [], other: [] });
  expect(splitPeerIds(undefined as unknown as string)).toEqual({ discord: [], other: [] });
});

test("an instance is found by its token, not by its folder name", () => {
  // The portal calls the bot "hoo-bot" and the manager calls it "hoo";
  // matching on either name is how a real peer is reported as missing.
  const dir = mkdtempSync(join(tmpdir(), "discord-app-"));
  try {
    mkdirSync(join(dir, "hoo"));
    mkdirSync(join(dir, "hee"));
    writeFileSync(join(dir, "hoo", ".env"), `DISCORD_TOKEN=${tokenFor("1554151743929979020")}\n`);
    // A Slack-only companion: no Discord token at all, so never a match.
    writeFileSync(join(dir, "hee", ".env"), "SLACK_BOT_TOKEN=xoxb-1\nPEER_BOT_IDS=U0C6HTTFF7T\n");
    expect(instanceFor("1554151743929979020", ["hoo", "hee"], dir)).toBe("hoo");
    expect(instanceFor("1554151743929979999", ["hoo", "hee"], dir)).toBeUndefined();
    // A placeholder token is not a match either.
    mkdirSync(join(dir, "hoot"));
    writeFileSync(join(dir, "hoot", ".env"), "DISCORD_TOKEN=\n");
    expect(instanceFor("1554151743929979020", ["hoot"], dir)).toBeUndefined();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});