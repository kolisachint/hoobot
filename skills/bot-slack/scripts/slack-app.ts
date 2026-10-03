#!/usr/bin/env bun
/**
 * The Slack half of a hoobot bot, driven by Slack's own CLI.
 *
 * A hoobot bot is a Slack app: it needs an app, a bot user, a manifest of
 * scopes and events, and an icon. Until now that meant a browser, and every
 * skill here ended with "ask the user to do this by hand". The Slack CLI
 * (`slack`, v4) can do all of it — but only from a terminal, which is the
 * whole problem when the caller is a bot. Hence `slack-pty.sh` next door:
 * run it in a pty, press Enter, and the CLI creates the app from the
 * manifest, installs it to the team, uploads the icon, and records the App
 * ID.
 *
 *   slack-app.ts create hee --description "hoo's companion"   # app + install
 *   slack-app.ts tokens hee                                  # fetch both, --write
 *   slack-app.ts sync   hee                                  # push manifest edits
 *   slack-app.ts verify hee                                  # what Slack has now
 *   slack-app.ts token  hee                                  # bot id for PEER_BOT_IDS
 *   slack-app.ts delete hee                                  # remove the app
 *
 * Apps are installed into the **deployed** environment, not `local`, and
 * that is not a preference. A local install is a development app, and Slack
 * says so in the name it gives everybody else: the app becomes
 * "<name> (local)" and its bot user `<name>_local`, so the bot is
 * @hee_local in every mention and `users.info` never agrees with the
 * manifest. The deployed environment gives the plain name and costs nothing
 * here — hoobot runs the app itself, not Slack's runtime.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

const argv = process.argv.slice(2);
const command = argv[0];
const name = argv[1];

if (!command || !["create", "sync", "verify", "token", "tokens", "delete", "id"].includes(command)) {
  console.error(`usage: slack-app.ts <create|sync|verify|token|tokens|id|delete> <bot> [options]

  --description <text>   one line for the app's description
  --long-description <text>
  --display-name <text>  the bot's name in Slack (defaults to the bot name)
  --background-color <#hex>
  --icon <file.png>      uploaded as the app icon on create and sync
  --runtime <dir>        the hoobot runtime folder (default: hoobot path runtime)
  --write                tokens: save them into the bot's .env as well as printing
`);
  process.exit(command ? 0 : 64);
}
if (command !== "id" && !name) {
  console.error(`slack-app.ts ${command}: which bot?`);
  process.exit(64);
}

const flag = (key: string): string | undefined => {
  const i = argv.indexOf(`--${key}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
/** `--write` has no value, so asking flag() for one returns the next flag. */
const on = (key: string): boolean => argv.includes(`--${key}`);
const runtime = flag("runtime")?.replace(/^~(?=\/|$)/, process.env.HOME ?? "~") ?? runtimeDir();
const projectDir = join(runtime, "slack", name ?? "");
const ptyScript = join(import.meta.dir, "slack-pty.sh");

/**
 * Where the app is installed. `deployed` by default, because a `local` app
 * is a development app and Slack marks it in the name it gives everybody
 * else: the app becomes "<name> (local)" and the bot user `<name>_local`.
 * Same app otherwise, and hoobot runs it itself either way. `local` is only
 * for developing against Slack's own runtime.
 */
const environment = (): string => flag("environment") ?? "deployed";

function runtimeDir(): string {
  try {
    const out = spawnSync("hoobot", ["path", "runtime"], { encoding: "utf8" });
    const line = out.stdout?.trim();
    if (out.status === 0 && line && line.startsWith("/")) return line;
  } catch {
    // not installed as a command; fall through
  }
  return join(process.env.HOME ?? "~", ".hoobot", "runtime");
}

/** Run the Slack CLI. Interactive prompts go through the pty wrapper. */
function slack(args: string[], opts: { interactive?: boolean; cwd?: string; keys?: string } = {}): string {
  const cmd = opts.interactive ? ["bash", ptyScript, "slack", ...args] : ["slack", ...args];
  const out = spawnSync(cmd[0]!, cmd.slice(1), {
    cwd: opts.cwd ?? projectDir,
    encoding: "utf8",
    // `app delete` asks for confirmation and its default is No, so Enter
    // would keep the app. Anything destructive says so out loud.
    env: { ...process.env, TERM: "xterm", ...(opts.keys ? { SLACK_PTY_KEYS: opts.keys } : {}) },
    timeout: 10 * 60_000,
  });
  return `${out.stdout ?? ""}${out.stderr ?? ""}`;
}

