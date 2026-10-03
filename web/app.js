// The bot manager page.
//
// One module, no framework, no build. The whole state is the JSON from
// GET /api/manager, re-read every couple of seconds; anything the user
// changes is a small request and then a re-read, so the UI never has its
// own idea of what a bot is doing.

const POLL_MS = 2500;

const state = {
  data: null,
  selected: null,
  /** The instance (and field set) the settings form was drawn from, so a poll can't redraw it. */
  formFor: null,
  /** Bots whose .env changed while they ran: they read it only when they start. */
  needsRestart: new Set(),
  /** The manager stopped answering; what's on screen may be stale. */
  offline: false,
};

const $ = (id) => document.getElementById(id);

function node(tag, props = {}, kids = []) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") n.className = v;
    else if (k === "text") n.textContent = v;
    else if (k === "html") n.innerHTML = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined && v !== false) n.setAttribute(k, v === true ? "" : String(v));
  }
  for (const kid of [].concat(kids)) if (kid) n.append(kid);
  return n;
}

// ------------------------------------------------------------------- fetch

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await res.text();
  let body = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { error: text };
  }
  if (!res.ok) throw new Error(body.error || `${res.status} ${res.statusText}`);
  return body;
}

let toastTimer;
function toast(message) {
  const t = $("toast");
  t.textContent = message;
  t.hidden = false;
  // Screen readers hear it from a region that is always in the page; one
  // that appears together with its text is often not announced.
  $("announce").textContent = message;
  clearTimeout(toastTimer);
  // Long enough to read: about a second per five words, never under 3 s.
  toastTimer = setTimeout(() => (t.hidden = true), Math.max(3000, message.split(/\s+/).length * 220));
}

function fail(err) {
  toast(err instanceof Error ? err.message : String(err));
}

function setOffline(err) {
  const offline = !!err;
  const banner = $("offline");
  if (offline) banner.textContent = `Can't reach the manager on ${location.host}. Is \`hoobot manager\` still running? Retrying…`;
  if (offline !== state.offline) banner.hidden = !offline;
  document.body.classList.toggle("stale", offline);
  state.offline = offline;
}

/**
 * A sleeping Mac doesn't stop the bots, it silences them: they freeze, and
 * Slack delivers nothing to a socket nobody is reading. `scripts/runtime.sh`
 * wraps each bot in `caffeinate -i`, so this only shows when a running bot is
 * being supervised some other way and nothing is holding the Mac awake.
 */
function setSleepWarning() {
  const banner = $("sleep");
  const power = state.data.power;
  if (!power?.darwin || power.held || !state.data.instances.some((i) => i.running)) {
    banner.hidden = true;
    return;
  }
  banner.replaceChildren(
    node("strong", { text: "This Mac will sleep, and your bots go quiet with it." }),
    document.createTextNode(
      " While it sleeps they are frozen and no chat message reaches them — a sleeping bot looks like nobody is talking to it. Start Amphetamine (or any sleep keeper), or start bots with scripts/runtime.sh, which holds the Mac awake while a bot runs.",
    ),
  );
  banner.hidden = false;
}

async function refresh() {
  try {
    state.data = await api("/api/manager");
    setOffline(null);
  } catch (err) {
    setOffline(err);
    return;
  }
  setSleepWarning();
  const names = state.data.instances.map((i) => i.name);
  if (state.selected && !names.includes(state.selected)) state.selected = null;
  if (!state.selected && names.length) {
    state.selected = fromHash() ?? names[0];
    history.replaceState(null, "", `#${encodeURIComponent(state.selected)}`);
  }
  for (const name of state.needsRestart) {
    if (!state.data.instances.find((i) => i.name === name)?.running) state.needsRestart.delete(name);
  }
  renderList();
  renderDetail();
}

function fromHash() {
  let name;
  try {
    name = decodeURIComponent(location.hash.slice(1));
  } catch {
    return null; // a hand-typed "#%" isn't a bot
  }
  return state.data?.instances.some((i) => i.name === name) ? name : null;
}

// ------------------------------------------------------------------- list

function statusOf(instance) {
  if (!instance.running) return { dot: "", short: "Stopped", text: "Stopped" };
  const health = instance.health;
  if (!health) return { dot: "bad", short: "No health", text: "Running · no answer on its health port" };
  if (health.ok) return { dot: "on", short: "Connected", text: "Running · every chat connected" };
  const bad = (health.surfaces || []).filter((s) => s.state !== "connected");
  return {
    dot: "bad",
    short: bad.length ? `${bad[0].name} ${bad[0].state}` : "Running",
    text: bad.length ? `Running · ${bad[0].name} is ${bad[0].state}` : "Running",
  };
}

