# 10 — What a bot is

Status: **decided, revised 2026-09-30** (T1 → R5, R12).
Change: the persona is now a **hoocode profile**. hoobot keeps only
surfaces and routing.

## Decisions

1. **A bot is a persona**, not a connection.
   Persona = system prompt + model + tools/skills + workspace + policy.
2. **Adapters are separate, shared plumbing.**
   One adapter per surface account (e.g. one Discord app token).
3. **One adapter can host many bots**, routed by mention, channel or command.
4. **A bot ships as a hoocode package** and reuses `hoocode install`
   (npm / git / local path).
5. **The persona is a hoocode profile.** hoocode gets a general
   "profile" concept (prompt, model, tools, folders, rules), which is
   useful without hoobot. A hoobot bot = a profile + surface routing.
6. **The package splits in two:**
   - `hoocode.profiles` holds the persona. Installing the package creates
     the profile, and hoocode asks you to grant its tools.
   - `hoobot` holds only surfaces and routing.

## Picture

```
Discord adapter (1 token) ─┬─ @reviewer  → bot "reviewer"
                           └─ @helper    → bot "helper"
Slack adapter   (1 token) ─── /hoo ask   → bot "helper"
```

## Manifest sketch (not final)

Lives in the package's `package.json` next to the existing `hoocode` key:

```jsonc
{
  "name": "@me/hoobot-reviewer",
  "hoocode": {
    "extensions": ["./ext"],
    "skills": ["./skills"],
    "profiles": {                               // read by hoocode
      "reviewer": {
        "systemPrompt": "./prompt.md",
        "model": "...",
        "tools": ["read", "bash"],             // requested; you grant
        "workspace": "own-folder"
      }
    }
  },
  "hoobot": {                                   // read by hoobot only
    "manifestVersion": 1,
    "bots": [{
      "id": "reviewer",
      "profile": "reviewer",
      "displayName": "Reviewer",
      "surfaces": ["discord", "slack"],        // allowed, not required
      "routing": { "mention": true, "commands": ["review"] }
    }]
  }
}
```

## Consequences

- `session.ts` must split: hoocode-session core vs Discord rendering.
- Routing (which bot answers?) belongs to hoobot, not to the bot.
- Tool policy is enforced by **hoocode** through the profile's grants,
  never trusted from the manifest alone.

## Still open

- Exact profile fields, and how they line up with Codex permission
  profiles (`[permissions.<id>]`).
- Routing conflicts (two bots claim the same command).
