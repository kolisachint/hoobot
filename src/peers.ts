/**
 * Peer bots: other bots (e.g. a companion hoobot) that may call this one.
 *
 * Bots answering bots can loop forever, so each thread has a budget: a
 * peer gets `PEER_TURNS` answers per thread. When it's used up, an allowed
 * user is asked (Yes / No buttons) whether to grant `PEER_TURNS` more.
 * A call from a person in the thread starts a fresh budget.
 */
export class TurnBudget {
  private spaces = new Map<string, { used: number; limit: number }>();

  constructor(readonly turns: number) {}

  private get(space: string) {
    let s = this.spaces.get(space);
    if (!s) {
      s = { used: 0, limit: this.turns };
      this.spaces.set(space, s);
      if (this.spaces.size > 1000) this.spaces.delete(this.spaces.keys().next().value!);
    }
    return s;
  }

  /** Use one peer turn; `false` when the budget is spent (nothing is used). */
  take(space: string): boolean {
    const s = this.get(space);
    if (s.used >= s.limit) return false;
    s.used++;
    return true;
  }

  /** Allow `turns` more peer turns here. */
  grant(space: string): void {
    this.get(space).limit += this.turns;
  }

  /** A person called: start over. */
  reset(space: string): void {
    this.spaces.delete(space);
  }

  used(space: string): number {
    return this.spaces.get(space)?.used ?? 0;
  }
}

/**
 * `@name` for a known peer → a real Slack mention (`<@U123>`), so the model
 * can tag the other bot by name. Runs on mrkdwn (after conversion).
 */
export function linkMentions(mrkdwn: string, peers: Map<string, string>): string {
  if (!peers.size) return mrkdwn;
  // Code (fenced or inline) is left alone.
  return mrkdwn
    .split(/(```[\s\S]*?```|`[^`\n]*`)/)
    .map((part, i) => {
      if (i % 2 === 1) return part;
      for (const [name, id] of peers) {
        const re = new RegExp(`(^|[^\\w<@])@${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`, "gi");
        part = part.replace(re, `$1<@${id}>`);
      }
      return part;
    })
    .join("");
}