/**
 * Rows are kept and updated in place, keyed by name: rebuilding them on
 * every poll would throw keyboard focus off the list every 2.5 seconds.
 */
function renderList() {
  const list = $("bots");
  const rows = new Map([...list.querySelectorAll("li[data-name]")].map((li) => [li.dataset.name, li]));
  list.querySelector("li.empty")?.remove();

  let previous = null;
  for (const instance of state.data.instances) {
    let li = rows.get(instance.name);
    rows.delete(instance.name);
    if (!li) li = newRow(instance);
    updateRow(li, instance);
    const wanted = previous ? previous.nextSibling : list.firstChild;
    if (wanted !== li) list.insertBefore(li, wanted);
    previous = li;
  }
  for (const li of rows.values()) li.remove();

  if (!state.data.instances.length) {
    list.append(node("li", { class: "hint empty", style: "padding:8px 10px", text: "No bots yet." }));
  }
  $("runtime-note").textContent = state.data.runtimeDir;
}

function newRow(instance) {
  return node(
    "li",
    { "data-name": instance.name },
    node("button", { class: "bot", type: "button", onclick: () => select(instance.name) }, [
      node("img", { alt: "" }),
      node("div", { class: "bot-text" }, [node("div", { class: "bot-name", text: instance.name }), node("div", { class: "bot-meta" })]),
      node("span", { class: "dot" }),
    ]),
  );
}

function updateRow(li, instance) {
  const status = statusOf(instance);
  const where = instance.surfaces.length ? instance.surfaces.join(" · ") : "no chat yet";
  const button = li.firstChild;
  const on = state.selected === instance.name;
  button.classList.toggle("on", on);
  if (on) button.setAttribute("aria-current", "true");
  else button.removeAttribute("aria-current");
  button.title = `${instance.name} — ${status.text}`;
  setIf(button.querySelector(".bot-meta"), "textContent", `${where} · ${status.short}`);
  const img = button.querySelector("img");
  setIf(img, "className", instance.avatarShape);
  const src = avatarUrl(instance);
  if (img.getAttribute("src") !== src) img.setAttribute("src", src);
  setIf(button.querySelector(".dot"), "className", `dot ${status.dot}`);
}

/** Assign only on change: a no-op write still costs a style recalc. */
function setIf(el, prop, value) {
  if (el[prop] !== value) el[prop] = value;
}

/** Versioned by seed and shape, so a re-rolled face shows without a reload. */
function avatarUrl(instance) {
  return `/api/instances/${instance.name}/avatar.svg?v=${instance.avatarSeed}-${instance.avatarShape}-${instance.avatarStyle}-${instance.avatarPalette}`;
}

// ----------------------------------------------------------------- detail

function current() {
  return state.data?.instances.find((i) => i.name === state.selected) ?? null;
}

function select(name) {
  if (pending.size) flush();
  state.selected = name;
  state.formFor = null;
  // The address names the bot, so a reload or a bookmark comes back to it.
  history.replaceState(null, "", `#${encodeURIComponent(name)}`);
  renderList();
  renderDetail();
}

/** Bots that failed to start, until they come up connected. */
const failures = new Set();

function renderDetail() {
  const instance = current();
  $("detail").hidden = !instance;
  $("placeholder").hidden = !!instance;
  if (!instance) {
    const none = !state.data?.instances.length;
    $("placeholder-title").textContent = none ? "No bots yet" : "No bot selected";
    $("placeholder-sub").textContent = none
      ? "Press New bot to make one: a name, a face and the chat it joins. Tokens can come later."
      : "Pick one on the left, or make a new one.";
    return;
  }

  const avatar = $("d-avatar");
  const src = avatarUrl(instance);
  if (avatar.getAttribute("src") !== src) avatar.setAttribute("src", src);
  setIf(avatar, "className", `avatar-xl ${instance.avatarShape}`);
  setIf($("d-name"), "textContent", instance.name);

  const status = statusOf(instance);
  const when = instance.health?.lastMessageAt ? ` · last message ${ago(instance.health.lastMessageAt)}` : "";
  setIf($("d-status"), "textContent", `${status.text}${when}`);
  setIf($("d-port"), "textContent", `health port ${instance.port}`);

  const toggle = $("btn-toggle");
  if (!toggle.dataset.busy) {
    setIf(toggle, "textContent", instance.running ? "Stop" : "Start");
    // Stop isn't destructive; red is kept for Delete.
    toggle.classList.toggle("primary", !instance.running);
  }
  $("restart-chip").hidden = !(instance.running && state.needsRestart.has(instance.name));

  if (instance.running && status.dot === "on") failures.delete(instance.name);
  const failing = failures.has(instance.name) || status.dot === "bad";
  $("log-card").classList.toggle("alert", failing);
  setIf($("log-title"), "textContent", failing ? "Why it isn't working" : "Activity");

  renderHealth(instance);
  const del = $("btn-delete");
  if (del) {
    del.disabled = instance.running;
    setIf(del, "textContent", instance.running ? "Stop the bot to delete it" : "Delete this bot");
  }
  const formKey = `${instance.name}|${instance.fields.map((f) => f.key).join(",")}`;
  if (state.formFor !== formKey) {
    // A redraw (say, a chat was ticked and its token boxes appeared) keeps focus where it was.
    const focusedKey = document.activeElement?.dataset?.key;
    renderSettings(instance, formKey);
    if (focusedKey) fieldFor(focusedKey)?.focus();
  } else syncSettings(instance);
  renderLog(instance);
}

