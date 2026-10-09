// A ChatSpace that logs what the session posts, for the e2e scripts.
import type { ChatSpace, Choice, Picked } from "../../src/chat.ts";

export function fakeSpace(
  id: string,
  opts: {
    log: string[];
    uploads?: string[][];
    /** Answer to buttons/menus; none: they time out. */
    pick?: (choices: Choice[]) => string;
    onChoose?: () => void;
  },
): ChatSpace {
  const { log } = opts;
  const posted = () => ({
    edit: async (t: string) => void log.push(`EDIT  ${t}`),
    delete: async () => void log.push("DELETE"),
  });
  return {
    id,
    surface: "discord",
    label: "Discord",
    maxLength: 2000,
    maxChoices: 25,
    async send(text, o = {}) {
      const files = o.files ?? [];
      if (files.length) opts.uploads?.push(files.map((f) => f.name));
      log.push(`SEND  ${text}${files.length ? `  [files: ${files.map((f) => f.name).join(", ")}]` : ""}`);
      return posted();
    },
    sendTyping: async () => {},
    async choose(text, _kind, choices) {
      log.push(`SEND  ${text}  [buttons]`);
      opts.onChoose?.();
      const pick: Promise<Picked> = opts.pick
        ? Promise.resolve({ value: opts.pick(choices), user: "tester", userId: "U-tester", update: async (t: string) => void log.push(`CLICK ${t}`) })
        : Promise.reject(new Error("no choices expected"));
      pick.catch(() => {});
      return { msg: posted(), pick };
    },
  };
}
