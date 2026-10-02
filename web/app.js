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
  /** The instance the settings form was drawn from, so a poll can't redraw it. */
  formFor: null,
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
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 2600);
}

function fail(err) {
  toast(err instanceof Error ? err.message : String(err));
}

async function refresh() {
  try {
    state.data = await api("/api/manager");
  } catch (err) {
    return fail(err);
  }
  const names = state.data.instances.map((i) => i.name);
  if (state.selected && !names.includes(state.selected)) state.selected = null;
  renderList();
  renderDetail();
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

function renderList() {
  const list = $("bots");
  list.replaceChildren(
    ...state.data.instances.map((instance) => {
      const status = statusOf(instance);
      const where = instance.surfaces.length ? instance.surfaces.join(" · ") : "no chat yet";
      const label = `${where} · ${status.short}`;
      return node(
        "li",
        {},
        node(
          "button",
          {
            class: `bot${state.selected === instance.name ? " on" : ""}`,
            type: "button",
            title: `${instance.name} — ${status.text}`,
            onclick: () => select(instance.name),
          },
          [
            node("img", { src: avatarUrl(instance), alt: "" }),
            node("div", { class: "bot-text" }, [
              node("div", { class: "bot-name", text: instance.name }),
              node("div", { class: "bot-meta", text: label }),
            ]),
            node("span", { class: `dot ${status.dot}` }),
          ],
        ),
      );
    }),
  );
  if (!state.data.instances.length) {
    list.append(node("li", { class: "hint", style: "padding:8px 10px", text: "No bots yet." }));
  }
  $("runtime-note").textContent = state.data.runtimeDir;
}

function avatarUrl(instance) {
  return `/api/instances/${instance.name}/avatar.svg`;
}

// ----------------------------------------------------------------- detail

function current() {
  return state.data?.instances.find((i) => i.name === state.selected) ?? null;
}

function select(name) {
  state.selected = name;
  state.formFor = null;
  renderList();
  renderDetail();
}

function renderDetail() {
  const instance = current();
  $("detail").hidden = !instance;
  $("placeholder").hidden = !!instance;
  if (!instance) return;

  $("d-avatar").src = avatarUrl(instance);
  $("d-name").textContent = instance.name;

  const status = statusOf(instance);
  const when = instance.health?.lastMessageAt ? ` · last message ${ago(instance.health.lastMessageAt)}` : "";
  $("d-status").textContent = `${status.text}${when}`;
  $("d-port").textContent = `health port ${instance.port}`;

  const toggle = $("btn-toggle");
  toggle.textContent = instance.running ? "Stop" : "Start";
  toggle.classList.toggle("danger", instance.running);
  toggle.classList.toggle("primary", !instance.running);

  renderHealth(instance);
  if (state.formFor !== instance.name) renderSettings(instance);
  else syncSettings(instance);
  renderLog(instance);
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
  items.push(["pid", null, instance.pid ? String(instance.pid) : "—"]);
  if (health) items.push(["up", null, `${Math.floor(health.uptimeSec / 60)} min`]);
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

function renderSettings(instance) {
  const form = $("settings");
  form.replaceChildren(
    ...state.data.groups
      .map((group) => {
        const fields = instance.fields.filter((f) => f.group === group);
        if (!fields.length) return null;
        const open = !["Advanced", "Look"].includes(group);
        return node("details", { class: "group", ...(open ? { open: true } : {}) }, [
          node("summary", {}, [node("h3", { text: group })]),
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
          type: "button",
          onclick: () => removeBot(instance.name),
          disabled: instance.running,
        },
        instance.running ? "Stop the bot to delete it" : "Delete this bot",
      ),
    ]),
  );
  state.formFor = instance.name;
}

/** Push server values into inputs the user isn't typing in. */
function syncSettings(instance) {
  for (const input of $("settings").querySelectorAll("[data-key]")) {
    // `HOO_SURFACES:slack` is a checkbox, not a value in the file.
    if (document.activeElement === input || input.dataset.touched || input.dataset.key.includes(":")) continue;
    const key = input.dataset.key;
    const value = input.type === "checkbox" ? "true" : input.value;
    if (key in instance.secrets) {
      // A secret the user never typed stays masked, never blank.
      if (value !== instance.secrets[key]) input.value = instance.secrets[key] || "";
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
    const picked = new Set(instance.surfaces);
    const boxes = (field.choices ?? []).map((choice) =>
      node("label", { class: "toggle" }, [
        node("input", {
          type: "checkbox",
          "data-key": `${field.key}:${choice}`,
          ...(picked.has(choice) ? { checked: true } : {}),
          onchange: () => {
            // Toggling can add a chat, never quietly remove one the bot is
            // already configured for.
            const chosen = new Set([
              ...[...$("settings").querySelectorAll(`[data-key^="${field.key}:"]`)]
                .filter((box) => box.checked)
                .map((box) => box.dataset.key.split(":")[1]),
              ...instance.surfaces,
            ]);
            queueSave(instance.name, field.key, [...chosen].join(","));
          },
        }),
        node("span", { text: choice }),
      ]),
    );
    return node("div", { class: "field" }, [node("span", { class: "label", text: field.label }), ...boxes, node("span", { class: "hint", text: field.hint ?? "" })]);
  }

  if (field.kind === "toggle") {
    const on = (instance.config[field.key] ?? "false").toLowerCase() === "true";
    input = node("input", { type: "checkbox", id, "data-key": field.key, ...(on ? { checked: true } : {}) });
    return node("label", { class: "toggle", for: id }, [input, node("span", { text: field.label })]);
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
    input = node("input", {
      type: "password",
      id,
      "data-key": field.key,
      "data-kind": field.kind,
      autocomplete: "off",
      spellcheck: "false",
      placeholder: instance.secrets[field.key] ? "••••  (unchanged)" : field.placeholder || "not set",
    });
    input.value = instance.secrets[field.key] ?? "";
  } else {
    input = node("input", { type: "text", id, "data-key": field.key, "data-kind": field.kind, spellcheck: "false" });
    input.value = instance.config[field.key] ?? "";
  }

  input.addEventListener("input", () => {
    input.dataset.touched = "1";
    queueSave(instance.name, field.key, input.type === "checkbox" ? String(input.checked) : input.value);
  });
  if (field.kind === "select") input.addEventListener("change", () => (input.dataset.touched = "1"));

  const hint = node("span", { class: "hint", text: field.hint ?? "" });
  return node("label", { class: "field", for: id }, [
    node("span", { class: "label", text: field.label }),
    input,
    hint,
  ]);
}

// One save in flight per key; edits in the same field collapse into one.
const pending = new Map();
let saveTimer;

function queueSave(name, key, value) {
  pending.set(`${name}:${key}`, { name, key, value });
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, 500);
}

async function flush() {
  const batch = [...pending.values()];
  pending.clear();
  for (const { name, key, value } of batch) {
    try {
      // Whether a field is a secret is the server's call, not a guess here.
      const field = [...$("settings").querySelectorAll("[data-key]")].find((i) => i.dataset.key === key);
      const isSecret = field?.dataset.kind === "secret";
      const saved = await api(`/api/instances/${name}`, {
        method: "PATCH",
        body: isSecret ? { secrets: { [key]: value } } : { config: { [key]: value } },
      });
      if (field) {
        field.dataset.touched = "";
        // A saved token goes back to being a mask: the browser never keeps it.
        if (isSecret) field.value = saved.secrets[key] ?? "";
      }
      $("save-hint").textContent = "Saved";
    } catch (err) {
      fail(err);
    }
  }
  if (batch.length) refresh();
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

async function control(name, action) {
  const button = action === "restart" ? $("btn-restart") : $("btn-toggle");
  button.disabled = true;
  try {
    const res = await api(`/api/instances/${name}/${action}`, { method: "POST" });
    if (!res.ok) toast(res.output.split("\n").slice(-1)[0] || `${action} failed`);
    else toast(`${name} ${action === "restart" ? "restarted" : action === "start" ? "started" : "stopped"}`);
  } catch (err) {
    fail(err);
  } finally {
    button.disabled = false;
    await refresh();
  }
}

async function removeBot(name) {
  if (!confirm(`Delete ${name}? Its folder, tokens and logs go. The working folder stays.`)) return;
  try {
    await api(`/api/instances/${name}`, { method: "DELETE" });
    state.selected = null;
    state.formFor = null;
    toast(`${name} deleted`);
  } catch (err) {
    fail(err);
  }
  await refresh();
}

// ------------------------------------------------------------- new bot

const draft = { name: "", seed: 0, shape: "circle", palette: "", surfaces: new Set(["slack"]), tokens: {} };

function avatarPreview() {
  // No seed means "derive one from the name", which the server does, so the
  // preview is the face that gets saved rather than a lookalike.
  const q = new URLSearchParams({ shape: draft.shape });
  if (draft.seed) q.set("seed", String(draft.seed));
  else if (draft.name) q.set("name", draft.name);
  if (draft.palette) q.set("palette", draft.palette);
  $("n-avatar").src = `/api/avatar.svg?${q}`;
}

async function rerollName() {
  const { name } = await api(`/api/names/suggest?seed=${Math.random()}`);
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
  $("n-palette").replaceChildren(
    node("button", {
      class: `swatch auto${draft.palette === "" ? " on" : ""}`,
      type: "button",
      title: "Let the name pick the colour",
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
        style: `background:linear-gradient(135deg,${p.from},${p.to})`,
        onclick: () => {
          draft.palette = draft.palette === p.id ? "" : p.id;
          renderSwatches();
          avatarPreview();
        },
      }),
    ),
  );
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
          onclick: () => {
            draft.surfaces.has(s.id) ? draft.surfaces.delete(s.id) : draft.surfaces.add(s.id);
            renderSurfaces();
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
  draft.name = "";
  draft.palette = "";
  draft.shape = "circle";
  draft.seed = Math.floor(Math.random() * 1e9);
  draft.tokens = {};
  $("n-name").value = "";
  $("n-workdir").value = state.data.sharedWorkdir;
  $("n-error").textContent = "";
  for (const b of $("n-shape").querySelectorAll("button")) b.classList.toggle("on", b.dataset.shape === draft.shape);
  renderSwatches();
  renderSurfaces();
  avatarPreview();
  $("sheet").hidden = false;
  $("n-name").focus();
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
        avatarPalette: draft.palette,
        secrets: draft.tokens,
      },
    });
    $("sheet").hidden = true;
    state.selected = instance.name;
    state.formFor = null;
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
$("sheet-close").addEventListener("click", () => ($("sheet").hidden = true));
$("sheet-cancel").addEventListener("click", () => ($("sheet").hidden = true));
$("n-create").addEventListener("click", createBot);
$("sheet").addEventListener("click", (e) => {
  if (e.target === $("sheet")) $("sheet").hidden = true;
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") $("sheet").hidden = true;
});

$("n-reroll-name").addEventListener("click", rerollName);
$("n-reroll-face").addEventListener("click", () => {
  draft.seed = Math.floor(Math.random() * 1e9);
  avatarPreview();
});
$("n-name").addEventListener("input", (e) => {
  draft.name = e.target.value.toLowerCase();
  avatarPreview();
  validateName();
});
$("n-shape").addEventListener("click", (e) => {
  const shape = e.target.dataset?.shape;
  if (!shape) return;
  draft.shape = shape;
  for (const b of $("n-shape").querySelectorAll("button")) b.classList.toggle("on", b.dataset.shape === shape);
  avatarPreview();
});

$("btn-toggle").addEventListener("click", () => current() && control(current().name, current().running ? "stop" : "start"));
$("btn-restart").addEventListener("click", () => current() && control(current().name, "restart"));

// Don't lose a typed token to the next poll.
window.addEventListener("beforeunload", () => flush());

(async function boot() {
  await refresh();
  if (state.data.instances.length) select(state.data.instances[0].name);
  setInterval(refresh, POLL_MS);
})();