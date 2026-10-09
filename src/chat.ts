/**
 * What a session needs from a chat surface (Discord, Slack). A space is a
 * channel or a thread; each has its own app-server conversation.
 *
 * Text is Discord-flavoured Markdown (`**bold**`, `-# small`, `[text](<url>)`);
 * a surface that renders something else converts it when sending.
 */
import type { Attachment } from "./attachments.ts";

export type Surface = "discord" | "slack";

/** A message the bot posted. */
export interface Posted {
  /** Replace the text (and drop any buttons or menu). */
  edit(text: string): Promise<unknown>;
  delete(): Promise<unknown>;
}

export type Choice = {
  label: string;
  value: string;
  description?: string;
  /** Pre-selected in a menu. */
  default?: boolean;
  style?: "primary" | "danger";
};

/** A pick by an allowed user. */
export interface Picked {
  value: string;
  /** Display name of who picked. */
  user: string;
  /** Chat user id of who picked (the key for per-user grants). */
  userId: string;
  /** Replace the message's text and remove the controls. */
  update(text: string): Promise<unknown>;
}

export interface ChatSpace {
  /** Unique within the surface (Discord: channel or thread id; Slack: `channel` or `channel/thread_ts`). */
  id: string;
  surface: Surface;
  /** "Discord", "Slack": for messages people read. */
  label: string;
  /** Longest message text the surface takes (before conversion). */
  maxLength: number;
  /** Most options a menu can show. */
  maxChoices: number;
  /**
   * Post `text`. `replyTo`: the message it answers (a quoted reply where the
   * surface has them). `files`: attached, or posted right after.
   */
  send(text: string, opts?: { replyTo?: string | null; files?: Attachment[] }): Promise<Posted>;
  /** Show "typing…" where the surface can; else nothing. */
  sendTyping(): Promise<unknown>;
  /**
   * Post `text` with buttons or a menu. `msg` is the posted message;
   * `pick` resolves with the first pick by an allowed user (others are told
   * no) and rejects after `timeoutMs`.
   */
  choose(
    text: string,
    kind: "buttons" | "menu",
    choices: Choice[],
    timeoutMs: number,
    placeholder?: string,
  ): Promise<{ msg: Posted; pick: Promise<Picked> }>;
}