function duration(secs) {
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)} min`;
  if (secs < 86400) return `${Math.floor(secs / 3600)} h ${Math.floor((secs % 3600) / 60)} min`;
  return `${Math.floor(secs / 86400)} d ${Math.floor((secs % 86400) / 3600)} h`;
}

function ago(iso) {
  const secs = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.round(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.round(secs / 3600)}h ago`;
  return `${Math.round(secs / 86400)}d ago`;
}

function renderHealth(instance) {
  const grid = $("health-grid");
  const health = instance.health;
  const items = [];

  const wide = [];
  if (health?.surfaces?.length) {
    items.push([
      "chats",
      node("span", { class: `dot ${health.ok ? "on" : "bad"}` }),
      ` ${health.surfaces.map((s) => `${s.name} ${s.state}`).join(" · ")}`,
    ]);
  }
  if (health?.model) items.push(["model", null, health.model]);
  if (health?.approvals) items.push(["approvals", null, health.approvals]);
  if (!instance.running) items.push(["state", null, "Stopped. Press Start to run it."]);
  else items.push(["pid", null, String(instance.pid)]);
  if (health) items.push(["up", null, duration(Math.round(health.uptimeSec))]);
  if (health?.sessions?.length) {
    wide.push(["live threads", health.sessions.map((s) => `${s.key}${s.busy ? " (busy)" : ""}`).join(", ")]);
  }
  // Paths are long; give them a whole row rather than three wrapped lines.
  if (instance.workdir) wide.push(["working folder", instance.workdir]);
  if (health?.workdir && health.workdir !== instance.workdir) wide.push(["running in", health.workdir]);

  grid.replaceChildren(
    ...[...items, ...wide.map(([k, v]) => [k, null, v, true])].map(([k, dot, v, full]) =>
      node("div", { class: `status-item${full ? " full" : ""}` }, [
        node("div", { class: "k", text: k }),
        node("div", { class: `v${full ? " mono" : ""}` }, [dot, v]),
      ]),
    ),
  );
}

// --------------------------------------------------------------- settings

function renderSettings(instance, formKey) {
  const form = $("settings");
  // Redrawing the same bot (a chat was ticked) keeps the groups as they were.
  const sameBot = state.formFor?.split("|")[0] === instance.name;
  const wasOpen = new Set([...form.querySelectorAll("details[open] h3")].map((h) => h.firstChild?.textContent));
  form.replaceChildren(
    ...state.data.groups
      .map((group) => {
        const fields = instance.fields.filter((f) => f.group === group);
        if (!fields.length) return null;
        const open = sameBot ? wasOpen.has(group) : !["Advanced", "Look"].includes(group);
        return node("details", { class: "group", ...(open ? { open: true } : {}) }, [
          node("summary", {}, [node("h3", {}, [group, node("span", { class: "count", text: `${fields.length}` })])]),
          node("div", { class: "group-body" }, fields.map((field) => renderField(instance, field))),
        ]);
      })
      .filter(Boolean),
  );

  form.append(
    node("section", { class: "group" }, [
      node("h3", { text: "Danger zone" }),
      node(
        "button",
        {
          class: "btn danger",
          id: "btn-delete",
          type: "button",
          onclick: () => removeBot(instance.name),
          disabled: instance.running,
        },
        instance.running ? "Stop the bot to delete it" : "Delete this bot",
      ),
    ]),
  );
  state.formFor = formKey;
}

