// Overview's page script (#104, phase 2; design round 1 after Codex's read; fix round 2). One file for both pages: on the PIN page it
// only tells when a lockout ends; on the main page it polls /api/tasks, /api/progress and /api/usage every
// 5 s and sends answers to /api/answer with the page's CSRF token (X-CSRF-Token).
// Store text is untrusted: it is only ever set as textContent. http://pop-os:6767 is not a
// secure context, so request ids are drawn with crypto.getRandomValues.
"use strict";

(() => {
  const SVG = "http://www.w3.org/2000/svg";
  const RING = "M10 2.75a7.25 7.25 0 1 1 0 14.5a7.25 7.25 0 1 1 0-14.5z";
  // Drawn marks, one stroke weight: each is a list of path data.
  const ICONS = {
    ok: [RING, "M6.9 10.3l2.2 2.2 4.1-4.4"],
    fail: [RING, "M7.6 7.6l4.8 4.8M12.4 7.6l-4.8 4.8"],
    retry: ["M15.6 7.2A6.25 6.25 0 1 0 16.25 11", "M16 3.5v3.9h-3.9"],
    info: [RING, "M10 9.25v4.5M10 6.4v.1"],
    alert: [RING, "M10 6v4.75M10 13.6v.1"],
    sending: ["M10 3.25a6.75 6.75 0 1 1-6.75 6.75"],
    mail: ["M3 5.25h14v9.5H3z", "M3.4 5.7l6.6 5.05 6.6-5.05"],
    tray: ["M2.75 11.25h4.1l1.2 2.25h3.9l1.2-2.25h4.1", "M5 4.75h10l2.25 6.5v4H2.75v-4z"],
    live: ["M10 6.5a3.5 3.5 0 1 1 0 7a3.5 3.5 0 1 1 0-7z"],
    quiet: ["M10 6.5a3.5 3.5 0 1 1 0 7a3.5 3.5 0 1 1 0-7z"],
    ended: [RING, "M5 15L15 5"],
    clock: [RING, "M10 6.25V10l2.6 1.6"],
    off: [RING, "M6.6 10h6.8"],
    chevron: ["M7.75 5.5L12.25 10l-4.5 4.5"],
  };

  function icon(name) {
    const svg = document.createElementNS(SVG, "svg");
    svg.setAttribute("class", "icon");
    svg.setAttribute("viewBox", "0 0 20 20");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    for (const d of ICONS[name]) {
      const path = document.createElementNS(SVG, "path");
      path.setAttribute("d", d);
      if (name === "live") path.setAttribute("fill", "currentColor");
      svg.append(path);
    }
    return svg;
  }

  function el(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined && text !== null) node.textContent = String(text);
    if (className) node.className = className;
    return node;
  }

  function clock(ms) {
    return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  }

  function shortClock(ms) {
    return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  }

  // --- the theme, on both pages ----------------------------------------------------------------
  // T3C blends into T3 Code's own dark interface; a link picks it with the fragment `#theme=t3c`
  // (never sent to the server, which serves the page at "/" only). It is saved here, before the
  // PIN page returns, so the PIN page wears it and the choice survives unlock (the form's POST
  // and redirect drop the fragment). The fragment is then removed, so a later reload keeps a
  // choice made on the toggle instead of the link winning again.
  const THEMES = ["system", "light", "dark", "t3c"];
  const THEME_NAMES = { system: "System", light: "Light", dark: "Dark", t3c: "T3C" };
  let theme = "system";
  try { theme = localStorage.getItem("overview-theme") || "system"; } catch (_) {}
  const fromLink = new URLSearchParams(location.hash.slice(1)).get("theme");
  if (THEMES.includes(fromLink)) {
    theme = fromLink;
    try { localStorage.setItem("overview-theme", theme); } catch (_) {}
    history.replaceState(null, "", location.pathname + location.search);
  }
  function applyTheme() {
    if (!THEMES.includes(theme)) theme = "system";
    if (theme === "system") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
    const toggle = document.getElementById("theme-toggle");
    if (!toggle) return; // the PIN page has none
    toggle.textContent = THEME_NAMES[theme] + " theme";
    toggle.setAttribute("aria-label", "Appearance: " + THEME_NAMES[theme] + ". Change theme");
  }
  applyTheme();

  // --- the PIN page: when a lockout ends ------------------------------------------------------

  if (document.body.id === "pin-page") {
    const message = document.getElementById("pin-message").textContent;
    const minutes = /try again in (\d+) min/.exec(message);
    if (minutes) {
      const until = Date.now() + Number(minutes[1]) * 60000;
      const line = document.getElementById("pin-unlock");
      const controls = document.querySelectorAll("#pin-form input, #pin-form button");
      line.textContent = "Try again at " + shortClock(until) + ".";
      line.hidden = false;
      for (const control of controls) control.disabled = true;
      setTimeout(() => {
        for (const control of controls) control.disabled = false;
        line.textContent = "You can try the PIN again now.";
      }, until - Date.now());
    }
    return;
  }

  // --- the main page --------------------------------------------------------------------------

  const POLL_MS = 5000;
  const KEEP_ANSWERED_MS = 6000;
  const PREVIEW_LINES = 4; // the detail's preview, in lines (app.css draws the same height)
  const HOST = location.hostname || "the machine";
  const csrf = document.querySelector('meta[name="csrf-token"]').content;
  const bar = document.querySelector(".bar");
  const status = document.getElementById("status");
  const checked = document.getElementById("checked");
  const tasksHeading = document.getElementById("tasks-heading");
  const taskList = document.getElementById("task-list");
  const feedNotice = document.getElementById("feed-notice");
  const progressList = document.getElementById("progress-list");
  const sentSection = document.getElementById("sent");
  const sentList = document.getElementById("sent-list");
  const lastAnswer = document.getElementById("last-answer");

  const tabButtons = Array.from(document.querySelectorAll('[role="tab"]'));
  const shownTabs = () => tabButtons.filter((button) => !button.hidden);
  function selectTab(id, focus) {
    for (const button of tabButtons) {
      const selected = button.id === id;
      button.setAttribute("aria-selected", String(selected));
      button.tabIndex = selected ? 0 : -1;
      document.getElementById(button.getAttribute("aria-controls")).hidden = !selected;
      if (selected && focus) button.focus();
    }
    document.querySelector(".skip-link").href = "#" + document.getElementById(id).getAttribute("aria-controls");
    if (id === "tasks-tab") fitDetails();
  }
  tabButtons.forEach((button) => {
    button.addEventListener("click", () => selectTab(button.id, false));
    button.addEventListener("keydown", (event) => {
      let next;
      const visible = shownTabs();
      const index = visible.indexOf(button);
      if (event.key === "ArrowRight") next = visible[(index + 1) % visible.length];
      else if (event.key === "ArrowLeft") next = visible[(index - 1 + visible.length) % visible.length];
      else if (event.key === "Home") next = visible[0];
      else if (event.key === "End") next = visible[visible.length - 1];
      if (next) { event.preventDefault(); selectTab(next.id, true); }
    });
  });
  const appearance = document.getElementById("theme-toggle");
  appearance.addEventListener("click", () => {
    theme = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
    try { localStorage.setItem("overview-theme", theme); } catch (_) {}
    applyTheme();
  });
  applyTheme();

  // The browser tab says how many things wait on the owner. T3 Code 0.1.11 shows the same globe
  // for every web tab and never shows a page's icon, but its tab label is the page title, where
  // coloured emoji render: "🟦 Overview" when nothing waits, "🔴 2 · Overview" when something does.
  // When the count rises (so also on a first load with a count) the title alternates with
  // "⭕ 2 · Overview" and the page icon blinks its badge, three times, then both hold (never with
  // reduced motion, never for ever). A steady count writes nothing: no title, no icon request,
  // and a running blink plays out. The badge is kept for browsers, and a later T3, that show it.
  const QUIET_TITLE = "🟦 Overview";
  const pageIcon = document.querySelector("link[rel=icon]");
  let attention = 0; let blinking = null;
  function attentionTitle(count, lit) {
    return (lit ? "🔴 " : "⭕ ") + count + " · Overview";
  }
  function showAttention(count) {
    if (count === attention) return;
    const badge = count ? "/favicon.svg?n=" + Math.min(count, 99) : "/favicon.svg";
    const rose = count > attention; attention = count;
    clearInterval(blinking); blinking = null;
    document.title = count ? attentionTitle(count, true) : QUIET_TITLE;
    if (pageIcon) pageIcon.setAttribute("href", badge);
    if (!rose || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let frames = 6;
    blinking = setInterval(() => {
      frames -= 1;
      const lit = frames % 2 === 0;
      document.title = attentionTitle(count, lit);
      if (pageIcon) pageIcon.setAttribute("href", lit ? badge : "/favicon.svg");
      if (!frames) { clearInterval(blinking); blinking = null; }
    }, 400);
  }

  const cards = new Map(); // task key -> its card, kept across polls
  const tasksByKey = new Map(); // task key -> the task as last listed
  const answered = new Map(); // task key -> when its answer was accepted
  // The request_id of an answer not yet settled, by what it sends: trying again after a
  // busy, pending or unreachable sends the same request, which the session applies once.
  const unsettled = new Map();
  // Cards whose answer may or may not have reached the session (no reply, a cut-off reply,
  // pending): until the outcome is known they offer only "Retry same answer".
  const doubtful = new Set();
  // Replies from the session's endpoint that say what became of an answer. Only these settle a
  // delivery that is unconfirmed; anything else (an error, no endpoint, unreachable, pending,
  // busy, a refusal by Overview itself, a lost or cut-off reply) proves nothing about the
  // first try, so the card stays unconfirmed and keeps the same request.
  // Browser behavior coverage exercises delivery, retry and HTTP polling with synthetic fixtures.
  const SETTLES = new Set(["accepted", "stale", "closed", "unknown", "gone", "refused"]);
  // Polls in a row whose list did not have a task. One poll proves nothing (its store may have
  // been unreadable just then): the card stays as it was, dimmed, and is whole again when the
  // task is listed again.
  const missing = new Map();
  const DROP_AFTER = 3; // polls in a row without its task before a card may go
  // From this many task cards the list is compact: one line per task, opened in place.
  const COMPACT_FROM = 3;
  const opened = new Set(); // task keys opened in the compact list, kept across polls
  let compact = false;
  let roots = new Map(); // session id -> project folder, from the tasks
  let loaded = false;
  let failing = false;
  let lastGood = 0;
  let asked = 0; // refreshes started
  let shown = 0; // the newest refresh rendered

  // 32 random hex digits: an owner request's id as it is, an answer's after "dash-".
  function randomHex() {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  }

  function requestId() {
    return "dash-" + randomHex();
  }

  function ago(seconds) {
    if (seconds < 60) return "just now";
    if (seconds < 3600) return Math.floor(seconds / 60) + " min ago";
    if (seconds < 86400) return Math.floor(seconds / 3600) + " h ago";
    return Math.floor(seconds / 86400) + " d ago";
  }

  function project(root) {
    if (!root) return "a project";
    if (root.startsWith("#")) return "project " + root;
    const parts = root.split("/").filter(Boolean);
    return parts.length ? parts[parts.length - 1] : root;
  }

  function quoted(text, max) {
    const flat = String(text).replace(/\s+/g, " ").trim();
    return "“" + (flat.length > max ? flat.slice(0, max - 1) + "…" : flat) + "”";
  }

  function setText(node, text) {
    if (node.textContent !== text) node.textContent = text; // a live region speaks on change only
  }

  async function getJSON(path) {
    let response;
    try {
      response = await fetch(path, { credentials: "same-origin", cache: "no-store" });
    } catch (error) {
      throw Object.assign(new Error("network"), { kind: "network" });
    }
    if (response.status === 401) {
      location.reload(); // the session ended: the PIN page again
      throw Object.assign(new Error("locked"), { kind: "locked" });
    }
    if (!response.ok) throw Object.assign(new Error("http"), { kind: "http", status: response.status });
    return response.json();
  }

  function keyOf(task) {
    return task.session_id + "#" + task.id + "@" + task.created_ms;
  }

  function domId(prefix, key) {
    return prefix + "-" + key.replace(/[^A-Za-z0-9_-]/g, "-");
  }

  // --- the status line ------------------------------------------------------------------------

  function since(ms) {
    const seconds = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (seconds < 10) return "just now";
    if (seconds < 60) return seconds + " s ago";
    return ago(seconds);
  }

  function freshness() {
    if (!lastGood) return "";
    return (failing ? "Last updated " : "Updated ") + since(lastGood);
  }

  function showBar(tone, iconName, text) {
    if (tone) bar.dataset.tone = tone;
    else delete bar.dataset.tone;
    if (status.textContent !== text) {
      status.replaceChildren();
      if (iconName) status.append(icon(iconName));
      status.append(text);
    }
    checked.textContent = freshness();
  }

  function failureWords(error) {
    if (error.kind === "network") return "Can’t reach " + HOST;
    if ([502, 503, 504].includes(error.status)) return "The Overview server isn’t answering";
    return "The Overview server failed (" + error.status + ")";
  }

  // --- answers --------------------------------------------------------------------------------

  // What an outcome means, in words: tone (ok, wait, fail), headline, sentence, and whether
  // trying again is safe (the same request_id), a reload is the way out, or the delivery is
  // unconfirmed (`doubt`: only the same answer may be sent until its outcome is known).
  function describe(o) {
    const message = typeof o.message === "string" ? o.message : "";
    switch (o.outcome) {
      case "accepted":
        return o.duplicate
          ? { tone: "ok", head: "Already delivered", line: "This answer reached the session earlier. It was applied once." }
          : { tone: "ok", head: "Delivered", line: "The session has your answer." };
      case "stale":
        return { tone: "fail", head: "Not sent: the task changed", line: "It was answered or changed somewhere else after this page loaded, so nothing was applied. The list now shows it as it is." };
      case "closed":
        return { tone: "fail", head: "Not sent: already answered", line: "This task was closed before your answer arrived. Nothing was applied." };
      case "unknown":
        return { tone: "fail", head: "Not sent: the task is gone", line: "The session no longer holds this task. Nothing was applied." };
      case "gone":
        return { tone: "fail", head: "Not sent: the session ended", line: "Its tasks wait for the next session in that project. Answer it there.", gone: true };
      case "busy":
        return { tone: "wait", head: "Not sent yet: the session is busy", line: "Try again in a moment. It goes as the same answer, so it is applied once.", retry: true };
      case "pending":
      case "unreachable":
      case "lost":
      case "error": // a failure mid-way: the session may have applied it first
        return { tone: "wait", head: "Delivery unconfirmed", line: "Your answer may have reached the session. Retrying the same answer is safe.", retry: true, doubt: true };
      case "no_endpoint":
        return { tone: "fail", head: "Not sent: web answers are off", line: "Web answers are disabled for this session. Answer in Claude." };
      case "refused":
        return refusal(message);
      case "reused":
        return { tone: "fail", head: "Not sent: request clash", line: "Reload the page and answer again.", reload: true };
      case "locked":
        return { tone: "fail", head: "Not sent: this browser is locked out", line: "Reload the page and enter the PIN.", reload: true };
      case "csrf":
        return { tone: "fail", head: "Not sent: this page is out of date", line: "Reload the page and answer again.", reload: true };
      case "forbidden":
        return { tone: "fail", head: "Not sent: refused by Overview", line: "The request did not come from this page’s address. Open the page from your bookmark and answer again.", reload: true };
      case "bad_request":
        return { tone: "fail", head: "Not sent: Overview could not read it", line: message || "Reload the page and answer again.", reload: true };
      case "timeout":
      case "too_large":
      case "length_required":
      case "unsupported_media_type":
      case "not_found": // Overview's own refusals, before anything is relayed
        return { tone: "fail", head: "Not sent", line: "Overview answered “" + o.outcome + "”." + (message ? " " + message : "") };
      default: // an outcome this page does not know proves nothing either way
        return { tone: "wait", head: "Delivery unconfirmed", line: "Overview answered “" + o.outcome + "”. Your answer may have reached the session. Retrying the same answer is safe.", retry: true, doubt: true };
    }
  }

  // A retry of an unconfirmed delivery that settled nothing: still unconfirmed, saying what the
  // retry got, with the same answer as the only way on.
  function stillUnconfirmed(o, said) {
    const got = {
      busy: "the session was busy",
      pending: "the session has not finished with it yet",
      unreachable: "the session did not answer",
      lost: "no reply reached this browser",
    }[o.outcome] || "“" + said.head + "”";
    return { tone: "wait", head: "Delivery still unconfirmed", line: "Last retry: " + got + ". Your answer may have reached the session. Retrying the same answer is safe.", retry: true, doubt: true };
  }

  // The session's refusals name its own request fields ("send choose"); say what answer is needed.
  function refusal(message) {
    let m;
    if (/secret/i.test(message)) {
      return { tone: "fail", head: "Not sent: it looks like a secret", line: "Nothing of it was kept or shown to the session. Put the secret where it belongs, then send Done.", secret: true };
    }
    if (/asks for one of its options/.test(message)) {
      return { tone: "fail", head: "Not sent: this task needs one of its options", line: "Pick one of its options, or write your own with Other answer." };
    }
    if (/has no options/.test(message)) {
      return { tone: "fail", head: "Not sent: this task has no options", line: "Mark it done, or answer it in words." };
    }
    if (/none of the task/.test(message)) {
      return { tone: "fail", head: "Not sent: that option is no longer offered", line: "Reload the page to see the task’s options as they are now.", reload: true };
    }
    if (/text is empty/.test(message)) {
      return { tone: "fail", head: "Not sent: the answer was empty", line: "Write your answer, then send it." };
    }
    if ((m = /^(text|reason) is (\d+) characters; the limit is (\d+)/.exec(message))) {
      return {
        tone: "fail",
        head: "Not sent: " + (m[1] === "text" ? "the answer" : "the reason") + " is too long",
        line: "It is " + Number(m[2]).toLocaleString() + " characters; the limit is " + Number(m[3]).toLocaleString() + ". Shorten it and send again.",
      };
    }
    if (/did not reach the session whole/.test(message)) {
      return { tone: "fail", head: "Not sent: it arrived cut off", line: "Nothing was applied. Send it again." };
    }
    return { tone: "fail", head: "Not sent: the session would not take this answer", line: message || "It does not fit this task." };
  }

  function doneLabel(task) {
    return task.kind === "answer" ? "Mark done without a reply" : "Done";
  }

  function whatWasSent(task, action, extra) {
    if (action === "archive") return "You archived it; nothing was sent to Claude";
    if (action === "restore") return "You restored it; nothing was sent to Claude";
    if (action === "done") return task.kind === "answer" ? "You marked it done without a reply" : "You marked it done";
    if (action === "choose") return "You chose " + quoted(extra.option, 60);
    if (action === "answer") return "You answered " + quoted(extra.text, 60);
    return extra.reason ? "You rejected it: " + quoted(extra.reason, 60) : "You rejected it";
  }

  // The in-flight line, where the tapped control was: what is going, in its own words.
  function sendingWords(task, action, extra) {
    if (action === "archive") return { head: "Archiving" };
    if (action === "restore") return { head: "Restoring" };
    if (action === "choose") return { head: "Sending: " + extra.option };
    if (action === "done") return { head: "Sending: " + doneLabel(task) };
    if (action === "answer") return { head: "Sending your answer", what: quoted(extra.text, 200) };
    return { head: "Sending: Reject", what: extra.reason ? quoted(extra.reason, 200) : undefined };
  }

  function showReceipt(node, said, onRetry) {
    const receipt = node.querySelector(".receipt");
    receipt.replaceChildren(
      icon(said.tone === "ok" ? "ok" : said.tone === "wait" ? "retry" : said.tone === "sending" ? "sending" : said.tone === "info" ? "info" : "fail"),
      el("p", said.head, "receipt-head"),
    );
    if (said.line) receipt.append(el("p", said.line));
    if (said.what) receipt.append(el("p", said.what, "what"));
    receipt.dataset.tone = said.tone;
    if (said.retry || said.reload) {
      const row = el("div", null, "receipt-actions");
      const label = said.doubt ? "Retry same answer" : said.retry ? "Try again" : "Reload the page";
      const button = el("button", label, said.doubt ? "button primary" : "button");
      button.type = "button";
      button.addEventListener("click", said.retry ? onRetry : () => location.reload());
      row.append(button);
      receipt.append(row);
    }
    receipt.hidden = false;
  }

  function setControls(node, enabled) {
    for (const control of node.querySelectorAll(".actions button, .reply button, .reply textarea")) {
      control.disabled = !enabled;
    }
  }

  function logSent(task, said, what) {
    const item = el("li");
    item.dataset.tone = said.tone;
    const text = el("div");
    text.append(el("p", said.head + ": #" + task.id + " " + task.title), el("p", what, "what"));
    item.append(icon(said.tone === "ok" ? "ok" : said.tone === "wait" ? "retry" : said.tone === "info" ? "info" : "fail"), text, el("time", shortClock(Date.now())));
    sentList.prepend(item);
    while (sentList.children.length > 20) sentList.lastElementChild.remove();
    sentSection.hidden = false;
  }

  async function send(node, task, action, extra) {
    // An ended session's task is archived or restored through a live session in its project,
    // which takes it on (#187); every answer goes to the session that holds the task.
    const shelf = action === "archive" || action === "restore";
    const fields = Object.assign(
      { session_id: shelf && task.via ? task.via : task.session_id, task_id: task.id, created_ms: task.created_ms, version: task.version, action: action },
      extra,
    );
    const key = JSON.stringify(fields);
    const id = unsettled.get(key) || requestId();
    unsettled.set(key, id);
    const taskKey = keyOf(task);
    // A receipt carried over to a rebuilt card keeps this button: it acts on the card in the
    // page when tapped, with the same request.
    const retry = () => {
      const current = cards.get(taskKey);
      if (current && current.isConnected && !current.classList.contains("sending")) send(current, task, action, extra);
    };
    const wasDoubtful = doubtful.has(taskKey);
    const receipt = node.querySelector(".receipt");
    const hadFocus = node.contains(document.activeElement);
    node.classList.add("sending");
    node.setAttribute("aria-busy", "true");
    setControls(node, false);
    const going = sendingWords(task, action, extra);
    showReceipt(node, { tone: "sending", head: going.head, line: "Waiting for the session to confirm.", what: going.what });
    if (hadFocus) receipt.focus(); // the tapped control makes way: focus stays in the card

    let outcome;
    try {
      const response = await fetch("/api/answer", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
        body: JSON.stringify(Object.assign({ request_id: id }, fields)),
      });
      if (response.status === 401 && !wasDoubtful) {
        location.reload(); // an unconfirmed card stays to say so; the next poll reloads
        return;
      }
      try {
        outcome = await response.json();
      } catch (error) {
        // A reply cut off, or not Overview's (a gateway page): it may have been applied.
        outcome = { outcome: response.ok || response.status >= 500 ? "lost" : "http_" + response.status };
      }
    } catch (error) {
      outcome = { outcome: "lost" }; // no reply at all: sent or not, nobody can tell from here
    }

    let said = describe(outcome);
    // Archive and Restore answer nothing: the session applied them and told Claude nothing (#187).
    if (outcome.outcome === "accepted" && action === "archive") said = { tone: "ok", head: "Archived", line: "Nothing was sent to Claude. Restore it from Archived below within 7 days." };
    if (outcome.outcome === "accepted" && action === "restore") said = { tone: "ok", head: "Restored", line: "It is back in the list. Nothing was sent to Claude." };
    if (wasDoubtful && !SETTLES.has(outcome.outcome)) said = stillUnconfirmed(outcome, said);
    if (!said.retry) unsettled.delete(key);
    if (said.doubt) {
      doubtful.add(taskKey);
      node.classList.add("doubtful");
      said.what = whatWasSent(task, action, extra); // the attempted answer stays in view
    } else {
      doubtful.delete(taskKey);
      node.classList.remove("doubtful");
    }
    if (outcome.outcome === "accepted") said.what = whatWasSent(task, action, extra);
    node.classList.remove("sending");
    node.removeAttribute("aria-busy");
    showReceipt(node, said, retry);
    if (said.secret) for (const text of node.querySelectorAll("textarea")) text.value = ""; // keep no copy on screen
    lastAnswer.textContent = "Task " + task.id + ", " + task.title + ": " + said.head + ". " + said.line;
    if (outcome.outcome === "stale") node.dataset.renew = "1"; // rebuilt on the next poll, draft kept
    if (said.gone) markEnded(node);
    if (action === "restore") {
      // The Archived row goes with the next poll and the task's own card comes back: nothing
      // holds that card as answered.
      if (outcome.outcome !== "accepted") setControls(node, true);
    } else if (["accepted", "closed", "unknown"].includes(outcome.outcome)) {
      // Settled by the session: the card stays a few seconds once its task leaves the list.
      answered.set(taskKey, Date.now());
      node.classList.add("answered");
    } else {
      setControls(node, true);
    }
    if (!said.retry) logSent(task, said, said.secret ? "Your answer (not kept)" : whatWasSent(task, action, extra));
    refresh();
  }

  // --- a task, as a message -------------------------------------------------------------------

  function fromLine(task) {
    const line = el("p", null, "from");
    line.append(el("span", project(task.root), "project"));
    // An ended session says so under the title instead ("Session ended").
    if (task.session_state !== "ended") {
      const words = { live: "live", quiet: "quiet" };
      const state = el("span", null, "state");
      state.dataset.state = task.session_state;
      state.append(icon(words[task.session_state] ? task.session_state : "quiet"), "session " + (words[task.session_state] || task.session_state));
      line.append(el("span", "·", "sep"), state);
    }
    line.append(el("span", "·", "sep"), el("span", "Asked " + ago(task.age_s), "age"));
    return line;
  }

  // Whether the card can be answered from here, said right under its title.
  function reach(kind) {
    const line = el("p", null, "reach");
    line.dataset.reach = kind;
    line.append(icon(kind === "ended" ? "ended" : "off"), kind === "ended" ? "Session ended" : "Web answers off");
    return line;
  }

  // After a "session ended" outcome the card agrees with its receipt.
  function markEnded(node) {
    node.classList.add("gone");
    const state = node.querySelector(".from .state");
    if (state) {
      state.previousElementSibling.remove(); // its separator
      state.remove();
    }
    if (!node.querySelector(".reach")) node.querySelector(".task-body").prepend(reach("ended"));
  }

  function detailOf(task) {
    const box = el("div", null, "detail");
    const sheet = el("div", null, "detail-text");
    const pre = el("pre", task.detail);
    pre.id = domId("detail", keyOf(task));
    sheet.append(pre);
    box.append(sheet);
    if (task.detail.split("\n").length > PREVIEW_LINES || task.detail.length > 160) {
      box.classList.add("clamped");
      const toggle = el("button", "Read full instructions", "button quiet");
      toggle.type = "button";
      toggle.setAttribute("aria-expanded", "false");
      toggle.setAttribute("aria-controls", pre.id);
      toggle.addEventListener("click", () => {
        const open = box.classList.toggle("clamped") === false;
        toggle.setAttribute("aria-expanded", String(open));
        toggle.textContent = open ? "Show less" : "Read full instructions";
      });
      box.append(toggle);
    }
    return box;
  }

  // A preview that turned out to fit loses its button (measured once the card is drawn).
  function fitDetails() {
    for (const box of taskList.querySelectorAll(".detail.clamped:not([data-fit])")) {
      const pre = box.querySelector("pre");
      if (!pre.clientHeight) continue; // not drawn yet (a closed group): measured later
      box.dataset.fit = "1";
      if (pre.scrollHeight <= pre.clientHeight + 1) {
        box.classList.remove("clamped");
        box.querySelector(":scope > button").remove();
      }
    }
  }

  // One reply mode at a time: opening "Other answer", "Answer in words" or "Reject" puts its form
  // in place of the card's controls; Cancel brings them back. Drafts stay in the fields.
  function openMode(node, kind, focus) {
    for (const form of node.querySelectorAll("form[data-mode]")) form.hidden = form.dataset.mode !== kind;
    node.querySelector(".controls").hidden = true;
    node.dataset.mode = kind;
    if (focus) node.querySelector('form[data-mode="' + kind + '"] textarea').focus();
  }

  function closeMode(node) {
    const kind = node.dataset.mode;
    for (const form of node.querySelectorAll("form[data-mode]")) form.hidden = true;
    node.querySelector(".controls").hidden = false;
    delete node.dataset.mode;
    const opener = node.querySelector('[data-opens="' + kind + '"]');
    if (opener) opener.focus();
  }

  function replyForm(node, task, kind, asMode) {
    const isAnswer = kind === "answer";
    const form = el("form", null, "reply " + (isAnswer ? "answer-form" : "reject-form"));
    if (asMode) form.dataset.mode = kind;
    const id = domId("reply-" + kind, keyOf(task));
    const label = el("label", isAnswer ? "Your answer" : "Why you are rejecting it (optional)", "field-label");
    label.htmlFor = id;
    const text = el("textarea");
    text.id = id;
    text.name = isAnswer ? "text" : "reason";
    text.rows = 3;
    if (isAnswer) text.required = true;
    const buttons = el("div", null, "reply-buttons");
    const submit = el("button", isAnswer ? "Send answer" : "Reject the task", isAnswer ? "button primary" : "button danger");
    submit.type = "submit";
    buttons.append(submit);
    if (asMode) {
      const cancel = el("button", "Cancel", "button quiet");
      cancel.type = "button";
      cancel.addEventListener("click", () => closeMode(node));
      buttons.append(cancel);
      form.addEventListener("keydown", (event) => {
        if (event.key === "Escape") closeMode(node);
      });
      form.hidden = true;
    }
    form.append(label, text, buttons);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (isAnswer) {
        if (!text.value.trim()) {
          text.focus();
          return;
        }
        send(node, task, "answer", { text: text.value });
      } else {
        send(node, task, "reject", text.value.trim() ? { reason: text.value } : {});
      }
    });
    return form;
  }

  function actionsOf(node, task) {
    const box = el("div", null, "actions");
    const controls = el("div", null, "controls");
    const more = el("div", null, "more");

    function opener(kind, label) {
      const button = el("button", label, "button quiet");
      button.type = "button";
      button.dataset.opens = kind;
      button.addEventListener("click", () => openMode(node, kind, true));
      return button;
    }

    function act(label, className, action, extra) {
      const button = el("button", label, className);
      button.type = "button";
      button.addEventListener("click", () => send(node, task, action, extra));
      return button;
    }

    if (task.kind === "choose") {
      for (const option of task.options) controls.append(act(option, "button option", "choose", { option: option }));
      more.append(opener("answer", "Other answer"), opener("reject", "Reject"));
      controls.append(more);
      box.append(controls, replyForm(node, task, "answer", true), replyForm(node, task, "reject", true));
    } else if (task.kind === "answer") {
      // An answer task asks for words first; Done is the pane's Done (handled elsewhere, no reply).
      more.append(act(doneLabel(task), "button quiet", "done", {}), opener("reject", "Reject"));
      controls.append(replyForm(node, task, "answer", false), more);
      box.append(controls, replyForm(node, task, "reject", true));
    } else {
      controls.append(act("Done", "button primary", "done", {}), more);
      more.append(opener("answer", "Answer in words"), opener("reject", "Reject"));
      box.append(controls, replyForm(node, task, "answer", true), replyForm(node, task, "reject", true));
    }
    // Archive: out of the list unanswered, restorable for 7 days; the session is sent nothing (#187).
    more.append(act("Archive", "button quiet", "archive", {}));
    return box;
  }

  // Archive or Restore, alone in its own actions row (an ended session's task, an archived one).
  function shelfActions(node, task, label, action) {
    const box = el("div", null, "actions");
    const button = el("button", label, "button quiet");
    button.type = "button";
    button.addEventListener("click", () => send(node, task, action, {}));
    box.append(button);
    return box;
  }

  // An archived task's row in the Archived group: its subject, when it is deleted, and Restore
  // where a session takes it from here (its own, or for an ended session's, a live one in its
  // project); otherwise where to restore it. An ended session's task may be numbered anew by
  // the session that takes it on, so that hint names no number.
  function archivedRow(task) {
    const node = el("article", null, "task archived-task");
    node.dataset.key = keyOf(task);
    node.dataset.sig = archivedSig(task);
    const title = el("h3", null, "task-title");
    title.append(el("span", "#" + task.id, "num"), " ", task.title);
    const body = el("div", null, "task-body");
    const day = new Date(task.deletes_ms).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
    body.append(el("p", project(task.root) + " · deleted on " + day, "task-meta"));
    const ended = task.session_state === "ended";
    if (ended ? task.via : task.endpoint) body.append(shelfActions(node, task, "Restore", "restore"));
    // TODO(deferred): #191 with no live session in the project, an ended session's task is restored only from Claude
    else if (ended) body.append(note("info", null, "Start a session in " + project(task.root) + " to restore it: from here, or under Archived in its /my-tasks."));
    else body.append(note("info", null, "Restore it in Claude: /my-tasks restore " + task.id + " in that session."));
    const receipt = el("div", null, "receipt");
    receipt.hidden = true;
    receipt.tabIndex = -1;
    body.append(receipt);
    node.append(title, body);
    return node;
  }

  const archivedRows = new Map(); // task key -> its row in the Archived group, kept across polls

  function archivedSig(task) {
    return task.version + "|" + task.session_state + "|" + task.endpoint + "|" + (task.via || "");
  }

  // The Archived group's rows: one per archived task, rebuilt when its task changed unless a
  // Restore is in flight there; a row whose task left the list goes, once nothing is in flight.
  function archivedNodes(archived) {
    const listed = new Set();
    const nodes = [];
    for (const task of archived) {
      const key = keyOf(task);
      listed.add(key);
      let node = archivedRows.get(key);
      const sig = archivedSig(task);
      if (!node || (node.dataset.sig !== sig && !node.classList.contains("sending"))) {
        node = archivedRow(task);
        archivedRows.set(key, node);
      }
      nodes.push(node);
    }
    for (const [key, node] of archivedRows) {
      if (listed.has(key)) continue;
      if (node.classList.contains("sending")) nodes.push(node);
      else archivedRows.delete(key);
    }
    return nodes;
  }

  function note(tone, head, line) {
    const box = el("div", null, "notice task-note");
    box.dataset.tone = tone;
    box.append(icon(tone === "info" ? "info" : "alert"));
    if (head) box.append(el("p", head, "receipt-head"));
    box.append(el("p", line));
    return box;
  }

  // `quietOff`: the note above the list already says every session has web replies off, so
  // such a card carries only its short label.
  function signature(task, quietOff) {
    return task.version + "|" + task.session_state + "|" + task.endpoint + "|" + (quietOff && !task.endpoint ? "q" : "") + "|" + (task.via || "");
  }

  function footer(task) {
    const short = "Session " + task.session_id.slice(0, 8) + " · " + project(task.root) + (task.profiles?.length ? " · " + task.profiles.join(", ") : "");
    if (!task.root || !task.root.includes("/")) return el("p", short, "task-meta");
    const box = el("details", null, "task-meta");
    const summary = el("summary");
    summary.append(icon("chevron"), short);
    box.append(summary, el("p", task.root, "path mono"));
    return box;
  }

  function card(task, quietOff) {
    const node = el("article", null, "task");
    node.dataset.key = keyOf(task);
    node.dataset.kind = task.kind;
    node.dataset.sig = signature(task, quietOff);
    node.id = domId("task", node.dataset.key);
    const titleId = domId("title", node.dataset.key);
    node.setAttribute("aria-labelledby", titleId);
    const title = el("h3", null, "task-title");
    title.id = titleId;
    node.dataset.layout = "full";
    node.append(fromLine(task), title);
    titleOf(node, task);
    const body = el("div", null, "task-body");
    body.id = domId("body", node.dataset.key);
    node.append(body);
    const ended = task.session_state === "ended";
    if (ended) body.append(reach("ended"));
    else if (!task.endpoint) body.append(reach("off"));
    body.append(el("p", task.why, "why"));
    if (task.done_when) {
      const done = el("p", null, "done-when");
      done.append(el("span", "Done when", "label"), task.done_when);
      body.append(done);
    }
    if (task.detail) body.append(detailOf(task));
    if (ended && task.via) {
      // A live session in the project takes it on to archive it, and tells Claude nothing (#187).
      body.append(note("info", null, "The task waits for the next session in " + project(task.root) + ". Answer it there, or archive it from here."));
      body.append(shelfActions(node, task, "Archive", "archive"));
    }
    // TODO(deferred): #191 with no live session in the project, an ended session's task is archived only from Claude
    else if (ended) body.append(note("info", null, "The task waits for the next session in " + project(task.root) + ". Answer it there; to archive it, start a session in " + project(task.root) + "."));
    else if (!task.endpoint && !quietOff) body.append(note("info", null, "Web answers are disabled for this session. Answer or archive it in Claude."));
    else if (task.endpoint) body.append(actionsOf(node, task));
    const receipt = el("div", null, "receipt");
    receipt.hidden = true;
    receipt.tabIndex = -1;
    body.append(receipt);
    // Every profile reaches the one store here, so the profile list tells nothing: the session
    // and its project folder do.
    body.append(footer(task));
    return node;
  }

  // The subject. In the compact list it is a button (subject, project, whether it can be
  // answered here, age) that opens the card in place; otherwise plain text.
  function titleOf(node, task) {
    const title = node.querySelector(".task-title");
    const subject = [el("span", "#" + task.id, "num"), " ", task.title];
    if (node.dataset.layout !== "compact") {
      title.replaceChildren(...subject);
      return;
    }
    const button = el("button", null, "row");
    button.type = "button";
    button.setAttribute("aria-controls", domId("body", node.dataset.key));
    const words = el("span", null, "row-subject");
    words.append(...subject);
    const meta = el("span", null, "row-meta");
    meta.append(el("span", project(task.root), "project"));
    const ended = task.session_state === "ended";
    if (ended || !task.endpoint) meta.append(el("span", "·", "sep"), el("span", ended ? "Session ended" : "Web answers off", "row-reach"));
    meta.append(el("span", "·", "sep"), el("span", ago(task.age_s), "row-age"));
    button.append(icon("chevron"), words, meta);
    button.addEventListener("click", () => {
      const key = node.dataset.key;
      if (node.classList.contains("open")) opened.delete(key);
      else opened.add(key);
      shape(node);
      fitDetails();
    });
    title.replaceChildren(button);
  }

  function hasDraft(node) {
    return Array.from(node.querySelectorAll("textarea")).some((input) => input.value !== "");
  }

  // The card in the list's layout: full, or a compact line that is open when the owner opened
  // it, or whenever it holds a draft, an answer in flight or an unconfirmed delivery.
  function shape(node) {
    const task = tasksByKey.get(node.dataset.key);
    const layout = compact ? "compact" : "full";
    if (task && node.dataset.layout !== layout) {
      node.dataset.layout = layout;
      node.classList.toggle("compact", compact);
      titleOf(node, task);
    }
    const open = !compact || opened.has(node.dataset.key) || doubtful.has(node.dataset.key) ||
      hasDraft(node) || node.classList.contains("sending") || Boolean(node.dataset.mode) ||
      node.querySelector(".task-body").contains(document.activeElement);
    node.classList.toggle("open", open);
    const button = node.querySelector(".task-title .row");
    if (button) button.setAttribute("aria-expanded", String(open));
  }

  // A card whose task the last poll did not list stays as it was, dimmed, saying so. After
  // DROP_AFTER polls a card kept for its draft says what that may mean and holds back its
  // buttons (the text stays to copy); an unconfirmed one keeps only "Retry same answer".
  function markAbsent(node, long) {
    node.classList.add("absent");
    let line = node.querySelector(".absent-note");
    if (!line) {
      line = el("p", null, "absent-note");
      node.querySelector(".task-title").after(line);
    }
    const settledAway = long && !doubtful.has(node.dataset.key);
    setText(line, settledAway
      ? "No longer listed: it was answered or withdrawn somewhere else, or its store could not be read. What you typed is still here."
      : "Not in the last update");
    if (settledAway && !node.classList.contains("closed")) {
      node.classList.add("closed");
      for (const button of node.querySelectorAll(".actions button, .reply button")) button.disabled = true;
    }
  }

  // Listed again: the card is whole again, as it was before the gap.
  function markListed(node) {
    if (!node.classList.contains("absent")) return;
    node.classList.remove("absent");
    node.querySelector(".absent-note").remove();
    if (node.classList.contains("closed")) {
      node.classList.remove("closed");
      if (!node.classList.contains("sending")) setControls(node, true);
    }
  }

  function isBusy(node) {
    // A card being typed in, or with an answer in flight, is left as it is.
    return node.classList.contains("sending") || node.contains(document.activeElement) || hasDraft(node);
  }

  // Puts `nodes` in `box` in order, moving only what is out of place, so a card that stays keeps
  // its focus, selection and draft (and the phone keyboard stays up).
  function place(box, nodes) {
    nodes.forEach((node, i) => {
      if (box.children[i] !== node) box.insertBefore(node, box.children[i] || null);
    });
    while (box.children.length > nodes.length) box.lastElementChild.remove();
  }

  // A card rebuilt for a newer version of its task keeps what was typed, the open reply mode and
  // the last receipt.
  function carryOver(old, node) {
    for (const text of old.querySelectorAll("textarea")) {
      const twin = node.querySelector('textarea[name="' + text.name + '"]');
      if (twin && text.value) twin.value = text.value;
    }
    if (old.dataset.mode && node.querySelector('form[data-mode="' + old.dataset.mode + '"]')) {
      openMode(node, old.dataset.mode, old.contains(document.activeElement));
    }
    const receipt = old.querySelector(".receipt");
    if (receipt && !receipt.hidden) node.querySelector(".receipt").replaceWith(receipt);
  }

  function emptyState() {
    const box = el("div", null, "empty");
    box.append(
      icon("tray"),
      el("p", "Nothing is waiting on you.", "empty-head"),
      el("p", "When a session asks you something, it shows up here within a few seconds.", "empty-line"),
    );
    return box;
  }

  // Kept across polls: the one-time note, the empty state and the ended group (whose open or
  // closed state the owner sets).
  const allOffNote = note(
    "info",
    "Web answers are off for every session here",
    "To answer from the dashboard, turn on the human-in-the-loop plugin’s “Answer endpoint” setting (in Claude’s /config), then restart the session.",
  );
  allOffNote.classList.add("all-off");
  const empty = emptyState();
  const endedGroup = el("details", null, "ended-group");
  const endedCount = el("span");
  const endedSummary = el("summary");
  endedSummary.append(icon("chevron"), endedCount);
  const endedList = el("div", null, "ended-list");
  endedGroup.append(endedSummary, endedList);
  endedGroup.addEventListener("toggle", fitDetails);
  // Archived tasks (#187), collapsed like the ended group, whose styling it shares.
  const archivedGroup = el("details", null, "ended-group archived-group");
  const archivedCount = el("span");
  const archivedSummary = el("summary");
  archivedSummary.append(icon("chevron"), archivedCount);
  const archivedList = el("div", null, "ended-list");
  archivedGroup.append(archivedSummary, archivedList);
  archivedGroup.addEventListener("toggle", fitDetails);

  function renderTasks(data) {
    taskList.removeAttribute("aria-busy");
    roots = new Map(data.tasks.map((task) => [task.session_id, task.root]));
    // An archived task is still open in its session, but waits on nobody: it is listed apart.
    const archived = data.tasks.filter((task) => task.archived_ms !== undefined);
    const archivedKeys = new Set(archived.map(keyOf));
    const open = data.tasks.filter((task) => task.archived_ms === undefined);
    const active = open.filter((task) => task.session_state !== "ended");
    const quietOff = active.length > 0 && active.every((task) => !task.endpoint);
    const order = Array.from(taskList.children);
    const live = new Set();
    const nodes = [];
    const endedNodes = [];
    for (const task of open) {
      const key = keyOf(task);
      live.add(key);
      tasksByKey.set(key, task);
      missing.delete(key);
      let node = cards.get(key);
      const old = node;
      const held = node && (doubtful.has(key) || node.classList.contains("gone"));
      if (node && node.dataset.sig !== signature(task, quietOff) && !answered.has(key) && ((!isBusy(node) && !held) || node.dataset.renew)) node = null;
      if (!node) {
        node = card(task, quietOff);
        if (old) carryOver(old, node);
        cards.set(key, node);
      } else {
        markListed(node);
        const age = node.querySelector(".from .age");
        if (age) age.textContent = "Asked " + ago(task.age_s);
        const rowAge = node.querySelector(".row-age");
        if (rowAge) setText(rowAge, ago(task.age_s));
      }
      // A card that just learned its session ended stays where its receipt was read.
      if (task.session_state === "ended" && !node.classList.contains("gone")) endedNodes.push(node);
      else nodes.push(node);
    }
    // Cards whose task left the list. One the session settled (an answer it took, a task it
    // said is closed or gone) stays a few seconds with its receipt. Any other stays as it was,
    // dimmed, since one poll proves nothing; it goes after DROP_AFTER polls in a row without
    // its task, unless its delivery is unconfirmed or it holds a draft or the focus.
    const now = Date.now();
    for (const [key, node] of cards) {
      if (live.has(key)) continue;
      const at = answered.get(key);
      let keep;
      if (!at && archivedKeys.has(key) && !isBusy(node)) {
        keep = false; // archived elsewhere (the pane, /my-tasks): it is listed under Archived now
      } else if (at) {
        keep = now - at < KEEP_ANSWERED_MS;
      } else {
        const polls = (missing.get(key) || 0) + 1;
        missing.set(key, polls);
        keep = polls < DROP_AFTER || doubtful.has(key) || isBusy(node);
        if (keep) markAbsent(node, polls >= DROP_AFTER);
      }
      if (keep) {
        if (node.parentNode === endedList) endedNodes.push(node);
        else nodes.splice(Math.min(Math.max(order.indexOf(node), 0), nodes.length), 0, node);
      } else {
        cards.delete(key);
        answered.delete(key);
        tasksByKey.delete(key);
        missing.delete(key);
        opened.delete(key);
      }
    }
    compact = nodes.length + endedNodes.length >= COMPACT_FROM;
    for (const node of nodes.concat(endedNodes)) shape(node);
    const listed = [];
    if (quietOff) listed.push(allOffNote);
    listed.push(...nodes);
    const nothing = nodes.length === 0 && endedNodes.length === 0;
    if (nothing) listed.push(empty);
    tasksHeading.classList.toggle("empty-heading", nothing); // the empty state says it alone
    if (endedNodes.length) {
      endedCount.textContent = endedNodes.length === 1 ? "1 from an ended session" : endedNodes.length + " from ended sessions";
      place(endedList, endedNodes);
      listed.push(endedGroup);
    }
    const shelf = archivedNodes(archived);
    if (shelf.length) {
      archivedCount.textContent = "Archived (" + archived.length + ")";
      place(archivedList, shelf);
      listed.push(archivedGroup);
    }
    if (data.skipped.files || data.skipped.entries) {
      listed.push(skippedLine(data.skipped, "malformed, or of an older layout no session answers through"));
    }
    place(taskList, listed);
    fitDetails();
    return active.length; // the count leads with what waits in a live session; the group counts the rest
  }

  // What a read skipped, and why, in one line.
  function skippedLine(skipped, entriesWhy) {
    const parts = [];
    if (skipped.files) parts.push(skipped.files + (skipped.files === 1 ? " store file" : " store files") + " (not a plain file, unreadable, over 2 MiB, or past one read's limits)");
    if (skipped.entries) parts.push(skipped.entries + (skipped.entries === 1 ? " entry" : " entries") + " (" + entriesWhy + ")");
    return el("p", "Skipped: " + parts.join(" and ") + ".", "skipped");
  }

  // The task a session's review put to the owner at round 4 (the progress mod's title), if
  // listed. Only that session's own task: the progress mod puts it from the session whose
  // review it is, and a PR number alone names no repository.
  function roundTask(tasks, session, pr) {
    const profiles = JSON.stringify([...(session.profiles || [])].sort());
    return tasks.find((task) => task.session_id === session.session_id && JSON.stringify([...(task.profiles || [])].sort()) === profiles && task.title.startsWith("PR #" + pr + " is at round "));
  }

  function jumpTo(task, pr) {
    const link = el("a", "PR #" + pr, "asked-link");
    link.href = "#" + domId("task", keyOf(task));
    link.addEventListener("click", () => {
      selectTab("tasks-tab", false);
      const target = document.getElementById(link.hash.slice(1));
      const group = target && target.closest("details");
      if (group) group.open = true;
      if (target && target.classList.contains("compact")) {
        opened.add(target.dataset.key);
        shape(target);
        fitDetails();
      }
    });
    return link;
  }

  // Only the native published view determines membership, section order and completion.
  // Details are reused across polls so open readers, focus and text selection remain intact.
  const sessionViews = new Map();
  const disclosureState = new Map();
  const disclosureExpanded = new Set();
  function githubLink(label, raw) {
    let url;
    try { url = new URL(raw); } catch (_) { return el("span", label); }
    if (!["https:", "http:"].includes(url.protocol) || url.hostname !== "github.com" || url.username || url.password || url.port) return el("span", label);
    const link = el("a", label);
    link.href = url.href; link.target = "_blank"; link.rel = "noopener noreferrer";
    return link;
  }
  function repoURL(repo, kind, number) {
    return typeof repo === "string" && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) && Number.isSafeInteger(number) && number > 0
      ? "https://github.com/" + repo + "/" + kind + "/" + number : "";
  }
  function rememberDetails(details, key, initial) {
    details.open = disclosureState.has(key) ? disclosureState.get(key) : initial;
    details.addEventListener("toggle", () => disclosureState.set(key, details.open));
  }
  function fact(facts, label, value) {
    if (value === undefined || value === null || value === "") return;
    facts.append(el("dt", label), value instanceof Node ? value : el("dd", value));
  }
  function listFact(facts, label, values, describeItem) {
    if (!Array.isArray(values) || !values.length) return;
    const dd = el("dd"); const list = el("ul");
    for (const value of values) list.append(el("li", describeItem(value)));
    dd.append(list); fact(facts, label, dd);
  }
  function activityOf(activity, session, tasks, sessionKey) {
    if (!activity) return null;
    const details = el("details", null, "activity");
    details.append(el("summary", "Session activity and reviews"));
    rememberDetails(details, sessionKey + ":activity", false);
    const facts = el("dl", null, "facts");
    fact(facts, "Goal", activity.goal);
    fact(facts, "Now", activity.now);
    if (activity.nowAt) fact(facts, "Activity", sourceAge("dd", activity.nowAt));
    listFact(facts, "Steps", activity.steps, (step) => step.text + " — " + step.status.replaceAll("_", " ") + (step.doing ? " · " + step.doing : ""));
    listFact(facts, "Agents", activity.agents, (agent) => [agent.type, agent.what, agent.endedAt ? "finished" : agent.isStale ? "stale" : "running", agent.lane, agent.last, agent.outcome].filter(Boolean).join(" · "));
    listFact(facts, "Updates", activity.marks, (mark) => mark.text + (mark.isBad ? " · needs attention" : ""));
    const rounds = new Map();
    for (const round of activity.rounds || []) rounds.set(round.pr, (rounds.get(round.pr) || 0) + 1);
    if (rounds.size) fact(facts, "Reviews", Array.from(rounds, ([pr, n]) => "PR #" + pr + " · " + n + (n === 1 ? " round" : " rounds")).join("\n"));
    if (activity.tasked?.length) {
      const dd = el("dd");
      activity.tasked.forEach((pr, i) => { if (i) dd.append(", "); const task = roundTask(tasks, session, pr); dd.append(task ? jumpTo(task, pr) : "PR #" + pr); });
      fact(facts, "Asked of you", dd);
    }
    if (!facts.children.length) facts.append(el("dd", "No published activity."));
    details.append(facts); return details;
  }
  const documents = new Map();
  function updateDocumentReader(node, state) {
    const button = node.querySelector("button");
    const kind = node.dataset.kind;
    button.setAttribute("aria-disabled", String(state.phase === "loading"));
    button.textContent = state.phase === "loading" ? "Reading…" : state.phase === "failed" ? "Retry " + kind + " read" : state.phase === "loaded" ? "Refresh " + kind + " text" : "Read " + kind + " and comments";
    const status = node.querySelector(".document-status");
    status.textContent = state.phase === "failed" ? "Couldn’t read this " + kind + ". Try again or open GitHub." : state.phase === "loading" ? "Reading description and the latest 20 comments…" : "";
    status.classList.toggle("bad", state.phase === "failed");
    const content = node.querySelector(".document-text");
    content.hidden = !state.text;
    content.textContent = state.text || "";
    const stamp = node.querySelector(".document-stamp");
    stamp.hidden = !state.fetchedAt;
    if (state.fetchedAt) { stamp.dataset.sourceAt = String(state.fetchedAt); stamp.dataset.prefix = "Text read "; stamp.textContent = "Text read " + since(state.fetchedAt); }
  }
  function documentReader(session, repo, number, kind, sessionKey) {
    const key = JSON.stringify([sessionKey, repo, number]);
    let state = documents.get(key);
    if (!state) { state = { sessionKey, phase: "idle", text: "", fetchedAt: 0 }; documents.set(key, state); }
    const node = el("section", null, "document-reader");
    node.dataset.documentKey = key; node.dataset.kind = kind;
    node.setAttribute("aria-label", (kind === "PR" ? "PR" : "Issue") + " #" + number + " description and comments");
    const button = el("button", null, "button quiet"); button.type = "button";
    const status = el("p", null, "document-status"); status.setAttribute("role", "status");
    const content = el("pre", null, "document-text");
    const stamp = el("p", null, "snapshot-age document-stamp");
    node.append(button, status, content, stamp);
    const repaint = () => {
      for (const view of progressList.querySelectorAll("[data-document-key]")) if (view.dataset.documentKey === key) updateDocumentReader(view, state);
    };
    button.addEventListener("click", async () => {
      if (state.phase === "loading") return;
      state.phase = "loading"; repaint();
      const query = new URLSearchParams({ session_id: session.session_id, profiles: JSON.stringify([...(session.profiles || [])].sort()), repo, number: String(number) });
      try {
        const result = await getJSON("/api/document?" + query);
        if (typeof result.text !== "string" || !Number.isFinite(result.fetched_at)) throw new Error("Invalid document response");
        state.text = result.text; state.fetchedAt = result.fetched_at; state.phase = "loaded";
      } catch (_) { state.phase = "failed"; }
      repaint();
    });
    updateDocumentReader(node, state);
    return node;
  }
  // heads: the goal's headings; a row whose parent is one says so, as the pane does (#198).
  function issueRow(ticket, repo, key, session, sessionKey, heads = []) {
    const item = el("li", null, "issue-item");
    const details = el("details", null, "issue");
    rememberDetails(details, key, false);
    const summary = el("summary");
    const state = icon(ticket.isOpen ? "live" : "ok");
    state.classList.add("issue-state"); if (!ticket.isOpen) state.classList.add("closed");
    const title = el("span", null, "issue-label");
    title.append(el("span", "#" + ticket.number, "issue-number"), ticket.title);
    if (ticket.parent && heads.some((head) => head.number === ticket.parent)) title.append(el("span", "in #" + ticket.parent, "issue-parent"));
    summary.append(state, title, icon("chevron"));
    details.append(summary);
    const body = el("div", null, "issue-detail");
    const links = el("div", null, "issue-links");
    links.append(githubLink("Open issue #" + ticket.number, ticket.url || repoURL(repo, "issues", ticket.number)), el("span", ticket.isOpen ? "Open issue" : ticket.isNotPlanned ? "Closed · not planned" : "Closed issue"));
    body.append(links, documentReader(session, repo, ticket.number, "issue", sessionKey));
    if (ticket.parent) body.append(el("p", "Parent issue #" + ticket.parent));
    const blockers = [...new Set([...(ticket.blockedBy || []), ...(ticket.declared || [])])];
    if (blockers.length) body.append(el("p", "Blocked by " + blockers.map((n) => "#" + n).join(", ")));
    if (ticket.labels?.length) body.append(el("p", "Labels: " + ticket.labels.join(", ")));
    if (ticket.pulls?.length) {
      const pulls = el("ul", null, "pulls");
      for (const pr of ticket.pulls) {
        const pull = el("li", null, "pull"); const head = el("div", null, "pull-heading");
        const stateLabel = el("span", pr.isDraft ? "Draft" : pr.state, "state-label"); stateLabel.dataset.state = pr.state;
        head.append(githubLink("PR #" + pr.number, repoURL(pr.repo || repo, "pull", pr.number)), stateLabel);
        const facts = el("div", null, "pull-facts");
        facts.append(el("span", "Checks: " + (pr.checks || "none"), pr.checks === "fail" ? "bad" : pr.checks === "running" ? "wait" : ""), el("span", "Review: " + (pr.review || "none"), pr.review === "changes requested" ? "bad" : ""));
        if (pr.branch || pr.base) facts.append(el("span", (pr.branch || pr.head?.slice(0, 7) || "head") + " → " + (pr.base || "base")));
        if (pr.head) facts.append(el("span", "Head " + pr.head.slice(0, 12), "mono"));
        if (pr.hasConflicts) facts.append(el("span", "Merge conflicts", "bad"));
        if (pr.mergedAt) facts.append(el("span", "Merged " + new Date(pr.mergedAt).toLocaleString()));
        pull.append(head, facts, documentReader(session, pr.repo || repo, pr.number, "PR", sessionKey));
        const ownerControl = ownerControls(session, pr.repo || repo, pr, sessionKey); if (ownerControl) pull.append(ownerControl);
        pulls.append(pull);
      }
      body.append(pulls);
    } else body.append(el("p", "No linked pull requests."));
    details.append(body); item.append(details); return item;
  }
  const sameOwnerRepo = (left, right) => typeof left === "string" && typeof right === "string" && left.toLowerCase() === right.toLowerCase();
  const ownerStates = new Map();
  const ownerContexts = new Map();
  function ownerControls(session, repo, pr, sessionKey) {
    const owner = session.snapshot?.owner;
    if (!owner) return null;
    const target = owner.targets?.find((one) => sameOwnerRepo(one.repo, repo) && one.pull === pr.number);
    const mine = sameOwnerRepo(owner.ship?.repo, repo) && owner.ship.pull === pr.number ? owner.ship : null;
    if (!target && !mine) return null;
    const key = JSON.stringify([sessionKey, repo, pr.number]);
    if (!ownerStates.has(key)) ownerStates.set(key, { busy: false, note: "", uncertain: false });
    ownerContexts.set(key, { session, sessionKey, repo, pr });
    const node = el("section", null, "owner-controls");
    node.dataset.ownerKey = key;
    node.setAttribute("aria-label", "Owner merge workflow for PR #" + pr.number);
    updateOwnerControl(node, key);
    return node;
  }
  function updateOwnerControl(node, key) {
    const context = ownerContexts.get(key); const state = ownerStates.get(key);
    if (!context || !state) return;
    const owner = context.session.snapshot?.owner;
    const target = owner?.targets?.find((one) => sameOwnerRepo(one.repo, context.repo) && one.pull === context.pr.number);
    const mine = sameOwnerRepo(owner?.ship?.repo, context.repo) && owner.ship.pull === context.pr.number ? owner.ship : null;
    const signature = JSON.stringify([owner?.enabled, target, owner?.ship]);
    if (node.dataset.signature !== signature) {
      const focused = node.contains(document.activeElement);
      node.dataset.signature = signature;
      node.replaceChildren(el("p", "Owner merge workflow", "owner-heading"));
      const controls = el("div", null, "owner-actions");
      const actionButton = (label, action, identity) => {
        const button = el("button", label, "button" + (action === "confirm" ? " primary" : " quiet"));
        button.type = "button"; button.dataset.ownerAction = action;
        button.addEventListener("click", () => sendOwnerAction(key, action, identity));
        controls.append(button);
      };
      const other = owner?.ship?.step === "working" && !mine ? owner.ship : null;
      if (mine?.step === "confirm") {
        node.append(el("p", (target?.isDraft ? "Mark ready (starts CI), then merge " : "Merge ") + mine.repo + "#" + mine.pull + " at " + mine.head.slice(0, 7) + " into " + mine.base + " once required checks pass?", "owner-confirm"));
        if (owner.enabled) {
          actionButton("Confirm merge", "confirm", mine);
          actionButton("Cancel merge confirmation", "cancel", mine);
        }
      } else if (mine?.step === "working" || mine?.step === "armed") {
        node.append(el("p", mine.note, "owner-receipt"));
      } else {
        if (mine?.note) node.append(el("p", mine.note, "owner-receipt bad"));
        if (other) node.append(el("p", "A merge job is running for " + other.repo + "#" + other.pull + ".", "owner-receipt"));
        else if (owner?.enabled && target) actionButton(mine?.step === "failed" ? "Try merge again" : "Merge when green", "prepare", target);
      }
      if (!owner?.enabled) node.append(el("p", "Web owner merge controls are off for this session.", "owner-receipt"));
      const note = el("p", "", "owner-note"); note.setAttribute("role", "status");
      node.append(controls, note);
      if (focused) {
        const next = node.querySelector("button") || node;
        if (next === node) node.tabIndex = -1;
        next.focus({ preventScroll: true });
      }
    }
    for (const button of node.querySelectorAll("button")) button.setAttribute("aria-disabled", String(state.busy || state.uncertain));
    node.querySelector(".owner-note").textContent = state.note;
  }
  function paintOwner(key) {
    for (const node of progressList.querySelectorAll("[data-owner-key]")) if (node.dataset.ownerKey === key) updateOwnerControl(node, key);
  }
  async function sendOwnerAction(key, action, identity) {
    const state = ownerStates.get(key); const context = ownerContexts.get(key);
    if (!state || !context || state.busy || state.uncertain) return;
    state.busy = true; state.note = action === "prepare" ? "Preparing confirmation…" : action === "cancel" ? "Cancelling confirmation…" : "Sending confirmed merge request…";
    paintOwner(key);
    let outcome, moved = false;
    try {
      const response = await fetch("/api/progress/owner", {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
        body: JSON.stringify({ session_id: context.session.session_id, profiles: [...(context.session.profiles || [])].sort(), request_id: randomHex(), action,
          repo: identity.repo, pull: identity.pull, head: identity.head, base: identity.base, confirmation_id: action === "prepare" ? "" : identity.confirmation_id }),
      });
      const reply = await response.json();
      // The selection changed after the action was sent: its outcome still stands.
      outcome = reply.outcome; moved = reply.selection_changed === true;
    } catch { outcome = "owner_unreachable"; }
    state.busy = false;
    const messages = { prepared: "Confirmation prepared.", started: "Merge request accepted by Progress.", cancelled: "Merge confirmation cancelled.", rejected: "The confirmation changed. Read the latest state before trying again.", selection_changed: "The session selection changed. Reload this page.", gone: "The native session ended.", disabled: "Web owner merge controls are off for this session.", busy: "A merge request is already running.", failed: "The native action failed. Read the latest state before trying again.", csrf: "Your access changed. Reload this page.", locked: "Your access expired. Reload this page to unlock it." };
    state.uncertain = outcome === "owner_timeout" || outcome === "owner_unreachable";
    state.note = state.uncertain ? "Merge request unconfirmed. Check the published state and GitHub before taking another action." : messages[outcome] || "Owner action unavailable. Read the latest state before trying again.";
    if (moved) state.note += " The session selection changed meanwhile. Reload this page before another action.";
    state.before = JSON.stringify(context.session.snapshot?.owner?.ship);
    paintOwner(key);
    await refresh();
  }
  function refreshOwnerContexts(session, sessionKey) {
    for (const [key, context] of ownerContexts) {
      if (context.sessionKey !== sessionKey) continue;
      context.session = session;
      const state = ownerStates.get(key);
      if (state?.uncertain && state.before !== JSON.stringify(session.snapshot?.owner?.ship)) { state.uncertain = false; state.note = ""; }
      paintOwner(key);
    }
  }

  const refreshStates = new Map();
  function refreshControls(session, sessionKey) {
    const state = refreshStates.get(sessionKey) || { busy: false, text: "" };
    refreshStates.set(sessionKey, state);
    const row = el("div", null, "source-controls");
    row.dataset.refreshKey = sessionKey;
    const button = el("button", state.busy ? "Refreshing…" : "Refresh GitHub", "button quiet");
    button.type = "button"; button.setAttribute("aria-disabled", String(state.busy));
    const status = el("span", state.text, "refresh-status"); status.setAttribute("role", "status");
    const paint = () => {
      for (const item of progressList.querySelectorAll("[data-refresh-key]")) {
        if (item.dataset.refreshKey !== sessionKey) continue;
        const control = item.querySelector("button");
        control.setAttribute("aria-disabled", String(state.busy)); control.textContent = state.busy ? "Refreshing…" : "Refresh GitHub";
        item.querySelector("[role=status]").textContent = state.text;
      }
    };
    button.addEventListener("click", async () => {
      if (state.busy) return;
      state.busy = true; state.text = "Reading GitHub…"; paint();
      let outcome;
      try {
        const response = await fetch("/api/progress/refresh", {
          method: "POST", credentials: "same-origin",
          headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
          body: JSON.stringify({ session_id: session.session_id, profiles: [...(session.profiles || [])].sort() }),
        });
        outcome = (await response.json()).outcome;
      } catch { outcome = "refresh_timeout"; }
      const messages = {
        refreshed: "GitHub refreshed.",
        no_endpoint: "Web refresh is off for this session. Enable Web refresh in Progress settings, then reopen Progress.",
        refresh_unavailable: "Web refresh is off for this session. Enable Web refresh in Progress settings, then reopen Progress.",
        busy: "A refresh is already running. Try again shortly.",
        gone: "This session ended. Reopen Progress in the current session.",
        failed: "GitHub refresh failed. The last published state is still shown.",
        refresh_timeout: "Refresh unconfirmed. Published updates will appear here.",
        refresh_unreachable: "Refresh unconfirmed. Check that Progress is running; published updates will appear here.",
        selection_changed: "The session selection changed. Reload this page before trying again.",
        csrf: "Your access changed. Reload this page before trying again.",
        locked: "Your access expired. Reload this page to unlock it.",
      };
      state.busy = false; state.text = messages[outcome] || "Refresh unavailable. Reload this page before trying again."; paint();
      if (outcome === "refreshed") await refresh();
    });
    row.append(button, status); return row;
  }
  function publishedSession(session, tasks, sessionKey) {
    const snap = session.snapshot;
    const node = el("article", null, "session");
    const head = el("h3", null, "session-head");
    head.append(snap.goal?.repo || "No enrolled goal", el("span", "Session " + session.session_id.slice(0, 8) + " · " + ((session.profiles || []).join(", ") || "shared store"), "mono"));
    node.append(head);
    if (!snap.view.total) {
      // Nothing enrolled: one line, without the goal title, count and bar that would read 0 of 0.
      node.append(el("p", "No enrolled issues. Add some with /progress add in Claude.", "quiet-line"));
      const stamp = el("p", null, "snapshot-age"); stamp.dataset.at = String(Number(snap.at)); updateSnapshotAge(stamp); node.append(stamp);
      const activity = activityOf(snap.activity, session, tasks, sessionKey); if (activity) node.append(activity);
      return node;
    }
    node.append(el("p", snap.goal?.title || "Selected issues", "goal-title"));
    const meta = el("p", null, "goal-meta");
    meta.append(el("span", snap.view.completed + " of " + snap.view.total + " issues closed", "completion"), el("span", "Issues only"));
    node.append(meta);
    const meter = el("div", null, "completion-track"); meter.setAttribute("role", "progressbar"); meter.setAttribute("aria-label", "Closed issues"); meter.setAttribute("aria-valuemin", "0"); meter.setAttribute("aria-valuemax", String(Math.max(1, snap.view.total))); meter.setAttribute("aria-valuenow", String(snap.view.completed));
    const fill = el("span", null, "completion-fill");
    // A finite number is the only value allowed into the style property.
    const percent = snap.view.total ? Math.min(100, Math.max(0, 100 * snap.view.completed / snap.view.total)) : 0;
    fill.style.setProperty("--complete", Number.isFinite(percent) ? percent + "%" : "0%"); meter.append(fill); node.append(meter);
    const stamp = el("p", null, "snapshot-age");
    const timestamp = Number(snap.at);
    stamp.dataset.at = String(timestamp); updateSnapshotAge(stamp); node.append(stamp);
    if (snap.goal?.error) node.append(note("wait", "Issue refresh failed", snap.goal.error + " · Showing the last published issue state."));
    if (snap.goal?.fetchedAt) node.append(sourceAge("p", snap.goal.fetchedAt, "GitHub last read "));
    if (snap.goal && session.profiles?.length) node.append(refreshControls(session, sessionKey));
    for (const section of snap.view.sections) {
      const details = el("details", null, "issue-group");
      const sectionKey = sessionKey + ":section:" + section.id;
      rememberDetails(details, sectionKey, section.fold !== "closed");
      const summary = el("summary"); summary.append(icon("chevron"), section.label, el("span", section.tickets.length, "group-count")); details.append(summary);
      const list = el("ol", null, "issue-list");
      const expanded = section.fold === "all" || disclosureExpanded.has(sectionKey);
      for (const [index, ticket] of section.tickets.entries()) {
        const row = issueRow(ticket, snap.goal?.repo || "", sessionKey + ":issue:" + section.id + ":" + ticket.number, session, sessionKey, snap.goal?.heads || []);
        if (!expanded && index >= 5) row.hidden = true;
        list.append(row);
      }
      if (section.tickets.length > 5) {
        const li = el("li"); const more = el("button", expanded ? "Show first 5" : "Show all " + section.tickets.length + " issues", "more-issues"); more.type = "button";
        more.setAttribute("aria-expanded", String(expanded));
        more.addEventListener("click", () => {
          const all = more.getAttribute("aria-expanded") !== "true";
          if (all) disclosureExpanded.add(sectionKey); else disclosureExpanded.delete(sectionKey);
          for (const [i, row] of Array.from(list.children).entries()) if (row !== li && i >= 5) row.hidden = !all;
          more.setAttribute("aria-expanded", String(all)); more.textContent = all ? "Show first 5" : "Show all " + section.tickets.length + " issues";
        }); li.append(more); list.append(li);
      }
      if (!section.tickets.length) list.append(el("li", "No issues in this group.", "empty"));
      details.append(list); node.append(details);
    }
    if (snap.goal?.heads?.length) {
      const heads = el("details", null, "activity"); heads.append(el("summary", "Parent issues · " + snap.goal.heads.length)); rememberDetails(heads, sessionKey + ":heads", false);
      const list = el("ol", null, "issue-list"); for (const ticket of snap.goal.heads) list.append(issueRow(ticket, snap.goal.repo, sessionKey + ":head:" + ticket.number, session, sessionKey, snap.goal.heads)); heads.append(list); node.append(heads);
    }
    const activity = activityOf(snap.activity, session, tasks, sessionKey); if (activity) node.append(activity);
    return node;
  }
  function sourceAge(tag, at, prefix = "") {
    const stamp = el(tag, prefix + since(at), tag === "p" ? "snapshot-age" : "");
    stamp.dataset.sourceAt = String(at);
    stamp.dataset.prefix = prefix;
    return stamp;
  }
  function updateSourceAges() {
    for (const stamp of progressList.querySelectorAll(".snapshot-age[data-at]")) updateSnapshotAge(stamp);
    for (const stamp of progressList.querySelectorAll("[data-source-at]")) stamp.textContent = stamp.dataset.prefix + since(Number(stamp.dataset.sourceAt));
  }
  function updateSnapshotAge(stamp) {
    const at = Number(stamp.dataset.at);
    const stale = !Number.isFinite(at) || at <= 0 || Date.now() - at > 120000;
    stamp.dataset.stale = String(stale);
    stamp.textContent = (stale ? "Snapshot may be stale · " : "Snapshot published ") + (at > 0 ? since(at) : "time unknown") + (stale ? ". Connection updates do not republish session state." : "");
  }
  // Sessions not worth a card: one line each in a disclosure kept across polls, closed until
  // opened. Ended and legacy sessions, sessions no task store holds (`unknown`), and quiet ones
  // whose snapshot is over an hour old: their snapshot is old news, not a live warning.
  const QUIET_FOLD_MS = 3600000;
  function foldsAway(session, published) {
    if (!published || ["ended", "unknown"].includes(session.session_state)) return true;
    const at = Number(session.snapshot.at);
    return session.session_state === "quiet" && !(Date.now() - at <= QUIET_FOLD_MS);
  }
  const earlier = el("details", null, "earlier");
  const earlierSummary = el("summary");
  const earlierCount = el("span");
  earlierSummary.append(icon("chevron"), earlierCount);
  const earlierList = el("ul", null, "earlier-list");
  earlier.append(earlierSummary, earlierList);
  function shortGoal(session, published) {
    if (published) return [session.snapshot.goal?.repo, session.snapshot.goal?.title].filter(Boolean).join(" · ") || "No enrolled issues";
    if (!session.goal) return "No saved goal";
    const numbers = (session.goal.numbers || []).map((n) => "#" + n);
    return session.goal.repo + " " + numbers.slice(0, 3).join(", ") + (numbers.length > 3 ? " +" + (numbers.length - 3) : "");
  }
  function earlierRow(session, published) {
    const row = el("li", null, "earlier-row");
    // A published session that has not ended says when it last published; the others, when
    // their session was last seen.
    const publishedAt = published && session.session_state !== "ended";
    const seen = Number(publishedAt ? session.snapshot.at : session.seen_ms ?? (published ? session.snapshot.at : NaN));
    const words = [];
    if (Number.isFinite(seen) && seen > 0) words.push((publishedAt ? "Last published " : "Last seen ") + since(seen));
    words.push(shortGoal(session, published));
    // A session that ended can no longer publish, so nothing here asks it to.
    if (!published && session.session_state !== "ended") words.push("Not published");
    const what = el("span", words.join(" · "), "earlier-what"); what.title = what.textContent;
    row.append(el("span", session.session_id.slice(0, 8), "mono"), what);
    return row;
  }
  function renderProgress(data, tasks) {
    const nodes = []; const folded = []; const live = new Set(); let total = 0;
    for (const session of data.sessions) {
      const sessionKey = JSON.stringify([session.session_id, [...(session.profiles || [])].sort()]);
      const published = session.snapshot?.version === 1 && session.snapshot.view && Array.isArray(session.snapshot.view.sections);
      if (foldsAway(session, published)) { folded.push(earlierRow(session, published)); continue; }
      live.add(sessionKey);
      refreshOwnerContexts(session, sessionKey);
      total += session.snapshot.view.total;
      const signature = JSON.stringify([session, tasks.filter((t) => t.session_id === session.session_id).map((t) => [t.id, t.title])]);
      let stored = sessionViews.get(sessionKey);
      // Avoid replacing a focused reader on an unrelated polling tick.
      if (!stored || stored.signature !== signature) {
        const node = publishedSession(session, tasks, sessionKey);
        if (stored?.node.contains(document.activeElement)) {
          // Apply changed state after focus leaves instead of destroying keyboard position.
          stored.node.addEventListener("focusout", () => setTimeout(refresh, 0), { once: true });
        } else { stored = {signature, node}; sessionViews.set(sessionKey, stored); }
      }
      nodes.push(stored.node);
    }
    for (const key of sessionViews.keys()) if (!live.has(key)) sessionViews.delete(key);
    for (const key of refreshStates.keys()) if (!live.has(key)) refreshStates.delete(key);
    for (const [key, context] of ownerContexts) if (!live.has(context.sessionKey)) { ownerContexts.delete(key); ownerStates.delete(key); }
    for (const [key, state] of documents) if (!live.has(state.sessionKey)) documents.delete(key);
    for (const cancelled of data.cancelled || []) { const node = el("div", null, "cancelled"); node.append(icon("fail"), el("p", cancelled.note)); nodes.push(node); }
    if (!nodes.length && folded.length) nodes.push(el("p", "No session is publishing progress now.", "quiet-line"));
    else if (!nodes.length) { const empty = el("div", null, "empty"); empty.append(icon("tray"), el("p", "No published progress yet", "empty-head"), el("p", "Deliberately enroll issues with /progress add in Claude. Published progress appears here automatically.", "empty-line")); nodes.push(empty); }
    if (folded.length) {
      setText(earlierCount, "Earlier sessions (" + folded.length + ")");
      earlierList.replaceChildren(...folded);
      nodes.push(earlier);
    }
    if (data.skipped?.files || data.skipped?.entries) nodes.push(skippedLine(data.skipped, "malformed"));
    progressList.removeAttribute("aria-busy"); place(progressList, nodes);
    document.getElementById("progress-count").textContent = String(total);
    updateSourceAges();
  }

  // --- usage: every profile's wrap-up readings, read-only -------------------------------------

  const usageList = document.getElementById("usage-list");
  const usageTab = document.getElementById("usage-tab");
  const usageCount = document.getElementById("usage-count");
  let lastUsage = null;

  function spanWords(seconds) {
    const minutes = Math.max(1, Math.ceil(seconds / 60));
    if (minutes < 60) return minutes + " min";
    const hours = Math.floor(minutes / 60);
    if (hours >= 24) return Math.floor(hours / 24) + " d " + (hours % 24) + " h";
    return hours + " h " + String(minutes % 60).padStart(2, "0") + " min";
  }
  function clockOf(ms) {
    return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  }
  function weekdayClock(ms) {
    return new Date(ms).toLocaleDateString([], { weekday: "short" }) + " " + clockOf(ms);
  }
  // The window as of this browser's clock, so reading ages and resets never freeze between polls.
  function windowState(win, staleAfter, now) {
    if (win.resets_at * 1000 <= now) return "reset";
    return now - win.observed_at * 1000 > staleAfter * 1000 ? "stale" : "fresh";
  }
  function usageLine(name, win, staleAfter, now) {
    const line = el("div", null, "usage-win");
    line.append(el("span", name, "usage-name"));
    if (!win) { line.append(el("span", "No reading yet", "usage-sub")); return line; }
    const state = windowState(win, staleAfter, now);
    line.dataset.state = state;
    if (state === "reset") {
      line.append(el("span", "Window has reset since last reading", "usage-sub"));
      return line;
    }
    const percent = Math.round(win.percent);
    const over = win.enabled && win.percent >= win.threshold;
    const meter = el("span", null, "usage-meter");
    meter.setAttribute("aria-hidden", "true");
    meter.dataset.over = String(over);
    meter.style.setProperty("--pct", Math.min(100, win.percent) + "%");
    meter.append(el("span", null, "usage-fill"));
    if (win.enabled) { // no threshold mark where wrap-up does not act on this window
      meter.style.setProperty("--tick", Math.min(100, win.threshold) + "%");
      meter.append(el("span", null, "usage-tick"));
    }
    const pct = el("span", percent + "%", "usage-pct");
    pct.setAttribute("aria-hidden", "true");
    const resetMs = win.resets_at * 1000;
    const reset = name === "5 hours" ? "resets in " + spanWords((resetMs - now) / 1000) : "resets " + weekdayClock(resetMs);
    const age = Math.max(0, Math.round((now - win.observed_at * 1000) / 1000));
    const read = "read " + (age < 60 ? "just now" : ago(age)) + (state === "stale" ? ", may be higher now" : "");
    const sub = el("span", reset + " · " + read, "usage-sub");
    sub.title = "Resets " + new Date(resetMs).toLocaleString();
    sub.setAttribute("aria-hidden", "true");
    const rule = win.enabled ? "wrap-up threshold " + Math.round(win.threshold) + "%" : "wrap-up off";
    const spoken = el("span", name + ": " + percent + "%, " + rule + ", " + reset + ", " + read, "visually-hidden");
    line.append(meter, pct, sub, spoken);
    return line;
  }
  function usageRow(row, staleAfter, now) {
    const item = el("li", null, "issue-item usage-row");
    item.dataset.state = row.state;
    const head = el("div", null, "usage-head");
    head.append(el("strong", row.label, "usage-label"), el("span", row.path, "mono usage-path"));
    const chips = el("span", null, "usage-chips");
    const chip = (text, tone) => { const one = el("span", text, "state-label"); if (tone) one.dataset.tone = tone; chips.append(one); };
    const shown = Object.values(row.windows).filter(Boolean);
    const live = shown.filter((win) => windowState(win, staleAfter, now) !== "reset");
    const latched = row.latch.on && row.latch.until * 1000 > now;
    if (latched) chip("Wrap-up latched until " + clockOf(row.latch.until * 1000), "warn");
    if (live.length && live.every((win) => windowState(win, staleAfter, now) === "stale")) chip("Stale");
    if (row.state === "none") chip("No readings yet");
    if (row.state === "unreadable") chip("Unreadable", "warn");
    head.append(chips);
    item.append(head);
    if (row.state === "none") {
      item.append(el("p", "Shows up after a session in this profile gets a reply from Claude with the usage collector installed.", "usage-help"));
      return item;
    }
    if (row.state === "unreadable") {
      item.append(el("p", "Usage readings could not be read.", "usage-help"));
      return item;
    }
    item.append(usageLine("5 hours", row.windows.five_hour, staleAfter, now), usageLine("7 days", row.windows.seven_day, staleAfter, now));
    const flag = (text) => { const warn = el("p", text, "usage-flag"); warn.dataset.tone = "warn"; item.append(warn); };
    const acting = (win) => win && win.enabled && windowState(win, staleAfter, now) !== "reset";
    // At or over the threshold but not latched (wrap-up latches only on a fresh reading with
    // enough time left): the meter's colour gets words too.
    const five = row.windows.five_hour;
    if (acting(five) && five.percent >= five.threshold && !latched) flag("5-hour use at or over " + Math.round(five.threshold) + "%, wrap-up not latched");
    // The weekly warning is the wrap-up engine's (the server's attention list).
    const week = row.windows.seven_day;
    if (acting(week) && row.attention.includes("weekly")) flag("Weekly use over " + Math.round(week.threshold) + "%");
    if (!row.enabled) item.append(el("p", "Wrap-up off for this profile", "usage-help"));
    return item;
  }
  function renderUsage(data) {
    lastUsage = data;
    const now = Date.now();
    const available = Boolean(data && data.available);
    usageTab.hidden = !available;
    if (!available) {
      usageList.replaceChildren();
      if (!document.getElementById("usage").hidden) selectTab("progress-tab", false);
      return;
    }
    const count = data.attention;
    usageCount.hidden = !(count > 0);
    setText(usageCount, String(count));
    usageTab.setAttribute("aria-label", count > 0 ? "Usage, " + count + (count === 1 ? " profile needs attention" : " profiles need attention") : "Usage");
    const list = el("ul", null, "issue-list");
    for (const row of data.profiles) list.append(usageRow(row, data.stale_after_s, now));
    // Rows change only when what they show changes, so a reset time's tooltip survives polls.
    if (!usageList.firstChild || !usageList.firstChild.isEqualNode(list)) usageList.replaceChildren(list);
  }

  function loadFailed(error) {
    const box = el("div", null, "notice");
    box.dataset.tone = "fail";
    const row = el("div", null, "receipt-actions");
    const again = el("button", "Try now", "button");
    again.type = "button";
    again.addEventListener("click", refresh);
    row.append(again);
    box.append(icon("alert"), el("p", "Couldn’t load Overview", "receipt-head"), el("p", failureWords(error) + ". Trying again every 5 seconds."), row);
    taskList.removeAttribute("aria-busy");
    taskList.replaceChildren(box);
    progressList.replaceChildren(el("p", "Nothing to show until the Overview server answers.", "empty-line"));
  }

  async function refresh() {
    updateSourceAges();
    const turn = ++asked;
    if (lastGood) checked.textContent = freshness(); // ages while a refresh is out
    try {
      // Usage is a separate read: if it fails the other tabs stay, and the Usage tab keeps what it had.
      const [tasks, progress, usage] = await Promise.all([getJSON("/api/tasks"), getJSON("/api/progress"), getJSON("/api/usage").catch((error) => { if (error.kind === "locked") throw error; return null; })]);
      if (turn < shown) return; // a newer view is already on screen: never roll it back
      shown = turn;
      const count = renderTasks(tasks);
      renderProgress(progress, tasks.tasks);
      if (usage || lastUsage) renderUsage(usage || lastUsage); // once a poll; old readings still age
      loaded = true;
      failing = false;
      lastGood = Date.now();
      feedNotice.hidden = true;
      document.getElementById("tasks-count").textContent = String(count);
      showBar("", "live", "Connected");
      showAttention(count + (lastUsage?.available && lastUsage.attention > 0 ? lastUsage.attention : 0));
    } catch (error) {
      if (error.kind === "locked" || turn < shown) return;
      shown = turn;
      failing = true;
      if (lastUsage) renderUsage(lastUsage); // readings still age while the server is away
      const words = failureWords(error);
      showBar("fail", "alert", words);
      if (!loaded) {
        loadFailed(error);
      } else {
        feedNotice.dataset.tone = "wait";
        feedNotice.replaceChildren(icon("retry"), el("p", "Showing what was there at " + clock(lastGood) + ". " + words + "; trying again every 5 seconds."));
        feedNotice.hidden = false;
      }
    }
  }

  refresh();
  setInterval(refresh, POLL_MS);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refresh();
  });
})();
