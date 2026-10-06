/** Discord hard limit is 2000; leave room for fence repair. */
const LIMIT = 1900;

/**
 * Split text into Discord-sized chunks, preferring line breaks and keeping
 * fenced code blocks valid across chunk boundaries.
 */
export function splitMessage(text: string, limit = LIMIT): string[] {
  const chunks: string[] = [];
  let current = "";
  let openFence: string | null = null; // e.g. "```ts" while inside a block

  const flush = () => {
    if (!current.trim()) return;
    chunks.push(openFence ? current + "\n```" : current);
    current = openFence ? openFence + "\n" : "";
  };

  for (const rawLine of text.split("\n")) {
    // Hard-wrap single lines longer than the limit.
    const pieces: string[] = [];
    for (let i = 0; i < rawLine.length || i === 0; i += limit - 20) {
      pieces.push(rawLine.slice(i, i + limit - 20));
      if (rawLine.length === 0) break;
    }

    for (const line of pieces) {
      const addition = (current ? "\n" : "") + line;
      if (current.length + addition.length > limit) flush();
      current += (current && !current.endsWith("\n") ? "\n" : "") + line;

      const fence = line.trim().match(/^```(\S*)/);
      if (fence) openFence = openFence ? null : "```" + (fence[1] ?? "");
    }
  }
  if (current.trim()) chunks.push(current);
  return chunks.length ? chunks : [""];
}

export function truncate(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? oneLine.slice(0, max - 1) + "…" : oneLine;
}

/** Inline code that survives backticks in the content. */
export function code(text: string): string {
  const clean = text.replace(/`/g, "ˋ");
  return "`" + clean + "`";
}

/** Short human description of a tool call, e.g. "bash `ls -la`". */
export function describeTool(name: string, args: Record<string, any> = {}): string {
  const path = args.path ?? args.file_path;
  switch (name) {
    case "bash":
      return `bash ${code(truncate(String(args.command ?? ""), 120))}`;
    case "read":
    case "edit":
    case "write":
      return `${name} ${code(truncate(String(path ?? "?"), 120))}`;
    case "SearchCodebase":
      return `search ${code(truncate(String(args.query ?? ""), 100))}`;
    case "webfetch":
      return `fetch ${code(truncate(String(args.url ?? ""), 120))}`;
    case "websearch":
      return `web search ${code(truncate(String(args.query ?? ""), 100))}`;
    // Both spellings: `Agent` is canonical since hoocode 0.1.8, `Task` stays
    // registered as a deprecated alias for a release.
    case "Agent":
    case "Task":
      return `agent ${code(truncate(String(args.description ?? args.subagent_type ?? ""), 80))}`;
    case "AgentOut":
    case "TaskOutput":
      return `agentout ${code(truncate(String(args.list ? "list" : (args.task_id ?? "all")), 80))}`;
    default:
      return code(name);
  }
}

/** Plain text of an assistant message's text blocks. */
export function assistantText(message: any): string {
  if (!message || !Array.isArray(message.content)) return "";
  return message.content
    .filter((c: any) => c?.type === "text" && typeof c.text === "string")
    .map((c: any) => c.text)
    .join("\n\n")
    .trim();
}