/** Push server values into inputs the user isn't typing in. */
function syncSettings(instance) {
  for (const input of $("settings").querySelectorAll("[data-key]")) {
    if (document.activeElement === input || input.dataset.touched) continue;
    const key = input.dataset.key;
    // `HOO_SURFACES:slack` is one chat's box, not a key in the file.
    if (key.includes(":")) {
      const [, choice] = key.split(":");
      input.checked = instance.surfaces.includes(choice);
      input.disabled = (instance.tokenSurfaces ?? []).includes(choice);
    } else if (key in instance.secrets) {
      // The token itself is never in the page; only whether one is set.
      const row = input.closest(".field");
      const label = row?.querySelector(".current");
      if (label) setIf(label, "textContent", currentToken(instance.secrets[key]));
      const clear = row?.querySelector(".clear");
      if (clear) clear.disabled = !instance.secrets[key];
    } else if (input.type === "checkbox") {
      input.checked = (instance.config[key] ?? "").toLowerCase() === "true";
    } else if (input.value !== (instance.config[key] ?? "")) {
      input.value = instance.config[key] ?? "";
    }
  }
}

function renderField(instance, field) {
  const id = `f-${field.key}`;
  let input;

  if (field.kind === "multi") {
    // Seeded from what the bot actually is (tokens win), so the toggles never
    // claim a chat is off when its token is right there in the file.
    // A chat with tokens can't be switched off here (the tokens would still
    // connect it); its box is locked and says why instead of pretending.
    const picked = new Set(instance.surfaces);
    const locked = new Set(instance.tokenSurfaces ?? []);
    const names = { slack: "Slack", discord: "Discord" };
    const boxes = (field.choices ?? []).map((choice) =>
      node("label", { class: "toggle", title: locked.has(choice) ? `Clear its tokens to switch ${names[choice] ?? choice} off.` : "" }, [
        node("input", {
          type: "checkbox",
          "data-key": `${field.key}:${choice}`,
          ...(picked.has(choice) ? { checked: true } : {}),
          ...(locked.has(choice) ? { disabled: true } : {}),
          onchange: (e) => {
            e.target.dataset.touched = "1";
            const chosen = [...$("settings").querySelectorAll(`[data-key^="${field.key}:"]`)]
              .filter((box) => box.checked)
              .map((box) => box.dataset.key.split(":")[1]);
            // The form redraws once the server answers with the new token boxes.
            queueSave(instance.name, field.key, chosen.join(","), { now: true });
          },
        }),
        node("span", { text: names[choice] ?? choice }),
      ]),
    );
    return node("div", { class: "field", role: "group", "aria-label": field.label }, [
      node("span", { class: "label", text: field.label }),
      ...boxes,
      node("span", { class: "hint", text: field.hint ?? "" }),
    ]);
  }

  if (field.kind === "toggle") {
    const on = (instance.config[field.key] ?? "false").toLowerCase() === "true";
    input = node("input", { type: "checkbox", id, "data-key": field.key, ...(on ? { checked: true } : {}) });
    input.addEventListener("change", () => {
      input.dataset.touched = "1";
      queueSave(instance.name, field.key, String(input.checked), { now: true });
    });
    return node("div", { class: "field" }, [
      node("label", { class: "toggle", for: id }, [input, node("span", { text: field.label })]),
      node("span", { class: "hint", text: field.hint ?? "" }),
    ]);
  }

  if (field.kind === "select") {
    input = node(
      "select",
      { id, "data-key": field.key, "data-kind": field.kind },
      (field.choices ?? []).map((c) => node("option", { value: c, ...(c === (instance.config[field.key] ?? "") ? { selected: true } : {}) }, [c])),
    );
  } else if (field.kind === "number") {
    input = node("input", { type: "number", id, "data-key": field.key, "data-kind": field.kind, min: field.min ?? "", max: field.max ?? "" });
    input.value = instance.config[field.key] ?? "";
  } else if (field.kind === "secret") {
    return secretField(instance, field, id);
  } else {
    input = node("input", { type: "text", id, "data-key": field.key, "data-kind": field.kind, spellcheck: "false" });
    input.value = instance.config[field.key] ?? "";
  }

  const hint = node("span", { class: "hint", id: `${id}-hint`, text: field.hint ?? "" });
  input.setAttribute("aria-describedby", hint.id);
  input.addEventListener(field.kind === "select" ? "change" : "input", () => {
    input.dataset.touched = "1";
    queueSave(instance.name, field.key, input.value);
  });
  return node("div", { class: "field" }, [node("label", { class: "label", for: id, text: field.label }), input, hint]);
}

function currentToken(masked) {
  return masked ? `set: ${masked}` : "not set";
}