/** Slack's CLI colours its output; the escapes are noise in a chat message. */
const plain = (text: string): string => text.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");

function fail(message: string): never {
  console.error(`slack-app.ts: ${message}`);
  process.exit(1);
}

/** What the CLI recorded about the installed app. */
function appRecord(): { appId: string; teamId: string } | null {
  // The CLI keeps one file per environment: apps.json for deployed, and
  // apps.dev.json for local. A project that installed both has both, and
  // reading the wrong one means talking to an app you are not changing.
  const dev = environment() === "local";
  const path = join(projectDir, ".slack", dev ? "apps.dev.json" : "apps.json");
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as
      | { apps?: Record<string, { app_id?: string; team_id?: string }> }
      | Record<string, { app_id?: string; team_id?: string }>;
    const map = "apps" in parsed ? parsed.apps ?? {} : parsed;
    const first = Object.values(map)[0];
    return first?.app_id ? { appId: first.app_id, teamId: first.team_id ?? "" } : null;
  } catch {
    return null;
  }
}

/**
 * The manifest a hoobot bot needs.
 *
 * Socket Mode, so there is no public URL and no OAuth dance to receive
 * events. `channels:join` is what lets the bot add itself to a channel it
 * was invited to but is not yet a member of, which is why /invite works.
 */
function manifest(opts: { displayName: string; description?: string; longDescription?: string; backgroundColor?: string }) {
  return {
    display_information: {
      name: opts.displayName,
      ...(opts.description ? { description: opts.description } : {}),
      ...(opts.longDescription ? { long_description: opts.longDescription } : {}),
      ...(opts.backgroundColor ? { background_color: opts.backgroundColor } : {}),
    },
    features: {
      bot_user: { display_name: opts.displayName, always_online: true },
    },
    oauth_config: {
      scopes: {
        bot: [
          "app_mentions:read",
          "channels:history",
          "groups:history",
          "channels:read",
          "groups:read",
          "chat:write",
          "files:read",
          "files:write",
          "users:read",
          "channels:join",
        ],
      },
    },
    settings: {
      event_subscriptions: { bot_events: ["message.channels", "message.groups"] },
      interactivity: { is_enabled: true },
      socket_mode_enabled: true,
    },
  };
}

// ---------------------------------------------------------------- commands

