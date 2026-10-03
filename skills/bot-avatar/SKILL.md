---
name: bot-avatar
description: Design, generate and install a bot's icon — a cartoonish pet face cropped into a circle or squircle, six curated palettes, exported as PNG for Slack or SVG for anywhere else. Use when asked for a better/cuter/emoji-like bot icon, to re-roll a bot's face, or when a bot's Slack icon is the default grey blob.
---

# Bot avatar (v2)

A bot's face is **generated from a seed**, never stored: same seed, same
picture, forever. Two styles:

- `pet` — a cartoonish character face: two big eyes with a highlight each, a
  small smile, blush cheeks, ears cropped by the outline so it reads like a
  sticker or emoji at 24px. This is the default for new bots now.
- `dots` — the OpenAI/Grok dot-grid tile. Plain, abstract, still fine.

Two shapes: `circle` reads as a chat avatar, `squircle` as an app icon.
Slack's app icon should be a squircle; the chat avatar a circle.

Six palettes — `amber teal violet rose slate lime` — curated to stay
distinguishable and to keep white details legible on both gradient stops.
They are not random: a random hue is usually ugly.

## Generate

SVG (what the manager serves, and what the chat shows):

```sh
# HOO_PATHS resolves a path on this machine and this version. Define it
# once, then read a path with: HOO_PATHS selftest
HOO_PATHS() { bash "${HOO_SKILLS:-${HOO_WORKDIR:-$HOME/.hoobot/runtime/shared/workspace}/.cortexcode/skills}"/bot-slack/scripts/paths.sh "$@"; }

curl "http://127.0.0.1:8790/api/avatar.svg?seed=4242&style=pet&shape=squircle&palette=rose"
```

PNG (what Slack's uploader wants):

```sh
bun "$(HOO_PATHS avatar-png)" --name hee --style pet --shape squircle \
  --palette rose --size 512 --out ~/Desktop/hee.png
```

`--name` derives the seed from the name exactly as the manager does, so the
PNG matches the face the bot already has. `--seed` re-rolls. The script
reads hoobot's `avatar.ts` from the published package; set `HOOBOT_SRC` to
point at a checkout.

## Change a bot's saved face

Set the keys in `$(HOO_PATHS runtime)/<name>/.env`, then restart the bot's
config by saving in the manager (the Look group has Avatar seed / shape /
style / colour):

```
HOO_AVATAR_SEED=97432115
HOO_AVATAR_SHAPE=squircle
HOO_AVATAR_STYLE=pet
HOO_AVATAR_PALETTE=rose
```

Re-rolling without a good reason is churn: the seed *is* the bot's identity.
Change it deliberately, and say which bot changed.

## Install it in Slack

**Automated.** A bot's face is its app's icon, and the Slack CLI uploads it
— there is no need for the user to open App Home and click through a form:

```sh
bun "$(HOO_PATHS avatar-png)" --name hee --style pet --shape squircle \
  --palette rose --size 512 --out /tmp/hee.png
bun "$(HOO_PATHS skills)/bot-slack/scripts/slack-app.ts" sync hee --icon /tmp/hee.png
bun "$(HOO_PATHS skills)/bot-slack/scripts/slack-app.ts" verify hee
```

`sync` writes `assets/icon.png` into the Slack project and pushes it; Slack
caches icons hard, so give it a minute before believing a change, and say
so rather than promising it took effect. See `bot-slack`.

## Getting it right

- Look at it at 24px, not just 512. Eyes and mouth are what survive; if the
  face doesn't read small, the crop is wrong.
- One accent, not three. Palette does the colour work.
- Squircle corners: the face must be cropped by the outline, not float
  inside it — that's what makes it read as a character rather than a logo.
- Keep `HOO_AVATAR_PALETTE` and the Slack manifest `background_color` in
  agreement, or the app listing looks broken.