/**
 * A token box starts empty; what's saved is shown beside it, masked. A new
 * token is saved when you leave the box (or press Enter), not on every key,
 * so half a pasted token is never written. Clearing is its own button, so an
 * empty box never means "delete" by accident.
 */
function secretField(instance, field, id) {
  const masked = instance.secrets[field.key] ?? "";
  const hint = node("span", { class: "hint", id: `${id}-hint`, text: field.hint ?? "" });
  const input = node("input", {
    type: "password",
    id,
    "data-key": field.key,
    "data-kind": field.kind,
    autocomplete: "off",
    spellcheck: "false",
    "aria-describedby": hint.id,
    placeholder: masked ? "Paste a new token to replace it" : field.placeholder || "Paste the token",
  });
  const save = () => {
    const value = input.value.trim();
    if (!value) return;
    if (value.includes("\u2022")) {
      hint.textContent = "That's the masked copy, not a token. Paste the real one.";
      hint.classList.add("err");
      return;
    }
    hint.textContent = field.hint ?? "";
    hint.classList.remove("err");
    queueSave(instance.name, field.key, value, { now: true });
  };
  input.addEventListener("input", () => (input.dataset.touched = input.value ? "1" : ""));
  input.addEventListener("change", save);
  input.addEventListener("keydown", (e) => e.key === "Enter" && save());
  const current = node("span", { class: "current", text: currentToken(masked) });
  const clear = node("button", {
    class: "btn ghost tiny clear",
    type: "button",
    text: "Clear",
    "aria-label": `Clear the ${field.label.toLowerCase()}`,
    disabled: !masked,
    onclick: () => {
      if (!confirm(`Clear the ${field.label.toLowerCase()}? The bot won't connect to that chat until a new one is pasted.`)) return;
      queueSave(instance.name, field.key, "", { now: true });
    },
  });
  return node("div", { class: "field" }, [
    node("label", { class: "label", for: id, text: field.label }),
    node("div", { class: "secret-row" }, [input, current, clear]),
    hint,
  ]);
}

// One save in flight per key; edits in the same field collapse into one.
const pending = new Map();
let saveTimer;

function fieldFor(key) {
  return [...$("settings").querySelectorAll("[data-key]")].find((i) => i.dataset.key === key);
}

function queueSave(name, key, value, opts = {}) {
  // Whether a field is a secret is the server's call, not a guess here.
  pending.set(`${name}:${key}`, { name, key, value, secret: fieldFor(key)?.dataset.kind === "secret" });
  saveHint("Saving\u2026");
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, opts.now ? 0 : 500);
}

let savedAt = 0;
let hintTimer;

function saveHint(text, error = false) {
  const hint = $("save-hint");
  hint.textContent = text;
  hint.classList.toggle("err", error);
  clearInterval(hintTimer);
  // "Saved 2 min ago" stays true; a bare "Saved" would be stale in a minute.
  if (!error && savedAt && text.startsWith("Saved")) {
    hintTimer = setInterval(() => (hint.textContent = `Saved ${ago(savedAt)}`), 15000);
  }
}

/**
 * Send what's queued. With `keepalive` (the tab is closing) the requests
 * outlive the page, which a plain fetch would not.
 */
