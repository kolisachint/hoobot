import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(`Missing ${name}. Copy .env.example to .env and fill it in.`);
    process.exit(1);
  }
  return value;
}

function list(name: string): string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export const config = {
  token: required("DISCORD_TOKEN"),
  /** Only these Discord user IDs can talk to the bot or approve tools. */
  allowedUserIds: new Set(list("ALLOWED_USER_IDS")),
  /** Optional: restrict to one server / some channels. */
  guildId: process.env.GUILD_ID?.trim() || undefined,
  channelIds: new Set(list("CHANNEL_IDS")),
  /** Directory hoocode works in. */
  workdir: resolve(process.env.HOO_WORKDIR?.trim() || "./workspace"),
  hoocodeBin: process.env.HOOCODE_BIN?.trim() || "hoocode",
  hoocodeArgs: (process.env.HOOCODE_ARGS ?? "").split(/\s+/).filter(Boolean),
  /**
   * The Codex app-server to talk to: `unix://PATH` for a running server
   * (`hoocode app-server --listen unix://` or `codex app-server --listen unix://`),
   * or empty to start `hoocode app-server` in the work folder over stdio.
   */
  appServer: process.env.APP_SERVER?.trim() || "",
  /** Optional model for new threads, e.g. anthropic/claude-sonnet-4-5. */
  model: process.env.MODEL?.trim() || undefined,
  /** Discord thread → app-server thread links. */
  linksFile: resolve(
    process.env.LINKS_FILE?.trim() || join(homedir(), ".local", "share", "hoobot", "links.json"),
  ),
  approvalTimeoutMs: Number(process.env.APPROVAL_TIMEOUT_MINUTES ?? 10) * 60_000,
  idleTimeoutMs: Number(process.env.IDLE_TIMEOUT_MINUTES ?? 30) * 60_000,
  debug: process.env.DEBUG === "1",
};

if (config.allowedUserIds.size === 0) {
  console.error(
    "ALLOWED_USER_IDS is empty. Refusing to start: anyone in the server could run shell commands.",
  );
  process.exit(1);
}

/**
 * Give the workspace a project-level hoocode config that puts it in a custom
 * "discord" mode. Your global config auto-allows bash/edit/write in build mode,
 * and project configs can only *add* to auto_allow for an existing mode, so a
 * separate mode name is the only way to make hoocode ask first. Those asks
 * become Allow / Deny buttons in Discord.
 *
 * Rust hoocode reads `<workspace>/.cortexcode/`; the old TypeScript build
 * read `.hoocode/`. Without the right one, the workspace silently falls back
 * to the global mode and nothing asks.
 *
 * Only written when missing, so a real project's own config is never clobbered.
 */
export function prepareWorkspace() {
  mkdirSync(config.workdir, { recursive: true });

  const hooDir = join(config.workdir, ".cortexcode");
  const cfgPath = join(hooDir, "hoo-config.json");
  if (!existsSync(cfgPath)) {
    mkdirSync(hooDir, { recursive: true });
    writeFileSync(
      cfgPath,
      JSON.stringify(
        {
          active_mode: "discord",
          modes: { discord: { auto_allow: ["read"] } },
        },
        null,
        2,
      ) + "\n",
    );
    console.log(`Wrote ${cfgPath} (bash/edit/write will ask in Discord first)`);
  }

  const promptPath = join(hooDir, "modes", "discord", "system.md");
  if (!existsSync(promptPath)) {
    mkdirSync(join(hooDir, "modes", "discord"), { recursive: true });
    writeFileSync(
      promptPath,
      [
        "You are being used through a Discord chat.",
        "",
        "- Keep replies short. Discord messages are capped at 2000 characters.",
        "- Use short lines, simple headings and bullet lists; avoid wide tables.",
        "- Put code and command output in fenced code blocks.",
        "- bash, edit and write need the user's approval via a button;",
        "  if a call is denied, ask what they want instead of retrying.",
        "- Never commit or push unless asked.",
        "",
      ].join("\n"),
    );
  }
}