if (command === "create") {
  const displayName = flag("display-name") ?? name!;
  mkdirSync(dirname(projectDir), { recursive: true });

  // A Slack CLI project is just a folder with `.slack/` and a manifest.
  // The starter template is the smallest one that produces a valid one, and
  // everything it scaffolds beyond that is Bolt plumbing hoobot does not
  // use. `--list` shows the others if this ever stops being enough.
  //
  // `project create <name>` makes a folder named <name> inside the current
  // directory, so it runs one level up — otherwise it nests flux/flux.
  if (!existsSync(join(projectDir, ".slack"))) {
    mkdirSync(dirname(projectDir), { recursive: true });
    const out = plain(slack(["project", "create", name!, "--template", "slack-samples/bolt-js-starter-template"], { interactive: true, cwd: dirname(projectDir) }));
    if (!existsSync(join(projectDir, ".slack"))) fail(`could not create a Slack project:\n${out.trim()}`);
  }

  writeFileSync(join(projectDir, "manifest.json"), JSON.stringify(manifest({
    displayName,
    description: flag("description"),
    longDescription: flag("long-description"),
    backgroundColor: flag("background-color"),
  }), null, 2) + "\n");

  // The CLI uploads whatever is at assets/icon.png as the app icon, so the
  // avatar is part of creating the app rather than a manual step after it.
  const icon = flag("icon");
  if (icon) {
    if (!existsSync(icon)) fail(`no such icon: ${icon}`);
    mkdirSync(join(projectDir, "assets"), { recursive: true });
    writeFileSync(join(projectDir, "assets", "icon.png"), readFileSync(icon));
  }

  const out = plain(slack(["app", "install", "--environment", environment()], { interactive: true }));
  const record = appRecord();
  if (!record) fail(`the app was not created. Slack said:\n${out.trim()}`);

  const test = verify(record.appId);
  console.log(`app_id=${record.appId}`);
  if (test.userId) console.log(`bot_user_id=${test.userId}`);
  console.log(`team_id=${record.teamId}`);
  console.log(`project=${projectDir}`);
  if (icon) console.log(`icon=assets/icon.png uploaded`);
  console.log(`
The app exists and is installed. Two strings are still yours to copy — Slack
only shows them on the app's pages, not through its API:

  Bot token (xoxb-…):  OAuth & Permissions → Bot Token Scopes → Install/Reinstall
  App token (xapp-…):  Basic Information → App-Level Tokens → Generate

Paste each into the manager (or the bot's .env) as SLACK_BOT_TOKEN and
SLACK_APP_TOKEN, start the bot, then check it end to end:

  bash "$(hoobot path selftest)" ${name}`);
} else if (command === "sync") {
  const record = appRecord() ?? fail(`no Slack project for “${name}”. Create it first: slack-app.ts create ${name}`);
  const icon = flag("icon");
  if (icon) {
    mkdirSync(join(projectDir, "assets"), { recursive: true });
    writeFileSync(join(projectDir, "assets", "icon.png"), readFileSync(icon));
  }
  const out = plain(slack(["manifest", "sync", "--manifest-source", "local"], { interactive: true }));
  if (/error|not installed|invalid/i.test(out) && !/finished|updated|success/i.test(out)) {
    fail(`manifest sync failed:\n${out.trim()}`);
  }
  console.log(`manifest pushed to ${record.appId}`);
  console.log(out.trim().split("\n").slice(-6).join("\n"));
} else if (command === "verify") {
  const record = appRecord() ?? fail(`no Slack project for “${name}”. Create it first: slack-app.ts create ${name}`);
  const test = verify(record.appId);
  // `-a` skips the "which app?" prompt, which is the whole reason the pty
  // wrapper exists.
  const remote = plain(slack(["manifest", "info", "--source", "remote", "--app", record.appId]));
  console.log(`app_id=${record.appId}`);
  console.log(`bot_user_id=${test.userId ?? "?"}`);
  console.log(`bot_name=${test.user ?? "?"}`);
  console.log(`installed=${test.ok ? "yes" : "no — " + (test.error ?? "unknown")}`);
  if (remote.includes("display_information")) {
    const scopes = [...remote.matchAll(/"(app_mentions:read|channels:history|chat:write|users:read|files:write|channels:join)"/g)].map((m) => m[1]);
    console.log(`scopes=${[...new Set(scopes)].sort().join(",") || "(none found)"}`);
  }
} else if (command === "token") {
  const record = appRecord() ?? fail(`no Slack project for “${name}”`);
  const test = verify(record.appId);
  if (!test.userId) fail(`could not read the bot user: ${test.error ?? "no user id"}`);
  console.log(test.userId);
} else if (command === "tokens") {
  const record = appRecord() ?? fail(`no Slack project for “${name}”. Create it first: slack-app.ts create ${name}`);
  const userToken = slackUserToken(record.teamId);
  if (!userToken) fail(`not logged in to Slack. Run: slack login`);

  // The endpoint the CLI itself calls to authenticate as the app. It is
  // undocumented but not private: `slack api --app <id>` and `slack run`
  // both go through it, and it is the only place either token is ever
  // returned in full — the app's OAuth page shows them to a human, but a
  // program has no other way to get them. Both come back from one call.
  //
  // `bot_scopes` is not optional in practice. Left out, Slack still hands
  // over a token, and that token answers every call with
  // `account_inactive` — the shape of a dead token, for a live app, which
  // sends you off to reinstall something that was never broken.
  const scopes = manifestScopes();
  const res = await fetch("https://slack.com/api/apps.developerInstall", {
    method: "POST",
    headers: { Authorization: `Bearer ${userToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: record.appId, ...(scopes ? { bot_scopes: scopes } : {}) }),
  });
  const json = (await res.json()) as { ok?: boolean; error?: string; api_access_tokens?: { bot?: string; app_level?: string } };
  if (!json.ok || !json.api_access_tokens?.bot || !json.api_access_tokens?.app_level) {
    fail(`Slack would not hand over the tokens: ${json.error ?? "no tokens in the reply"}`);
  }
  const bot = json.api_access_tokens.bot;
  const appToken = json.api_access_tokens.app_level;

  // Never report success on a token that does not work: `connections.open`
  // is the one that proves Socket Mode, and a bot that cannot open a
  // websocket looks perfectly healthy until someone mentions it.
  const opened = await socketModeOk(appToken);
  console.log(`SLACK_BOT_TOKEN=${bot}`);
  console.log(`SLACK_APP_TOKEN=${appToken}`);
  console.log(`bot_user_id=${verify(record.appId).userId ?? "?"}`);
  console.log(`socket_mode=${opened ? "ok" : "FAILED"}`);

  if (on("write")) {
    const envPath = join(runtime, name!, ".env");
    if (!existsSync(envPath)) fail(`no .env at ${envPath}. Create the bot first: slack-bot-create`);
    writeEnvKeys(envPath, { SLACK_BOT_TOKEN: bot, SLACK_APP_TOKEN: appToken });
    console.log(`\nwritten to ${envPath} (mode 600)`);
    console.log("restart the bot, then: bash \"$(…/paths.sh)\" selftest " + name);
  }
} else if (command === "id") {
  const record = appRecord();
  console.log(record?.appId ?? "");
} else if (command === "delete") {
  const record = appRecord();
  if (!record && !existsSync(projectDir)) fail(`no Slack project for “${name}”`);
  // The confirmation is a two-option menu whose default is Cancel, so Enter
  // keeps the app and a stray "y" does nothing at all. Down then Enter picks
  // the destructive option.
  const out = plain(slack(["app", "delete"], { interactive: true, keys: "\u001b[B\r" }));
  // The CLI answers "will not be deleted" when the confirmation is not
  // accepted, and exits 0 either way — so read what it said.
  if (/will not be deleted/i.test(out)) fail(`Slack did not delete it. Run it yourself and confirm:\n  cd ${projectDir} && slack app delete`);
  console.log(`deleted app ${record?.appId ?? "(unknown id)"}`);
  rmSync(projectDir, { recursive: true, force: true });
}

/** `auth.test` as the bot, which is the only honest check that it works. */
function verify(appId: string): { ok: boolean; userId?: string; user?: string; error?: string } {
  const out = plain(slack(["api", "auth.test", "--app", appId]));
  try {
    const parsed = JSON.parse(out.slice(out.indexOf("{"))) as { ok?: boolean; user_id?: string; user?: string; error?: string };
    return { ok: Boolean(parsed.ok), userId: parsed.user_id, user: parsed.user, error: parsed.error };
  } catch {
    return { ok: false, error: out.trim().split("\n").pop() ?? "no answer" };
  }
}

/** The bot scopes this app was installed with — what the token is minted for. */
function manifestScopes(): string[] | undefined {
  const path = join(projectDir, "manifest.json");
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { oauth_config?: { scopes?: { bot?: string[] } } };
    const scopes = parsed.oauth_config?.scopes?.bot;
    return scopes?.length ? scopes : undefined;
  } catch {
    return undefined;
  }
}

/** The token `slack login` stored, for the team this app is installed to. */
function slackUserToken(teamId: string): string | undefined {
  const path = join(process.env.HOME ?? "~", ".slack", "credentials.json");
  if (!existsSync(path)) return undefined;
  try {
    const creds = JSON.parse(readFileSync(path, "utf8")) as Record<string, { token?: string }>;
    return creds[teamId]?.token;
  } catch {
    return undefined;
  }
}

/** Does this app-level token open a Socket Mode connection? */
async function socketModeOk(appToken: string): Promise<boolean> {
  try {
    const res = await fetch("https://slack.com/api/apps.connections.open", {
      method: "POST",
      headers: { Authorization: `Bearer ${appToken}` },
    });
    const json = (await res.json()) as { ok?: boolean; url?: string };
    return Boolean(json.ok && json.url);
  } catch {
    return false;
  }
}

/** Set keys in the .env in place, so comments and ordering survive. */
function writeEnvKeys(path: string, keys: Record<string, string>): void {
  const lines = existsSync(path) ? readFileSync(path, "utf8").split("\n") : [];
  for (const [key, value] of Object.entries(keys)) {
    const line = `${key}=${value}`;
    const at = lines.findIndex((l) => (l.split("=")[0] ?? "").trim() === key);
    if (at >= 0) lines[at] = line;
    else lines.push(line);
  }
  writeFileSync(path, lines.join("\n").replace(/\n+$/, "\n"), { mode: 0o600 });
}