async function flush({ keepalive = false } = {}) {
  clearTimeout(saveTimer);
  const batch = [...pending.values()];
  pending.clear();
  let failed = null;
  for (const { name, key, value, secret } of batch) {
    const body = secret ? { secrets: { [key]: value } } : { config: { [key]: value } };
    if (keepalive) {
      fetch(`/api/instances/${name}`, { method: "PATCH", keepalive: true, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      continue;
    }
    try {
      const saved = await api(`/api/instances/${name}`, { method: "PATCH", body });
      if (saved.skipped?.includes(key)) throw new Error("that was the masked copy, not the token.");
      // The form on screen may already be another bot's (select() flushes
      // on the way out); only this bot's fields are this save's to reset.
      if (name === state.selected) {
        for (const field of $("settings").querySelectorAll("[data-key]")) {
          if (field.dataset.key !== key && !field.dataset.key.startsWith(`${key}:`)) continue;
          field.dataset.touched = "";
          // The browser never keeps a token once it's saved.
          if (secret) field.value = "";
        }
      }
      if (saved.running) state.needsRestart.add(name);
    } catch (err) {
      failed = err instanceof Error ? err.message : String(err);
    }
  }
  if (!batch.length || keepalive) return;
  if (failed) saveHint(`Not saved: ${failed}`, true);
  else {
    savedAt = Date.now();
    saveHint(state.needsRestart.has(batch[0].name) ? "Saved. Restart to apply." : "Saved just now");
  }
  await refresh();
}

// ------------------------------------------------------------------ logs

let logTimer;

function renderLog(instance) {
  $("log-meta").textContent = instance.running || instance.pid ? "" : "starts when you press Start";
  if (logTimer) return;
  logTimer = setTimeout(async () => {
    logTimer = null;
    try {
      const { lines } = await api(`/api/instances/${instance.name}/logs?lines=120`);
      const box = $("log");
      const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 8;
      box.textContent = lines || "No log yet.";
      if (atBottom) box.scrollTop = box.scrollHeight;
    } catch {
      /* the next poll will try again */
    }
  }, 400);
}

// --------------------------------------------------------------- actions

const BUSY = { start: "Starting\u2026", stop: "Stopping\u2026", restart: "Restarting\u2026" };

let controlling = false;

async function control(name, action) {
  // One start/stop/restart at a time, by button or by shortcut.
  if (controlling) return;
  controlling = true;
  $("btn-toggle").disabled = true;
  $("btn-restart").disabled = true;
  if (pending.size) await flush();
  const button = action === "restart" ? $("btn-restart") : $("btn-toggle");
  const label = button.textContent;
  button.dataset.busy = "1";
  button.textContent = BUSY[action];
  try {
    // A bot that won't boot is a 500 with the script's output: an answer,
    // not a lost request, so it is read here rather than thrown.
    const res = await fetch(`/api/instances/${name}/${action}`, { method: "POST" })
      .then((r) => r.json())
      .catch(() => ({ ok: false, unreachable: true }));
    if (res.unreachable) {
      toast(`Couldn't reach the manager to ${action} ${name}.`);
    } else if (!res.ok) {
      // The reason is in the log, which now leads as "Why it isn't working".
      failures.add(name);
      toast(`${name} didn't ${action}. The log says why.`);
    } else {
      failures.delete(name);
      if (action !== "stop") state.needsRestart.delete(name);
      toast(`${name} ${action === "restart" ? "restarted" : action === "start" ? "started" : "stopped"}`);
    }
  } catch (err) {
    fail(err);
  } finally {
    controlling = false;
    $("btn-toggle").disabled = false;
    $("btn-restart").disabled = false;
    delete button.dataset.busy;
    button.textContent = label;
    await refresh();
  }
}

async function removeBot(name) {
  if (!confirm(`Delete ${name}? Its folder, tokens and logs go. The working folder stays.`)) return;
  try {
    await api(`/api/instances/${name}`, { method: "DELETE" });
    state.selected = null;
    state.formFor = null;
    history.replaceState(null, "", location.pathname);
    toast(`${name} deleted`);
  } catch (err) {
    fail(err);
  }
  await refresh();
}

// ------------------------------------------------------------- new bot

const draft = { name: "", seed: 0, shape: "circle", style: "dots", palette: "", surfaces: new Set(["slack"]), tokens: {} };

function avatarPreview() {
  // No seed means "derive one from the name", which the server does, so the
  // preview is the face that gets saved rather than a lookalike.
  const q = new URLSearchParams({ shape: draft.shape, style: draft.style });
  if (draft.seed) q.set("seed", String(draft.seed));
  else if (draft.name) q.set("name", draft.name);
  if (draft.palette) q.set("palette", draft.palette);
  $("n-avatar").src = `/api/avatar.svg?${q}`;
}

async function rerollName() {
  let name;
  try {
    ({ name } = await api(`/api/names/suggest?seed=${Math.random()}`));
  } catch (err) {
    return fail(err);
  }
  draft.name = name;
  $("n-name").value = name;
  draft.seed = 0; // let the name decide the face
  avatarPreview();
  validateName();
}

function validateName() {
  const hint = $("n-name-hint");
  const name = draft.name.trim();
  const taken = state.data.instances.some((i) => i.name === name);
  if (!name) hint.textContent = "Lowercase, dashes, no spaces.";
  else if (taken) hint.textContent = `There is already a bot called ${name}.`;
  else if (!/^[a-z][a-z0-9-]{0,23}$/.test(name)) hint.textContent = "Lowercase letters, numbers and dashes, starting with a letter.";
  else hint.textContent = "This is what you mention in the chat.";
  return !!name && !taken && /^[a-z][a-z0-9-]{0,23}$/.test(name);
}

function renderSwatches() {
  // Redrawn on every pick: keep focus on the swatch that was pressed.
  const focused = document.activeElement?.dataset?.palette;
  $("n-palette").replaceChildren(
    node("button", {
      class: `swatch auto${draft.palette === "" ? " on" : ""}`,
      type: "button",
      title: "Let the name pick the colour",
      "aria-label": "Automatic colour",
      "aria-pressed": String(draft.palette === ""),
      "data-palette": "",
      onclick: () => {
        draft.palette = "";
        renderSwatches();
        avatarPreview();
      },
    }),
    ...state.data.palettes.map((p) =>
      node("button", {
        class: `swatch${draft.palette === p.id ? " on" : ""}`,
        type: "button",
        title: p.label,
        "aria-label": p.label,
        "aria-pressed": String(draft.palette === p.id),
        "data-palette": p.id,
        style: `background:linear-gradient(135deg,${p.from},${p.to})`,
        onclick: () => {
          draft.palette = draft.palette === p.id ? "" : p.id;
          renderSwatches();
          avatarPreview();
        },
      }),
    ),
  );
  if (focused !== undefined) $("n-palette").querySelector(`[data-palette="${focused}"]`)?.focus();
}

function renderSurfaces() {
  const surfaces = [
    { id: "slack", label: "Slack", fields: ["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN"] },
    { id: "discord", label: "Discord", fields: ["DISCORD_TOKEN", "GUILD_ID"] },
  ];
  $("n-surfaces").replaceChildren(
    ...surfaces.map((s) =>
      node(
        "button",
        {
          class: `choice${draft.surfaces.has(s.id) ? " on" : ""}`,
          type: "button",
          "aria-pressed": String(draft.surfaces.has(s.id)),
          "data-surface": s.id,
          onclick: () => {
            draft.surfaces.has(s.id) ? draft.surfaces.delete(s.id) : draft.surfaces.add(s.id);
            renderSurfaces();
            $("n-surfaces").querySelector(`[data-surface="${s.id}"]`)?.focus();
          },
        },
        [s.label],
      ),
    ),
  );

  const wanted = surfaces.filter((s) => draft.surfaces.has(s.id)).flatMap((s) => s.fields);
  const fields = state.data.fields.filter((f) => wanted.includes(f.key));
  $("n-tokens").replaceChildren(
    ...fields.map((f) => {
      const input = node("input", {
        type: f.kind === "secret" ? "password" : "text",
        id: `n-${f.key}`,
        spellcheck: "false",
        autocomplete: "off",
        placeholder: f.placeholder ?? "",
        oninput: (e) => (draft.tokens[f.key] = e.target.value),
      });
      input.value = draft.tokens[f.key] ?? "";
      return node("label", { class: "field", for: `n-${f.key}` }, [
        node("span", { class: "label", text: f.label }),
        input,
        node("span", { class: "hint", text: f.hint ?? "" }),
      ]);
    }),
  );
  $("n-token-hint").textContent = draft.surfaces.size
    ? "Tokens can wait: the bot starts and tells you it isn't connected until you add them."
    : "Pick at least one chat.";
}

function openSheet() {
  if (!state.data) return toast("The manager isn't answering yet.");
  draft.name = "";
  draft.palette = "";
  draft.shape = "circle";
  draft.style = "dots";
  draft.seed = Math.floor(Math.random() * 1e9);
  draft.tokens = {};
  $("n-name").value = "";
  $("n-workdir").value = state.data.sharedWorkdir;
  $("n-error").textContent = "";
  setShape(draft.shape);
  setStyle(draft.style);
  renderSwatches();
  renderSurfaces();
  avatarPreview();
  $("sheet").hidden = false;
  // The page behind is out of reach while the sheet is up.
  $("app").inert = true;
  $("n-name").focus();
}

function setShape(shape) {
  for (const b of $("n-shape").querySelectorAll("button")) {
    b.classList.toggle("on", b.dataset.shape === shape);
    b.setAttribute("aria-pressed", String(b.dataset.shape === shape));
  }
}

function setStyle(style) {
  for (const b of $("n-style").querySelectorAll("button")) {
    b.classList.toggle("on", b.dataset.style === style);
    b.setAttribute("aria-pressed", String(b.dataset.style === style));
  }
}

/** True once anything worth keeping has been typed into the sheet. */
function draftTouched() {
  return Object.values(draft.tokens).some((v) => v.trim()) || $("n-name").value.trim() !== "";
}

function closeSheet({ force = false } = {}) {
  if ($("sheet").hidden) return;
  if (!force && Object.values(draft.tokens).some((v) => v.trim()) && !confirm("Close without creating the bot? The tokens you pasted will be lost.")) return;
  $("sheet").hidden = true;
  $("app").inert = false;
  $("new-bot").focus();
}

async function createBot() {
  const error = $("n-error");
  if (!validateName()) {
    error.textContent = "That name won't work.";
    return;
  }
  if (!draft.surfaces.size) {
    error.textContent = "Pick at least one chat.";
    return;
  }
  const button = $("n-create");
  button.disabled = true;
  try {
    const instance = await api("/api/instances", {
      method: "POST",
      body: {
        name: draft.name,
        surfaces: [...draft.surfaces],
        workdir: $("n-workdir").value.trim(),
        avatarSeed: draft.seed,
        avatarShape: draft.shape,
        avatarStyle: draft.style,
        avatarPalette: draft.palette,
        secrets: draft.tokens,
      },
    });
    closeSheet({ force: true });
    select(instance.name);
    toast(`${instance.name} created — add its tokens, then Start`);
    await refresh();
  } catch (err) {
    error.textContent = err instanceof Error ? err.message : String(err);
  } finally {
    button.disabled = false;
  }
}

// ------------------------------------------------------------------ boot

$("new-bot").addEventListener("click", openSheet);
$("sheet-close").addEventListener("click", () => closeSheet());
$("sheet-cancel").addEventListener("click", () => closeSheet());
$("n-create").addEventListener("click", createBot);
$("sheet").addEventListener("click", (e) => {
  if (e.target === $("sheet") && !draftTouched()) closeSheet();
});

/** Tab stays inside the sheet while it is open. */
function trapFocus(e) {
  const focusable = [...$("sheet").querySelectorAll("button, input, select, textarea, [tabindex]:not([tabindex='-1'])")].filter(
    (el) => !el.disabled && el.offsetParent !== null,
  );
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}

function typing(target) {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement;
}

/** Move the selection up or down the list, like the arrow keys in a sidebar. */
function step(by) {
  const names = state.data?.instances.map((i) => i.name) ?? [];
  if (!names.length) return;
  const at = names.indexOf(state.selected);
  const next = names[Math.min(names.length - 1, Math.max(0, at + by))];
  select(next);
  $("bots").querySelector(`li[data-name="${next}"] button`)?.focus();
}

document.addEventListener("keydown", (e) => {
  if (!$("sheet").hidden) {
    if (e.key === "Escape") closeSheet();
    else if (e.key === "Tab") trapFocus(e);
    return;
  }
  if (e.metaKey || e.ctrlKey || e.altKey || typing(e.target)) return;
  // Keyboard shortcuts: n new bot, j/k or arrows through the list, s start/stop, r restart.
  if (e.key === "n") {
    e.preventDefault();
    openSheet();
  } else if (e.key === "j" || (e.key === "ArrowDown" && e.target.closest?.("#bots"))) {
    e.preventDefault();
    step(1);
  } else if (e.key === "k" || (e.key === "ArrowUp" && e.target.closest?.("#bots"))) {
    e.preventDefault();
    step(-1);
  } else if (e.key === "s" && current()) {
    control(current().name, current().running ? "stop" : "start");
  } else if (e.key === "r" && current()?.running) {
    control(current().name, "restart");
  }
});
window.addEventListener("hashchange", () => {
  const name = fromHash();
  if (name && name !== state.selected) select(name);
});

$("n-reroll-name").addEventListener("click", rerollName);
$("n-reroll-face").addEventListener("click", () => {
  draft.seed = Math.floor(Math.random() * 1e9);
  avatarPreview();
});
$("n-name").addEventListener("input", (e) => {
  // Names are lowercase; show the name that will be created, not a lookalike.
  const lower = e.target.value.toLowerCase();
  if (lower !== e.target.value) {
    const at = e.target.selectionStart;
    e.target.value = lower;
    e.target.setSelectionRange(at, at);
  }
  draft.name = lower;
  avatarPreview();
  validateName();
});
$("n-shape").addEventListener("click", (e) => {
  const shape = e.target.dataset?.shape;
  if (!shape) return;
  draft.shape = shape;
  setShape(shape);
  avatarPreview();
});
$("n-style").addEventListener("click", (e) => {
  const style = e.target.dataset?.style;
  if (!style) return;
  draft.style = style;
  setStyle(style);
  avatarPreview();
});

$("btn-toggle").addEventListener("click", () => current() && control(current().name, current().running ? "stop" : "start"));
$("btn-restart").addEventListener("click", () => current() && control(current().name, "restart"));

// A save still waiting when the tab closes goes out anyway.
window.addEventListener("pagehide", () => pending.size && flush({ keepalive: true }));

(async function boot() {
  // Poll whatever the first answer is: a manager that was down comes back.
  setInterval(refresh, POLL_MS);
  await refresh();
  if (state.selected) history.replaceState(null, "", `#${encodeURIComponent(state.selected)}`);
})();