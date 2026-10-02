/**
 * Discord-flavoured Markdown (what the session writes and the model answers
 * in) → Slack mrkdwn.
 *
 * - `**bold**` → `*bold*`, `*italic*` / `_italic_` → `_italic_`, `~~x~~` → `~x~`
 * - `# Heading` → `*Heading*`, `-# small` → plain line
 * - `[text](<url>)` / `[text](url)` → `<url|text>`; bare URLs stay as they are
 * - fenced code keeps its fence, minus the language (Slack shows it as text)
 * - `&`, `<`, `>` are escaped everywhere, as Slack requires
 */

const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Bold/italic markers become these while converting, so `*x*` from `**x**` isn't read as italic. */
const B = "\u0001";

export function toMrkdwn(md: string): string {
  const out: string[] = [];
  let inFence = false;
  for (const line of md.split("\n")) {
    const fence = line.trim().match(/^```/);
    if (fence) {
      // Slack has no language tags: ```ts → ```
      out.push(inFence ? "```" : "```");
      inFence = !inFence;
      continue;
    }
    out.push(inFence ? escape(line) : convertLine(line));
  }
  return out.join("\n");
}

function convertLine(line: string): string {
  const heading = line.match(/^#{1,6}\s+(.*)$/);
  if (heading) return wrapBold(inline(heading[1]!));
  const small = line.match(/^-#\s+(.*)$/);
  if (small) return inline(small[1]!);
  return inline(line);
}

/** A whole line in bold, unless it's bold already. */
function wrapBold(text: string): string {
  return /^\*[^*]+\*$/.test(text) ? text : `*${text}*`;
}

/** Inline formatting outside code spans; code spans are only escaped. */
function inline(text: string): string {
  return text
    .split(/(`[^`]*`)/)
    .map((part, i) => (i % 2 === 1 ? escape(part) : prose(part)))
    .join("");
}

function prose(text: string): string {
  const links: string[] = [];
  // Links first (their text and URL must not be touched by escaping or emphasis).
  let s = text.replace(/\[([^\]]+)\]\(<?([^)\s>]+)>?\)/g, (_, label: string, url: string) => {
    links.push(`<${url.replace(/[<>|]/g, encodeURIComponent)}|${escape(label).replace(/\|/g, "¦")}>`);
    return `\u0002${links.length - 1}\u0002`;
  });
  // Slack mentions (`<@U123>`) stay as they are, so a bot can tag another.
  const mentions: string[] = [];
  s = s.replace(/<@([UW][A-Z0-9]+)>/g, (m) => {
    mentions.push(m);
    return `\u0003${mentions.length - 1}\u0003`;
  });
  s = escape(s);
  s = s
    .replace(/\*\*(?=\S)(.+?)(?<=\S)\*\*/g, `${B}$1${B}`)
    .replace(/__(?=\S)(.+?)(?<=\S)__/g, `${B}$1${B}`)
    .replace(/(^|[^\w*])\*(?=\S)([^*]+?)(?<=\S)\*(?![\w*])/g, "$1_$2_")
    .replace(/~~(?=\S)(.+?)(?<=\S)~~/g, "~$1~")
    .replaceAll(B, "*");
  return s
    .replace(/\u0002(\d+)\u0002/g, (_, i: string) => links[Number(i)]!)
    .replace(/\u0003(\d+)\u0003/g, (_, i: string) => mentions[Number(i)]!);
}

/**
 * Slack message text (as typed by people) → plain text for the model:
 * `<@U1>` → `@name`, `<#C1|dev>` → `#dev`, `<url|text>` → `text (url)`,
 * entities unescaped. `name` resolves user ids (unknown ones stay as ids).
 */
export function fromMrkdwn(text: string, name: (userId: string) => string | undefined = () => undefined): string {
  return text
    .replace(/<@([UW][A-Z0-9]+)(?:\|([^>]+))?>/g, (_, id: string, label?: string) => `@${label ?? name(id) ?? id}`)
    .replace(/<#([CG][A-Z0-9]+)(?:\|([^>]*))?>/g, (_, id: string, label?: string) => `#${label || id}`)
    .replace(/<!(here|channel|everyone)(?:\|[^>]*)?>/g, "@$1")
    .replace(/<!subteam\^[A-Z0-9]+(?:\|([^>]+))?>/g, (_, label?: string) => label ?? "@group")
    .replace(/<(https?:[^>|]+)\|([^>]+)>/g, (_, url: string, label: string) => (label === url ? url : `${label} (${url})`))
    .replace(/<(https?:[^>]+|mailto:[^>]+)>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}
