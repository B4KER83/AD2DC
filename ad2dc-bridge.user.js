// ==UserScript==
// @name         AutoDarts ↔ DartCounter Bridge (Dart-by-Dart)
// @namespace    autodarts.dartcounter.bridge.dbd
// @version      1.95.0
// @description  Read darts from AutoDarts and enter EACH dart individually into DartCounter's segment keypad, so checkout suggestions update live.
// @match        http://127.0.0.1:3180/*
// @match        http://192.168.*:3180/*
// @match        https://app.dartcounter.net/*
// @run-at       document-idle
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addValueChangeListener
// @grant        GM_registerMenuCommand
// @grant        GM_notification
// @grant        GM_unregisterMenuCommand
// @grant        GM_xmlhttpRequest
// @grant        GM_info
// @grant        unsafeWindow
// @connect      raw.githubusercontent.com
// @connect      127.0.0.1
// @connect      localhost
// @updateURL    https://raw.githubusercontent.com/B4KER83/AD2DC/main/ad2dc-bridge.user.js
// @downloadURL  https://raw.githubusercontent.com/B4KER83/AD2DC/main/ad2dc-bridge.user.js
// ==/UserScript==

(function () {
  "use strict";

  const CFG = {
    autodartsSpanClass: "css-1ny2kle",
    pollIntervalMs: 150,
    storeDartKey: "autodarts_dart_seq",
    storeTakeoutKey: "autodarts_takeout_seq",
    notify: true,
    debug: true, // logs every raw slot change so we can see exactly what Autodarts outputs
    updateUrl: "https://raw.githubusercontent.com/B4KER83/AD2DC/main/ad2dc-bridge.user.js" // keep in sync with @updateURL/@downloadURL above
  };

  const MIN_TOP = 10; // never let the drag box go above this, so it can't end up hidden off the top of the page

  // --- Caller: plays a .wav for each dart the instant AutoDarts detects
  // it — this is a quick test, so for now it only handles plain 1-20
  // (ignoring Single/Double/Treble) and does nothing for Bull/Outer/Miss,
  // since those files aren't uploaded yet.
  const CALLER_BASE_URL = "https://raw.githubusercontent.com/B4KER83/AD2DC/main/";
  let callerEnabled = GM_getValue("caller_enabled", true);
  const callerAudioCache = {};

  // Shared across tabs the same way bridge_state is — the toggle button
  // lives in the DartCounter tab's UI, but playback happens over on the
  // AutoDarts side, so both need to agree on the current state via GM
  // storage rather than a plain in-memory variable.
  function setCallerEnabled(v) {
    const requested = !!v;
    GM_setValue("caller_enabled", requested);
  }

  GM_addValueChangeListener("caller_enabled", (n, o, v) => {
    callerEnabled = !!v;
    log("Caller:", callerEnabled ? "enabled" : "disabled");
    updateCallerUI();
  });

  // Every achievable single-dart score: singles 1-20, plus every double/
  // treble total above 20, plus Outer (25) and Bull (50). This is the full
  // set of .wav files now in the repo.
  const CALLER_EXTRA_SCORES = [21, 22, 24, 25, 26, 27, 28, 30, 32, 33, 34, 36, 38, 39, 40, 42, 45, 48, 50, 51, 54, 57, 60];

  function preloadCallerAudio() {
    const scores = [];
    for (let n = 1; n <= 20; n++) scores.push(n);
    for (const n of CALLER_EXTRA_SCORES) scores.push(n);

    for (const n of scores) {
      const url = CALLER_BASE_URL + n + ".wav";
      const audio = new Audio(url);
      audio.preload = "auto";
      // Without this, a missing/misnamed/broken file just fails to play
      // with zero explanation — silent in the exact way we've been
      // burned by elsewhere in this script. Log it clearly so a bad file
      // shows up immediately instead of looking like a matching problem.
      audio.addEventListener("error", () => {
        const err = audio.error;
        log("Caller: FAILED to load", n + ".wav", "from", url, "-", err ? "code " + err.code : "unknown error");
      });
      callerAudioCache[n] = audio;
    }
    log("Caller: preloaded", scores.length, "audio files from", CALLER_BASE_URL);
  }

  // Computes the actual score value a parsed dart is worth — Single 7 ->
  // 7, Double 17 -> 34, Treble 20 -> 60, Bull -> 50, Outer -> 25. This is
  // what the caller announces, not the base board number (a Treble 20
  // calls "sixty", not "twenty"). Returns null for MISS, since there's no
  // sound file for that yet.
  function extractCallerScore(parsed) {
    if (!parsed) return null;
    if (parsed.tab === "MISS") return null;
    if (parsed.tab === "Bull") return 50;
    if (parsed.tab === "Outer") return 25;
    if (parsed.tab === "Single") return parsed.num;
    if (parsed.tab === "Double") return parsed.num * 2;
    if (parsed.tab === "Treble") return parsed.num * 3;
    return null;
  }

  function playCallerNumber(num) {
    if (!callerEnabled) return;
    const audio = callerAudioCache[num];
    if (!audio) { log("Caller: no sound file loaded for", num); return; }
    try {
      audio.currentTime = 0; // restart in case the same number gets called again quickly
      const playPromise = audio.play();
      const t0 = performance.now();
      if (playPromise && playPromise.then) {
        playPromise
          .then(() => log("Caller: played", num, "(" + Math.round(performance.now() - t0) + "ms to start)"))
          .catch(e => log("Caller: playback BLOCKED or failed for", num, "-", e.message));
      }
    } catch (e) {
      log("Caller: playback error for", num, "-", e.message);
    }
  }

  function log(...args) { console.log("[AD2DC-DBD]", ...args); }

  // --- Force DartCounter's own "Auto submit" setting OFF — it conflicts with this bridge ---
  function findToggleRowByLabel(labelText) {
    const wanted = labelText.trim().toLowerCase();
    const rows = document.querySelectorAll("div.flex.cursor-pointer.items-center.justify-between");
    for (const row of rows) {
      const labelEl = row.querySelector(".flex-1");
      if (labelEl && (labelEl.textContent || "").trim().toLowerCase() === wanted) {
        return row.querySelector("button[dctoggleswitch]");
      }
    }
    return null;
  }

  function enforceDartCounterAutoSubmitOff() {
    const toggle = findToggleRowByLabel("Auto submit");
    if (!toggle) return; // Settings page isn't open right now
    const isOn = toggle.getAttribute("aria-checked") === "true";
    if (isOn) {
      clickEl(toggle);
      log("DartCounter's own Auto submit setting was ON — switched it off");
      notify("AD2DC-Bridge", "Turned off DartCounter's own Auto Submit setting");
    }
  }

  function notify(title, text, isError = false) {
    if (!CFG.notify) return;
    try {
      GM_notification({ title, text, timeout: isError ? 8000 : 3000 });
    } catch (e) { log("Notification failed:", e); }
  }

  // --- Force DartCounter's own input mode to dart-by-dart (segment keypad) ---
  function findDartCounterModeToggle() {
    const containers = document.querySelectorAll("app-select-keyboard-dropdown");
    if (containers.length === 0) return null;
    if (containers.length > 1) log("NOTE: found", containers.length, "app-select-keyboard-dropdown elements — using the first");
    // current pages: <button aria-label="Select keyboard">; older pages: a div.cursor-pointer
    return containers[0].querySelector('button[aria-label="Select keyboard"], button[aria-haspopup="menu"]') ||
      containers[0].querySelector("div.relative.cursor-pointer.p-2\\.5");
  }

  // Two earlier attempts assumed the option list rendered near the toggle
  // in the DOM tree (first as a child container, then as a direct sibling)
  // — both were wrong; the icon never appeared there, however long we
  // waited. DartCounter likely renders the dropdown content elsewhere in
  // the page entirely (a common "portal" pattern for popups), so instead
  // of guessing a location, search the WHOLE page for the icon.
  function findDartCounterModeOptionAnywhere(toggle, iconClass) {
    const spans = document.querySelectorAll("span.flex." + iconClass);
    for (const span of spans) {
      if (toggle && toggle.contains(span)) continue; // skip the closed toggle's own current-mode icon, if it happens to match
      const row = span.closest("div.relative.flex.flex-none.cursor-pointer") || span.parentElement;
      if (row) return row;
    }
    return null;
  }

  // Newer DartCounter pages list the input modes as a menu of
  // <button role="menuitemradio" aria-label="single|dartboard|hotkeys|..."> —
  // "single" is dart-by-dart (segment keypad). The dart-by-dart keypad itself
  // is <app-single-dart-keyboard>, so its presence means we're already there.
  const findSingleModeOption = () => document.querySelector('button[role="menuitemradio"][aria-label="single"]');

  function findModeToggleFallback() {
    const t = findDartCounterModeToggle();
    if (t) return t;
    // the picker button shows the current mode's icon (icon-keyboard_*) outside the menu items
    for (const ic of document.querySelectorAll('[class*="icon-keyboard"]')) {
      if (ic.closest('[role="menuitemradio"]')) continue;
      const b = ic.closest('button, [role="button"], .cursor-pointer');
      if (b) return b;
    }
    return null;
  }

  async function tryEnforceDartCounterInputMode() {
    if (document.querySelector("app-single-dart-keyboard")) {
      log("DartCounter input mode already dart-by-dart — nothing to do");
      return true;
    }
    let toggle = null, opened = false;
    let opt = findSingleModeOption();
    if (!opt) {
      toggle = findModeToggleFallback();
      if (!toggle) {
        log("enforceDartCounterInputMode: no keyboard-mode picker found");
        return !location.pathname.includes("/game/"); // not in a game: nothing to retry; in a game: try again
      }
      log("enforceDartCounterInputMode: opening the input-mode menu...");
      clickEl(toggle);
      opened = true;
      opt = await waitFor(() => findSingleModeOption() || findDartCounterModeOptionAnywhere(toggle, "icon-keyboard_single"), 40, 100);
    }
    if (!opt) {
      log("FAILED — dart-by-dart ('single') option not found");
      if (opened && toggle) clickEl(toggle); // best effort: close the menu again
      return false;
    }
    clickEl(opt.closest("button") || opt);
    const ok = await waitFor(() => document.querySelector("app-single-dart-keyboard"), 30, 100);
    if (ok) log("Switched DartCounter input mode to dart-by-dart");
    else log("Clicked the dart-by-dart option but the dart-by-dart keypad did not appear");
    return !!ok;
  }

  // The first attempt right after the Bridge turns on sometimes misses —
  // the page seems to still be settling — but a second attempt shortly
  // after reliably succeeds. Retry automatically instead of requiring a
  // manual toggle-off-and-on.
  async function enforceDartCounterInputMode(maxAttempts = 3) {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const ok = await tryEnforceDartCounterInputMode();
      if (ok) return;
      if (attempt < maxAttempts) {
        log("enforceDartCounterInputMode: attempt", attempt, "failed — retrying...");
        await new Promise(r => setTimeout(r, 800));
      }
    }
    log("enforceDartCounterInputMode: gave up after", maxAttempts, "attempts");
    notify("AD2DC Error", "Could not switch DartCounter to dart-by-dart mode — set it manually", true);
  }

  // --- Keep-alive: Chrome throttles timers hard in background/inactive
  // tabs, which is why things get slow when only one window is in focus.
  // A tab actively playing audio is exempt from that throttling, even at
  // zero volume — so we start a silent oscillator while the bridge is on.
  let keepAliveCtx = null;
  let keepAliveOsc = null;

  function startKeepAlive() {
    if (keepAliveCtx) return; // already running
    try {
      keepAliveCtx = new (window.AudioContext || window.webkitAudioContext)();
      const gain = keepAliveCtx.createGain();
      gain.gain.value = 0; // silent — this is purely to avoid tab throttling
      keepAliveOsc = keepAliveCtx.createOscillator();
      keepAliveOsc.connect(gain);
      gain.connect(keepAliveCtx.destination);
      keepAliveOsc.start();
      log("Keep-alive audio started");

      // Browsers require a user gesture on THIS tab before audio can
      // actually start — a click that happened in the other tab doesn't
      // count. If it's suspended, resume on the first genuine interaction
      // here instead.
      if (keepAliveCtx.state === "suspended") {
        const resumeOnce = () => {
          keepAliveCtx.resume();
          document.removeEventListener("click", resumeOnce);
          document.removeEventListener("keydown", resumeOnce);
        };
        document.addEventListener("click", resumeOnce, { once: true });
        document.addEventListener("keydown", resumeOnce, { once: true });
      }
    } catch (e) {
      log("Keep-alive audio failed to start:", e);
    }
  }

  function stopKeepAlive() {
    if (keepAliveOsc) { try { keepAliveOsc.stop(); } catch (e) {} keepAliveOsc = null; }
    if (keepAliveCtx) { try { keepAliveCtx.close(); } catch (e) {} keepAliveCtx = null; }
  }

  // --- Bridge on/off state (same pattern as original) ---
  let bridgeEnabled = false;
  let autoSubmitEnabled = false; // auto-set true when Bridge turns on; can be toggled off manually after
  let pollIntervalId = null;
  let seq = 0;
  let takeoutSeq = 0; // shared with the simulate-test hooks below, not just startAutodartsProducer

  // A fresh ID each time this script instance loads — i.e. each time the
  // embedded AutoDarts iframe starts fresh. Sequence numbers alone can't
  // tell "an old duplicate" apart from "the producer silently restarted
  // and its counter began again at 1" (e.g. the iframe reloading on its
  // own, not via a Bridge toggle) — both look like seq <= lastSeqHandled.
  // Embedding this in every published event lets the consumer tell the
  // difference and reset its own tracking when a genuinely new session
  // shows up, instead of discarding real new darts as duplicates.
  function makeSessionId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }
  const producerSessionId = makeSessionId();

  function setBridgeEnabled(v) {
    const requested = !!v;
    if (requested === bridgeEnabled) return;
    bridgeEnabled = requested;
    GM_setValue("bridge_state", requested); // persistent — not just a one-shot pulse
    if (requested) onBridgeEnabled(); else onBridgeDisabled();
  }

  async function onBridgeEnabled() {
    startKeepAlive();
    if (isDartCounter) {
      setToggleConnecting(true);
      // Prefer the board's local API (works with AutoDarts v1 and v2); only
      // fall back to the old embedded web page if the API isn't reachable.
      const boardState = await probeBoardApi();
      if (!boardState) showAutodartsFrame(); // starts loading now — needs a moment before its heartbeat appears
      // Run these one after another, not overlapping — clicking the
      // Settings page's Auto Submit toggle at the same time as opening the
      // input-mode dropdown was interfering with it, causing extra retries.
      await enforceDartCounterInputMode();
      enforceDartCounterAutoSubmitOff();
      const ready = boardState ? true : await waitForAutodartsReady();
      if (!ready) {
        bridgeEnabled = false;
        setToggleConnecting(false);
        updateToggleUI(false);
        hideAutodartsFrame();
        notify("AutoDarts not found", "Couldn't reach AutoDarts at " + adBase() + " — is it running? (Tampermonkey menu: Set AutoDarts address)", true);
        return;
      }
      notify("AD2DC-Bridge (dart-by-dart)", "ready - waiting for darts");
      setToggleConnecting(false);
      updateToggleUI(true);
      autoSubmitEnabled = true;
      updateAutoSubmitUI();
      startDartCounterConsumer();
      if (boardState) startApiPoller();
    } else if (isAutoDarts) {
      startAutodartsProducer();
    }
  }

  function onBridgeDisabled() {
    stopKeepAlive();
    if (isDartCounter) {
      notify("AD2DC-Bridge", "disabled");
      setToggleConnecting(false);
      updateToggleUI(false);
      hideAutodartsFrame();
      stopApiPoller();
    }
    if (pollIntervalId) { clearInterval(pollIntervalId); pollIntervalId = null; }
  }

  async function checkAutodartsReady() {
    const hb = GM_getValue("autodarts_heartbeat", null);
    return hb && (Date.now() - hb) < 10000;
  }

  // The embedded view only starts loading (and sending its heartbeat) once
  // the Bridge is turned on, so give it a few seconds rather than a single
  // instant check.
  async function waitForAutodartsReady(maxAttempts = 16, delayMs = 500) {
    for (let i = 0; i < maxAttempts; i++) {
      if (await checkAutodartsReady()) return true;
      await new Promise(r => setTimeout(r, delayMs));
    }
    return false;
  }

  GM_addValueChangeListener("bridge_state", (n, o, v) => {
    if (v && !bridgeEnabled) { bridgeEnabled = true; onBridgeEnabled(); }
    else if (!v && bridgeEnabled) { bridgeEnabled = false; onBridgeDisabled(); }
  });

  // --- Toggle UI (draggable, position persisted across reloads) ---
  let toggleBtn = null;
  let autoSubmitBtn = null;
  let callerBtn = null;
  let updateBtn = null;
  let toggleWrap = null;

  function makeDraggable(el, handle) {
    const dragEl = handle || el;
    let dragging = false, startX = 0, startY = 0, startLeft = 0, startTop = 0;

    dragEl.addEventListener("mousedown", (e) => {
      if (e.target.tagName === "BUTTON") return; // don't start a drag from a button click
      dragging = true;
      startX = e.clientX;
      startY = e.clientY;
      const rect = el.getBoundingClientRect();
      startLeft = rect.left;
      startTop = rect.top;
      e.preventDefault();
    });

    document.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      el.style.left = (startLeft + dx) + "px";
      el.style.top = Math.max(startTop + dy, MIN_TOP) + "px";
      el.style.right = "auto";
      el.style.transform = "none";
    });

    document.addEventListener("mouseup", () => {
      if (!dragging) return;
      dragging = false;
      const rect = el.getBoundingClientRect();
      GM_setValue("bridge_ui_pos", { top: rect.top, left: rect.left });
    });

    // Also catches size changes from the native CSS resize handle — only
    // meaningful while the AutoDarts view is showing (otherwise the box is
    // just auto-sized to the header row).
    new ResizeObserver(() => {
      const rect = el.getBoundingClientRect();
      if (!autodartsFrame) { if (rect.width > 200) GM_setValue("bridge_ui_width_bar", Math.round(rect.width)); return; }
      GM_setValue("bridge_ui_geom_expanded", { width: rect.width, height: rect.height });
    }).observe(el);
  }

  function updateAutoSubmitUI() {
    if (!autoSubmitBtn) return;
    autoSubmitBtn.textContent = autoSubmitEnabled ? "ON" : "OFF";
    autoSubmitBtn.style.background = autoSubmitEnabled ? "#059669" : "#6b7280";
  }

  function updateCallerUI() {
    if (!callerBtn) return;
    callerBtn.textContent = callerEnabled ? "ON" : "OFF";
    callerBtn.style.background = callerEnabled ? "#059669" : "#6b7280";
  }

  // Simple numeric version comparison — "1.9.0" vs "1.10.0" would sort
  // wrong as plain strings, so compare each dot-separated part as a number.
  function isNewerVersion(remote, local) {
    const r = String(remote).split(".").map(Number);
    const l = String(local).split(".").map(Number);
    for (let i = 0; i < Math.max(r.length, l.length); i++) {
      const rv = r[i] || 0;
      const lv = l[i] || 0;
      if (rv > lv) return true;
      if (rv < lv) return false;
    }
    return false;
  }

  function checkForUpdate() {
    if (typeof GM_xmlhttpRequest !== "function") return; // grant unavailable — silently skip
    GM_xmlhttpRequest({
      method: "GET",
      url: CFG.updateUrl + "?_=" + Date.now(), // cache-bust so we don't compare against a stale cached copy
      onload: (res) => {
        const m = /@version\s+([\d.]+)/.exec(res.responseText || "");
        if (!m) { log("Update check: couldn't find @version in fetched source"); return; }
        const remoteVersion = m[1];
        const localVersion = (typeof GM_info !== "undefined" && GM_info.script) ? GM_info.script.version : null;
        if (!localVersion) { log("Update check: couldn't determine local version"); return; }
        log("Update check: local", localVersion, "— remote", remoteVersion);
        if (isNewerVersion(remoteVersion, localVersion) && updateBtn) {
          updateBtn.textContent = "Update Available";
          updateBtn.style.background = "#d97706"; // amber — stands out from the grey/green used elsewhere
        }
      },
      onerror: (e) => log("Update check failed:", e)
    });
  }

  // AutoDarts view — only created when the Bridge turns on, removed when it
  // turns off (a "pop up" rather than something always loaded).
  let autodartsFrame = null;

  function showAutodartsFrame() {
    if (autodartsFrame || !toggleWrap) return;
    autodartsFrame = document.createElement("iframe");
    autodartsFrame.src = "http://127.0.0.1:3180/monitor";
    Object.assign(autodartsFrame.style, {
      flex: "1", border: "none", width: "100%",
      borderTop: "1px solid #374151", marginTop: "2px"
    });
    toggleWrap.appendChild(autodartsFrame);

    const savedGeom = GM_getValue("bridge_ui_geom_expanded", null);
    toggleWrap.style.resize = "both";
    toggleWrap.style.width = (savedGeom ? savedGeom.width : 480) + "px";
    toggleWrap.style.height = (savedGeom ? savedGeom.height : 420) + "px";
  }

  function hideAutodartsFrame() {
    if (autodartsFrame) { autodartsFrame.remove(); autodartsFrame = null; }
    if (toggleWrap) {
      toggleWrap.style.resize = "horizontal";
      toggleWrap.style.height = "auto";
      toggleWrap.style.width = Math.max(300, GM_getValue("bridge_ui_width_bar", 480)) + "px";
    }
  }

  // --- Board status box + reset (DartCounter tab) ---
  let boardStatusBox = null, boardResetBtn = null, boardStatusTimer = null;
  let boardPhaseSince = 0, boardPhaseKey = "";

  function renderBoardStatus(st) {
    if (!boardStatusBox) return;
    if (!st) {
      boardStatusBox.textContent = "AutoDarts: not reachable (" + adBase() + ")";
      boardStatusBox.style.color = "#f87171";
      return;
    }
    const status = st.status || "?", ev = st.event || "", n = Array.isArray(st.throws) ? st.throws.length : (st.numThrows || 0);
    const key = status + "|" + ev;
    if (key !== boardPhaseKey) { boardPhaseKey = key; boardPhaseSince = Date.now(); }
    const secs = Math.round((Date.now() - boardPhaseSince) / 1000);
    const inTakeout = /takeout (started|in progress)/i.test(status + " " + ev);
    const stuck = inTakeout && secs >= 20;
    let text = status + (ev && ev !== status ? " · " + ev : "") + " · " + n + (n === 1 ? " dart" : " darts");
    if (stuck) text += " · stuck " + secs + "s? press Reset";
    boardStatusBox.textContent = text;
    boardStatusBox.title = text;
    boardStatusBox.style.color = stuck ? "#f87171" : (inTakeout ? "#fbbf24" : "#34d399");
  }

  function pollBoardStatusOnce() {
    GM_xmlhttpRequest({
      method: "GET", url: adBase() + "/api/state", timeout: 2500,
      onload: (r) => { try { renderBoardStatus(JSON.parse(r.responseText)); } catch (e) { renderBoardStatus(null); } },
      onerror: () => renderBoardStatus(null), ontimeout: () => renderBoardStatus(null)
    });
  }

  function startBoardStatusPoll() {
    if (boardStatusTimer) return;
    pollBoardStatusOnce();
    boardStatusTimer = setInterval(pollBoardStatusOnce, 500);
  }

  function resetBoard() {
    GM_xmlhttpRequest({
      method: "POST", url: adBase() + "/api/reset", timeout: 4000,
      onload: () => {
        log("Board reset requested");
        // forget what we thought was on the board so nothing is re-entered
        apiLastThrows = 0; apiLastPhase = null; dartsThisTurn = 0;
        if (boardStatusBox) boardStatusBox.textContent = "Reset sent...";
        setTimeout(pollBoardStatusOnce, 300);
      },
      onerror: () => { if (boardStatusBox) { boardStatusBox.textContent = "Reset failed — AutoDarts not reachable"; boardStatusBox.style.color = "#f87171"; } }
    });
  }

  function ensureToggleUI() {
    if (toggleBtn) return;
    const wrap = document.createElement("div");
    toggleWrap = wrap;
    Object.assign(wrap.style, {
      position: "fixed", top: "10px", left: "50%",
      zIndex: "2147483000",
      background: "#1f2937", color: "#fff", padding: "8px 10px", borderRadius: "6px",
      fontFamily: "monospace", fontSize: "12px",
      display: "flex", flexDirection: "column", gap: "6px",
      userSelect: "none",
      resize: "horizontal", overflow: "hidden", maxWidth: "calc(100vw - 20px)", boxSizing: "border-box"
    });

    wrap.style.width = Math.max(300, GM_getValue("bridge_ui_width_bar", 480)) + "px";
    const savedPos = GM_getValue("bridge_ui_pos", null);
    if (savedPos) {
      wrap.style.top = Math.max(savedPos.top, MIN_TOP) + "px";
      wrap.style.left = Math.max(0, Math.min(savedPos.left, window.innerWidth - 340)) + "px";
      wrap.style.transform = "none";
    } else {
      wrap.style.transform = "translateX(-50%)";
    }

    // Drag handle — dragging over the embedded AutoDarts view (when shown)
    // doesn't work reliably, since the iframe captures its own mouse
    // events, so dragging only starts from this row.
    const dragHandle = document.createElement("div");
    Object.assign(dragHandle.style, {
      display: "flex", gap: "10px 16px", alignItems: "center", flexWrap: "wrap",
      cursor: "move", flexShrink: "0"
    });

    // Bridge on/off
    const bridgeGroup = document.createElement("div");
    Object.assign(bridgeGroup.style, { display: "flex", gap: "8px", alignItems: "center" });
    const label = document.createElement("span");
    label.textContent = "Bridge (D-by-D)";
    toggleBtn = document.createElement("button");
    Object.assign(toggleBtn.style, {
      cursor: "pointer", padding: "6px 10px", border: "1px solid #374151",
      borderRadius: "4px", background: "#6b7280", color: "#fff", fontFamily: "monospace"
    });
    toggleBtn.addEventListener("click", () => setBridgeEnabled(!bridgeEnabled));
    bridgeGroup.appendChild(label);
    bridgeGroup.appendChild(toggleBtn);

    const infoIcon = document.createElement("span");
    infoIcon.textContent = "i";
    Object.assign(infoIcon.style, {
      display: "inline-flex", alignItems: "center", justifyContent: "center",
      width: "16px", height: "16px", borderRadius: "50%",
      border: "1px solid #9ca3af", fontSize: "11px", cursor: "pointer"
    });
    infoIcon.addEventListener("click", () => toggleGuidePanel());
    bridgeGroup.appendChild(infoIcon);

    // Auto Submit on/off — side by side with Bridge, not stacked
    const autoSubmitGroup = document.createElement("div");
    Object.assign(autoSubmitGroup.style, { display: "flex", gap: "8px", alignItems: "center" });
    const asLabel = document.createElement("span");
    asLabel.textContent = "Auto Submit";
    autoSubmitBtn = document.createElement("button");
    Object.assign(autoSubmitBtn.style, {
      cursor: "pointer", padding: "6px 10px", border: "1px solid #374151",
      borderRadius: "4px", background: "#6b7280", color: "#fff", fontFamily: "monospace"
    });
    autoSubmitBtn.addEventListener("click", () => {
      autoSubmitEnabled = !autoSubmitEnabled;
      updateAutoSubmitUI();
      log("Auto Submit:", autoSubmitEnabled ? "ON" : "OFF");
    });
    autoSubmitGroup.appendChild(asLabel);
    autoSubmitGroup.appendChild(autoSubmitBtn);

    // Caller on/off — plays a .wav for each dart the instant AutoDarts
    // detects it. State is shared across tabs via GM storage, same
    // mechanism as bridge_state, since playback actually happens over on
    // the AutoDarts side, not here.
    const callerGroup = document.createElement("div");
    Object.assign(callerGroup.style, { display: "flex", gap: "8px", alignItems: "center" });
    const callerLabel = document.createElement("span");
    callerLabel.textContent = "Caller";
    callerBtn = document.createElement("button");
    Object.assign(callerBtn.style, {
      cursor: "pointer", padding: "6px 10px", border: "1px solid #374151",
      borderRadius: "4px", background: "#6b7280", color: "#fff", fontFamily: "monospace"
    });
    callerBtn.addEventListener("click", () => {
      setCallerEnabled(!GM_getValue("caller_enabled", true));
    });
    callerGroup.appendChild(callerLabel);
    callerGroup.appendChild(callerBtn);

    // Virtual-camera icon buttons: rotate + checkout zoom (TV)
    const iconStyle = {
      cursor: "pointer", padding: "6px 10px", border: "1px solid #374151",
      borderRadius: "4px", background: "#6b7280", color: "#fff", fontFamily: "monospace"
    };
    vcamRotateBtn = document.createElement("button");
    vcamRotateBtn.textContent = String.fromCodePoint(0x27F3);
    Object.assign(vcamRotateBtn.style, iconStyle);
    // pointerdown in the capture phase: DartCounter's camera screen is a modal
    // that can swallow ordinary clicks on elements outside it
    const onRotate = (ev) => {
      ev.stopPropagation();
      // rotate every AutoDarts camera currently streaming (or the last one used)
      const cams = vcamActive.length ? Array.from(new Set(vcamActive)) : [rotateTargetCam()];
      for (const c of cams) {
        const next = (GM_getValue("vcam_rotation_" + c, 0) + 90) % 360;
        GM_setValue("vcam_rotation_" + c, next);
        log("Rotate button: camera", c + 1, "->", next + "°", vcamActive.length ? "(streaming)" : "(no stream active yet)");
      }
      updateVcamRotateBtn();
      const shown = cams.map(c => "cam " + (c + 1) + " -> " + GM_getValue("vcam_rotation_" + c, 0) + "°").join(", ");
      showVcamToast("Rotate clicked: " + shown + (vcamActive.length ? "" : " (no AutoDarts camera is streaming into DartCounter right now)"));
      setTimeout(() => {
        const st = cams.map(c => vcamStats[c] ? "cam " + (c + 1) + ": video using " + vcamStats[c].rot + "°, " + vcamStats[c].w + "x" + vcamStats[c].h + ", " + vcamStats[c].frames + " frames received, last " + Math.round((Date.now() - (vcamStats[c].lastFrameAt || 0)) / 1000) + "s ago" : "cam " + (c + 1) + ": no frames drawn yet").join(" | ");
        showVcamToast("Rotate clicked: " + shown + "  ||  " + st);
      }, 700);
    };
    vcamRotateBtn.addEventListener("pointerdown", onRotate, true);
    vcamRotateBtn.addEventListener("click", (ev) => ev.stopPropagation(), true);
    vcamZoomBtn = document.createElement("button");
    vcamZoomBtn.textContent = String.fromCodePoint(0x1F4FA);
    Object.assign(vcamZoomBtn.style, iconStyle);
    vcamZoomBtn.addEventListener("pointerdown", (ev) => {
      ev.stopPropagation();
      if (ev.shiftKey) {
        const dump = buildZoomDebugDump();
        log("Zoom debug dump:\n" + dump);
        copyText(dump);
        showVcamToast("Debug info copied to the clipboard — paste it to Claude (" + dump.length + " characters)");
        return;
      }
      GM_setValue("vcam_zoom_enabled", !GM_getValue("vcam_zoom_enabled", true));
      updateVcamZoomBtn();
    }, true);
    vcamZoomBtn.addEventListener("click", (ev) => ev.stopPropagation(), true);
    callerGroup.appendChild(vcamRotateBtn);
    callerGroup.appendChild(vcamZoomBtn);
    updateVcamRotateBtn();
    updateVcamZoomBtn();

    // Update check — opens the script's own raw source URL in a new tab.
    // Tampermonkey intercepts that navigation itself and shows its
    // install/update page (same as pasting the URL into the address bar
    // manually) — there's no API for a userscript to trigger Tampermonkey's
    // update check directly, so this is the reliable way to get the same
    // result with one click instead of digging through the dashboard.
    updateBtn = document.createElement("button");
    updateBtn.textContent = "Update";
    Object.assign(updateBtn.style, {
      cursor: "pointer", padding: "6px 10px", border: "1px solid #374151",
      borderRadius: "4px", background: "#6b7280", color: "#fff",
      fontFamily: "monospace", fontSize: "11px"
    });
    updateBtn.addEventListener("click", () => {
      window.open(CFG.updateUrl, "_blank");
    });
    checkForUpdate();

    dragHandle.appendChild(bridgeGroup);
    dragHandle.appendChild(autoSubmitGroup);
    dragHandle.appendChild(callerGroup);
    dragHandle.appendChild(updateBtn);
    wrap.appendChild(dragHandle);

    // Board status row: what AutoDarts says right now (so a hang on
    // "Takeout in progress" is visible) + a Reset button that clears the
    // board's darts/state, same as pressing reset in AutoDarts.
    boardStatusBox = document.createElement("div");
    Object.assign(boardStatusBox.style, {
      flex: "1 1 220px", padding: "6px 10px", border: "1px solid #374151", borderRadius: "4px",
      background: "#111827", color: "#9ca3af", fontFamily: "monospace", fontSize: "12px", minWidth: "160px",
      whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis"
    });
    boardStatusBox.textContent = "AutoDarts: checking...";
    boardResetBtn = document.createElement("button");
    boardResetBtn.textContent = "Reset";
    Object.assign(boardResetBtn.style, {
      cursor: "pointer", padding: "6px 10px", border: "1px solid #374151",
      borderRadius: "4px", background: "#b91c1c", color: "#fff", fontFamily: "monospace"
    });
    boardResetBtn.title = "Reset the AutoDarts board state (clears its darts / unsticks 'Takeout in progress')";
    boardResetBtn.addEventListener("pointerdown", (ev) => { ev.stopPropagation(); resetBoard(); }, true);
    boardResetBtn.addEventListener("click", (ev) => ev.stopPropagation(), true);
    // Same wrapping row as the buttons: a narrow box drops these onto a
    // second line, a wider box (drag its right edge) pulls them up beside
    // the other buttons.
    dragHandle.appendChild(boardStatusBox);
    dragHandle.appendChild(boardResetBtn);
    startBoardStatusPoll();
    document.documentElement.appendChild(wrap);
    makeDraggable(wrap, dragHandle);
    updateToggleUI(bridgeEnabled);
    updateAutoSubmitUI();
    updateCallerUI();
  }
  // --- User guide panel (opened via the (i) icon next to the Bridge toggle) ---
  let guidePanel = null;

  function toggleGuidePanel() {
    if (guidePanel) { guidePanel.remove(); guidePanel = null; return; }

    guidePanel = document.createElement("div");
    Object.assign(guidePanel.style, {
      position: "fixed", top: "60px", left: "50%", transform: "translateX(-50%)",
      width: "360px", maxHeight: "75vh", overflowY: "auto",
      background: "#111827", color: "#e5e7eb", padding: "16px 18px",
      borderRadius: "8px", fontFamily: "monospace", fontSize: "11px", lineHeight: "1.6",
      zIndex: "100001", boxShadow: "0 4px 24px rgba(0,0,0,0.6)"
    });

    guidePanel.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;">
        <strong style="font-size:13px;">AutoDarts ↔ DartCounter Bridge — Quick Start</strong>
        <span id="ad2dc-guide-close" style="cursor:pointer; padding:0 6px; font-size:14px;">&times;</span>
      </div>

      <p><strong>What it does</strong><br>
      Reads darts from your AutoDarts board and enters them into DartCounter
      for you, dart by dart — checkout suggestions update live, no manual
      tapping needed.</p>

      <p><strong>How to use it</strong><br>
      1. Open your DartCounter match.<br>
      2. Click the Bridge button (top-left, starts OFF). It turns green and
      says ON.<br>
      3. Throw — darts appear in DartCounter within a second or two.</p>

      <p><strong>Handled automatically when Bridge turns on</strong><br>
      • DartCounter's own "Auto Submit" setting is switched off (it would
      otherwise conflict with this tool).<br>
      • DartCounter's input mode is switched to dart-by-dart.<br>
      No settings menu visits needed.</p>

      <p><strong>The boxes</strong><br>
      <strong>Bridge</strong> — main on/off switch. Pulses amber with
      "..." briefly while it's connecting — that's normal, not stuck.<br>
      <strong>Auto Submit</strong> — presses DartCounter's Submit button for
      you after a takeout (e.g. after a bust). Turns on automatically with
      the Bridge; toggle off to press Submit yourself instead.<br>
      <strong>Caller</strong> — plays a sound announcing each dart's score
      the instant AutoDarts detects it.</p>

      <p><strong>Staying up to date</strong><br>
      This script auto-updates in the background — Tampermonkey checks the
      source on GitHub periodically on its own. The <strong>Update</strong>
      button also checks itself and turns to <strong>Update Available</strong>
      when a newer version is out — click it to open the source in a new
      tab and let Tampermonkey handle the rest.</p>

      <p><strong>If it stops working</strong><br>
      Turn the Bridge off and back on — fixes most hiccups. Still stuck?
      Open DevTools (F12) → Console, and look for lines starting
      <code>[AD2DC-DBD]</code> for what it's doing or why something failed.</p>
    `;

    document.documentElement.appendChild(guidePanel);
    guidePanel.querySelector("#ad2dc-guide-close").addEventListener("click", () => {
      guidePanel.remove();
      guidePanel = null;
    });
  }

  function updateToggleUI(on) {
    if (!toggleBtn) return;
    toggleBtn.textContent = on ? "ON" : "OFF";
    toggleBtn.style.background = on ? "#059669" : "#6b7280";
  }

  // Shows a pulsing "..." state on the Bridge button while startup is
  // still working (waiting for AutoDarts to be ready, retrying the
  // DartCounter mode-switch) — otherwise the button just sits there
  // silently for however long that takes, which can be 20+ seconds in a
  // slow retry case, with nothing to show it isn't just stuck.
  let connectingStyleInjected = false;
  function ensureConnectingStyle() {
    if (connectingStyleInjected) return;
    const style = document.createElement("style");
    style.textContent = "@keyframes ad2dc-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } } " +
      ".ad2dc-connecting { animation: ad2dc-pulse 1s ease-in-out infinite; background: #b45309 !important; }";
    document.documentElement.appendChild(style);
    connectingStyleInjected = true;
  }

  function setToggleConnecting(active) {
    if (!toggleBtn) return;
    ensureConnectingStyle();
    if (active) {
      toggleBtn.textContent = "...";
      toggleBtn.classList.add("ad2dc-connecting");
    } else {
      toggleBtn.classList.remove("ad2dc-connecting");
    }
  }

  // --- Parse an Autodarts dart label into keypad instructions ---
  // Examples seen: "S1", "D3", "T20", "25" (outer bull), "50"/"BULL" (inner bull), "-" (not yet thrown)
  function parseDartLabel(raw) {
    const s = String(raw || "").trim().toUpperCase();
    if (!s || s === "-") return null; // not yet thrown
    if (s === "0" || s === "MISS" || s === "OUT") return { tab: "MISS" };
    if (s === "50" || s === "BULL" || s === "DBULL") return { tab: "Bull" };
    if (s === "25" || s === "SBULL" || s === "OUTER") return { tab: "Outer" };
    // Autodarts uses "M<number>" for a dart that hit the board but missed
    // any scoring segment (e.g. landed on a wire) — always a MISS regardless
    // of which number it's nearest to.
    if (/^M\d+$/.test(s)) return { tab: "MISS" };
    const mult = s[0];
    const num = parseInt(s.slice(1), 10);
    if (!isNaN(num)) {
      if (mult === "S") return { tab: "Single", num };
      if (mult === "D") return { tab: "Double", num };
      if (mult === "T") return { tab: "Treble", num };
    }
    log("Could not parse dart label:", raw);
    return null;
  }

  // --- Find & click DartCounter keypad elements by visible text ---
  // Scoped to the scorepad container (anchored off the unique "MISS" button)
  // to avoid matching unrelated same-text elements elsewhere on the page
  // (e.g. a leg-count badge showing "1").
  let scorepadRoot = null;

  function findClickableByText(text, root) {
    const scope = root || document;
    const wanted = text.trim().toLowerCase();
    const candidates = scope.querySelectorAll("button, div[role='button'], a, span");
    for (const el of candidates) {
      const t = (el.textContent || "").trim().toLowerCase();
      if (t === wanted) return el;
    }
    return null;
  }

  // Number cells on Double/Treble tabs show TWO numbers in one button (the
  // base number plus the multiplied value, e.g. "18" and "36" for Treble-18),
  // so button.textContent is "1836" — not "18" — and an exact match fails.
  // Read only the FIRST styled text node (the primary number) instead.
  function findNumberButton(root, number) {
    const wanted = String(number);
    const buttons = root.querySelectorAll("button");
    for (const btn of buttons) {
      const typedEls = btn.querySelectorAll("[dctypography]");
      let primaryText;
      if (typedEls.length > 0) {
        primaryText = (typedEls[0].textContent || "").trim();
      } else {
        primaryText = (btn.textContent || "").trim();
      }
      if (primaryText === wanted) return btn;
    }
    return null;
  }

  // Tab buttons (Single/Double/Treble/Bull/Outer) may also bundle a second
  // value in the same button (e.g. "Bull" + "50"), same issue as the number
  // cells — so use the same primary-text extraction for these too.
  function findLabelButton(root, label) {
    const wanted = label.trim().toLowerCase();
    const buttons = root.querySelectorAll("button");
    for (const btn of buttons) {
      const typedEls = btn.querySelectorAll("[dctypography]");
      let primaryText;
      if (typedEls.length > 0) {
        primaryText = (typedEls[0].textContent || "").trim();
      } else {
        primaryText = (btn.textContent || "").trim();
      }
      if (primaryText.toLowerCase() === wanted) return btn;
    }
    return null;
  }
  // The Submit button sometimes renders as text ("Submit"), and sometimes
  // (narrower layouts) as an icon-only button containing <dc-icon icon="send_score">
  // with no text at all — so a text search alone won't find it in that state.
  function findSubmitButton() {
    const byText = findLabelButton(document, "Submit");
    if (byText) return byText;
    const icon = document.querySelector('dc-icon[icon="send_score"]');
    if (icon) return icon.closest("button");
    return null;
  }

  function dumpNumberButtons(root) {
    const buttons = root.querySelectorAll("button");
    const texts = [];
    buttons.forEach(btn => {
      const typedEls = btn.querySelectorAll("[dctypography]");
      texts.push(typedEls.length > 0
        ? Array.from(typedEls).map(e => (e.textContent || "").trim()).join("|")
        : (btn.textContent || "").trim());
    });
    log("Buttons in scorepad root:", texts);
  }

  function getScorepadRoot() {
    if (scorepadRoot && document.contains(scorepadRoot)) return scorepadRoot;

    // The whole keypad (tabs + number grid + MISS) lives inside this single
    // Angular component, per DartCounter's DOM — much more reliable than
    // guessing how far to walk up from any one button.
    const keyboardEl = document.querySelector("app-single-dart-keyboard");
    if (keyboardEl) {
      scorepadRoot = keyboardEl;
      log("getScorepadRoot: using <app-single-dart-keyboard> as root");
      return keyboardEl;
    }

    // Fallback: walk up from MISS if the component tag isn't present
    // (e.g. DartCounter changes markup in future).
    const missEl = findClickableByText("MISS", document);
    if (!missEl) return document;
    let el = missEl;
    for (let i = 0; i < 10 && el; i++) {
      const hasAll = ["Single", "Double", "Treble", "Bull", "Outer", "20"]
        .every(t => !!findClickableByText(t, el));
      if (hasAll) { scorepadRoot = el; return el; }
      el = el.parentElement;
    }
    log("getScorepadRoot: no container found with all tabs — falling back to full document");
    return document;
  }

  function clickEl(el) {
    if (!el) return false;
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    el.click();
    return true;
  }

  // Poll a condition function until it returns something truthy, instead
  // of guessing a fixed delay before an element exists. Checks every 30ms,
  // up to ~900ms by default — cheap and self-correcting if a render is
  // ever slower than usual, unlike a single fixed setTimeout.
  async function waitFor(fn, attempts = 30, intervalMs = 30) {
    for (let i = 0; i < attempts; i++) {
      const result = fn();
      if (result) return result;
      await new Promise(r => setTimeout(r, intervalMs));
    }
    return null;
  }

  // --- Around the Clock uses a completely different keypad from X01 —
  // instead of Single/Double/Treble tabs plus a shared number grid, it
  // groups 3 pre-labelled buttons per number ("S10", "D10", "T10" as
  // literal button text) inside a [game-keyboard] container, plus a
  // separate Miss button. Handled as its own path since none of the X01
  // tab/number logic applies here.
  function getAroundTheClockKeyboardRoot() {
    const candidates = document.querySelectorAll("[game-keyboard], .in-game-keyboard-container");
    for (const root of candidates) {
      // The [game-keyboard] attribute/class turned out to exist even on
      // normal X01 pages (a generic Angular directive, not exclusive to
      // this mode) — presence alone was a false positive. Confirm this is
      // genuinely the Around the Clock keypad by checking for its
      // distinctive shape: a button whose own text is a combined code like
      // "S10"/"D3"/"T20". The X01 keypad never has this — its Single/
      // Double/Treble are separate tab buttons, and numbers are separate
      // plain-number buttons, never combined into one string.
      const hasGroupedNumberButton = Array.from(root.querySelectorAll("button.key"))
        .some(btn => /^[SDT]\d{1,2}$/.test((btn.textContent || "").trim()));
      if (hasGroupedNumberButton) return root;
    }
    return null;
  }

  function findAroundTheClockButton(text) {
    const root = getAroundTheClockKeyboardRoot();
    if (!root) return null;
    const wanted = text.trim().toLowerCase();
    const buttons = root.querySelectorAll("button.key");
    for (const btn of buttons) {
      if ((btn.textContent || "").trim().toLowerCase() === wanted) return btn;
    }
    return null;
  }

  // Returns true if this mode was detected and handled (whether or not the
  // click itself succeeded) — false means "not this mode, fall through to
  // the normal X01 keypad logic instead."
  function enterDartAroundTheClock(parsed) {
    const root = getAroundTheClockKeyboardRoot();
    if (!root) return false;

    if (!parsed || parsed.tab === "MISS") {
      const el = findAroundTheClockButton("Miss");
      if (clickEl(el)) log("Around the Clock: entered MISS");
      else { log("FAILED — MISS button not found in Around the Clock keyboard"); notify("AD2DC Error", "MISS button not found", true); }
      return true;
    }

    let label = null;
    if (parsed.tab === "Single") label = "S" + parsed.num;
    else if (parsed.tab === "Double") label = "D" + parsed.num;
    else if (parsed.tab === "Treble") label = "T" + parsed.num;
    else if (parsed.tab === "Bull") label = "Bull"; // unconfirmed label text — flag if this doesn't register
    else if (parsed.tab === "Outer") label = "25"; // unconfirmed label text — flag if this doesn't register

    const el = label ? findAroundTheClockButton(label) : null;
    if (el) {
      clickEl(el);
      log("Around the Clock: entered", label);
    } else {
      // Doesn't match a button currently on screen (e.g. not the number
      // you're actually aiming at right now) — count it as a miss.
      const missEl = findAroundTheClockButton("Miss");
      clickEl(missEl);
      log("Around the Clock: no button found for", label, "— entered MISS instead");
    }
    return true;
  }

  // Enter one dart via the segment keypad
  async function enterDartDC(parsed) {
    if (!parsed) return;

    if (enterDartAroundTheClock(parsed)) return;

    const root = getScorepadRoot();

    if (parsed.tab === "MISS") {
      const el = findLabelButton(root, "MISS");
      if (clickEl(el)) log("Entered MISS");
      else { log("FAILED — MISS button not found in scoped root"); dumpNumberButtons(root); notify("AD2DC Error", "MISS button not found", true); }
      return;
    }
    if (parsed.tab === "Bull" || parsed.tab === "Outer") {
      // The button's own text is just the value ("50" or "25") — "Bull"/
      // "Outer" is a separate label element above the button, not inside it.
      const value = parsed.tab === "Bull" ? "50" : "25";
      const el = findLabelButton(root, value);
      if (clickEl(el)) log("Entered", parsed.tab);
      else { log("FAILED —", parsed.tab, "(" + value + ") not found in scoped root"); dumpNumberButtons(root); notify("AD2DC Error", parsed.tab + " tab not found", true); }
      return;
    }
    // Single / Double / Treble: click tab, then number
    const tabEl = findLabelButton(root, parsed.tab);
    if (!clickEl(tabEl)) {
      log("FAILED —", parsed.tab, "tab not found in scoped root. Root was:", root === document ? "document (fallback)" : root);
      dumpNumberButtons(root);
      notify("AD2DC Error", parsed.tab + " tab not found", true);
      scorepadRoot = null; // force recompute next time in case the DOM shifted
      return;
    }

    // Wait for the number grid to actually render after the tab switch,
    // instead of assuming a fixed 80ms was always enough.
    const numEl = await waitFor(() => findNumberButton(root, parsed.num));
    if (clickEl(numEl)) log("Entered", parsed.tab, parsed.num);
    else {
      log("FAILED — number", parsed.num, "not found after waiting for", parsed.tab, "tab to render");
      dumpNumberButtons(root);
      notify("AD2DC Error", "Number " + parsed.num + " not found", true);
    }
  }

  // A dart's full click sequence (tab click, wait, number click) can take
  // long enough that a second dart arriving right behind it would
  // otherwise start clicking mid-sequence — e.g. if darts were already
  // sitting in the board when the Bridge turned on and all 3 get read in
  // the same poll tick. Chain entries through one queue so each dart's
  // clicks fully finish before the next one starts.
  let dartEntryQueue = Promise.resolve();
  function queueDartEntry(parsed) {
    dartEntryQueue = dartEntryQueue
      .then(() => enterDartDC(parsed))
      .catch(e => log("enterDartDC error:", e));
    return dartEntryQueue;
  }

  // --- Role detection ---
  const host = location.hostname.toLowerCase();
  const isAutoDarts = location.port === "3180" &&
    (host === "127.0.0.1" || /^192\.168\.\d{1,3}\.\d{1,3}$/.test(host));
  const isDartCounter = host.endsWith("dartcounter.net");


  // --- Virtual webcams: offer the AutoDarts cameras as extra cameras in
  // DartCounter's own "Activate Camera" picker. The real webcams are locked
  // by AutoDarts, so instead we read AutoDarts' MJPEG stream (one camera at
  // a time via ?cam=N), paint the frames onto a canvas and hand DartCounter
  // canvas.captureStream() as if it were a normal webcam.
  // AutoDarts local API address. v1.x also served a web page here; v2.x only the API.
  // Change it from the Tampermonkey menu if your board uses another port.
  const adBase = () => GM_getValue("autodarts_base", "http://127.0.0.1:3180");
  const VCAM_COUNT = 3;
  const VCAM_OUT = 720; // virtual camera output: VCAM_OUT x VCAM_OUT square
  // How much picture width to keep round the board: board width x this (1.25 = tight, 1.4 = whole board
  // with the number ring and a little room, 1.7 = more surroundings). Change with GM value vcam_square_margin.
  const vcamSquareMargin = () => GM_getValue("vcam_square_margin", 1.4);
  const vcamId = (i) => "ad2dc-autodarts-cam-" + i;

  // Toolbar icon buttons (rotate / checkout zoom) live next to the Caller
  // toggle. Rotate applies to the AutoDarts camera currently selected in
  // DartCounter (or the last one used if none is active right now).
  let vcamRotateBtn = null, vcamZoomBtn = null;
  const vcamActive = [];
  const vcamStats = {}; // per camera: last rotation applied by the draw loop, frames drawn, canvas size

  // Small on-screen message (so rotate/zoom problems can be seen without DevTools)
  let vcamToast = null, vcamToastTimer = null;
  function showVcamToast(text) {
    if (!vcamToast) {
      vcamToast = document.createElement("div");
      Object.assign(vcamToast.style, {
        position: "fixed", left: "50%", bottom: "24px", transform: "translateX(-50%)",
        zIndex: "100003", background: "#111827", color: "#e5e7eb", padding: "8px 12px",
        borderRadius: "6px", fontFamily: "monospace", fontSize: "12px", maxWidth: "90vw",
        boxShadow: "0 2px 12px rgba(0,0,0,0.5)", pointerEvents: "none"
      });
      document.documentElement.appendChild(vcamToast);
    }
    vcamToast.textContent = text;
    vcamToast.style.display = "block";
    clearTimeout(vcamToastTimer);
    vcamToastTimer = setTimeout(() => { vcamToast.style.display = "none"; }, 4000);
  }
  function rotateTargetCam() {
    return vcamActive.length ? vcamActive[vcamActive.length - 1] : GM_getValue("vcam_last", 1);
  }
  function updateVcamRotateBtn() {
    if (!vcamRotateBtn) return;
    const c = rotateTargetCam();
    vcamRotateBtn.title = "Rotate AutoDarts camera " + (c + 1) + " by 90° (now " + GM_getValue("vcam_rotation_" + c, 0) + "°)";
    vcamRotateBtn.style.opacity = vcamActive.length ? "1" : "0.6";
  }
  function updateVcamZoomBtn() {
    if (!vcamZoomBtn) return;
    const on = GM_getValue("vcam_zoom_enabled", true);
    vcamZoomBtn.style.background = on ? "#059669" : "#6b7280";
    vcamZoomBtn.title = "Checkout zoom: " + (on ? "ON" : "OFF") + " (zooms the AutoDarts camera onto the finishing double)";
  }

  // --- Checkout zoom: when the active player's remaining score is a double
  // finish (even 2-40, or 50), the virtual camera zooms in on that double.
  // AutoDarts' config gives 20 ring-boundary points per camera (boundary i
  // sits between board segment i and i+1, starting 20|1), so the centre of
  // a double is the average of its two neighbouring outer + inner points.
  const BOARD_ORDER = [20, 1, 18, 4, 13, 6, 10, 15, 2, 17, 3, 19, 7, 16, 8, 11, 14, 9, 12, 5];
  let vcamBoards = null, vcamCamW = 1280, vcamCamH = 720;
  let vcamZoomTarget = null; // null, 1-20 (that double) or 25 (bull)
  let dartsThisTurn = 0, lastDartAt = 0;
  const vcamZoomOn = () => GM_getValue("vcam_zoom_enabled", true);
  const vcamZoomFactor = () => GM_getValue("vcam_zoom_factor", 2.5);

  // v1.x lists the board geometry in /api/config ("dartboard"); v2.x serves
  // the same points (per camera: bull, doubleOuterPoints, doubleInnerPoints)
  // at /api/config/calibration/ellipses. Try v1 first, then v2.
  function loadVcamBoards(force) {
    if (vcamBoards && !force) return;
    const getJson = (path, cb) => GM_xmlhttpRequest({
      method: "GET", url: adBase() + path, timeout: 4000,
      onload: (r) => { try { cb(JSON.parse(r.responseText)); } catch (e) { cb(null); } },
      onerror: () => cb(null), ontimeout: () => cb(null)
    });
    getJson("/api/config", (cfg) => {
      if (cfg && cfg.cam) { vcamCamW = cfg.cam.width || 1280; vcamCamH = cfg.cam.height || 720; }
      if (cfg && cfg.dartboard && Object.keys(cfg.dartboard).length) {
        vcamBoards = cfg.dartboard;
        log("Virtual cam: loaded board calibration (v1 style) for cameras", Object.keys(vcamBoards).join(","));
        return;
      }
      getJson("/api/config/calibration/ellipses", (el) => {
        if (!el || typeof el !== "object") { log("Virtual cam: no board calibration available yet (not calibrated?)"); return; }
        const boards = {};
        for (const k of Object.keys(el)) {
          const c = el[k];
          if (c && c.bull && c.doubleOuterPoints && c.doubleInnerPoints) boards[k] = { bull: c.bull, doubleOuters: c.doubleOuterPoints, doubleInner: c.doubleInnerPoints };
        }
        if (Object.keys(boards).length) { vcamBoards = boards; log("Virtual cam: loaded board calibration (v2 style) for cameras", Object.keys(boards).join(",")); }
        else log("Virtual cam: no board calibration available yet (not calibrated?)");
      });
    });
  }

  function doubleCentre(cam, n) {
    const b = vcamBoards && vcamBoards[cam];
    if (!b) return null;
    if (n === 25) return { x: b.bull[0], y: b.bull[1] };
    const k = BOARD_ORDER.indexOf(n);
    if (k < 0) return null;
    const pts = [b.doubleOuters[(k + 19) % 20], b.doubleOuters[k], b.doubleInner[(k + 19) % 20], b.doubleInner[k]];
    return { x: pts.reduce((a, q) => a + q[0], 0) / 4, y: pts.reduce((a, q) => a + q[1], 0) / 4 };
  }

  // DartCounter shows every player's remaining score (and a suggested finish
  // for each) at once, with nothing in the DOM marking whose turn it is. So
  // the active player is inferred: the score that just went DOWN is the
  // thrower's; when a turn ends (takeout) the turn moves to the next player.
  let vcamActivePlayer = null, vcamLastScores = [];
  let vcamLocalPlayer = null, vcamLocalPath = location.pathname; // which panel is ME (learned from my own darts)
  let vcamHold = null, vcamLastZoom = null; // checkout hold state
  function readAllScores() {
    return Array.from(document.querySelectorAll("app-remaining-score")).map(el => {
      const n = parseInt((el.textContent || "").trim(), 10);
      return isNaN(n) ? null : n;
    });
  }
  let vcamLastTurnOver = 0;
  function vcamTurnOver() {
    if (Date.now() - vcamLastTurnOver < 8000) return; // takeout + Submit both signal the same turn change
    vcamLastTurnOver = Date.now();
    if (vcamActivePlayer !== null && vcamLastScores.length) vcamActivePlayer = (vcamActivePlayer + 1) % vcamLastScores.length;
    log("Checkout zoom: turn over — active player now", vcamActivePlayer === null ? "unknown" : vcamActivePlayer + 1);
  }

  // Which player is throwing, read from the page. Online layout: every
  // player sits in a ".current-player-arrow" wrapper; the active one differs
  // by an extra class, a drawn arrow (::before/::after) or by not being
  // dimmed. Local layout: only the active player's panel has an
  // <app-in-game-interim-score>. Returns the player's index, or null.
  const ARROW_BASE_CLASSES = new Set(["current-player-arrow", "transition-all", "duration-200", "relative", "flex", "w-full", "h-full"]);
  // One wrapper per player: the nearest ancestor of each remaining-score that
  // has the "transition-all duration-200" classes (both layouts use it).
  function arrowPanels() {
    const panels = [];
    document.querySelectorAll("app-remaining-score").forEach(el => {
      let p = el.parentElement;
      while (p && !(p.classList.contains("transition-all") && p.classList.contains("duration-200"))) p = p.parentElement;
      panels.push(p || null);
    });
    return panels.some(x => !x) || new Set(panels).size !== panels.length ? [] : panels;
  }
  function panelSignals(p) {
    const extra = Array.from(p.classList).filter(c => !ARROW_BASE_CLASSES.has(c));
    const pseudo = ["::before", "::after"].map(ps => getComputedStyle(p, ps).content).filter(c => c && c !== "none" && c !== "normal").join("");
    const stats = p.querySelector(".in-game-stats-wrapper") || p;
    const cs = getComputedStyle(p), ss = getComputedStyle(stats);
    const opacity = (parseFloat(cs.opacity) || 1) * (parseFloat(ss.opacity) || 1);
    const m = /matrix\(([-\d.]+)/.exec(cs.transform || "");
    const scale = m ? parseFloat(m[1]) : 1;
    const il = p.querySelector("[appingameinterimscorelabel]");
    const interimText = il ? (il.textContent || "").trim() : "";
    const started = !!p.querySelector(".started-leg-indicator");
    return { extra, pseudo, opacity, scale, bg: cs.backgroundColor, border: cs.borderColor, color: cs.color, interimText, started };
  }
  // DartCounter shows "<NAME>'S TURN TO THROW!" — the most direct signal.
  // Match that name to exactly one player panel. Cached briefly (full-page text scan).
  let vcamBannerCache = { at: 0, idx: null };
  function activePlayerFromBanner(panels) {
    if (Date.now() - vcamBannerCache.at < 400) return vcamBannerCache.idx;
    let idx = null;
    const els = Array.from(document.querySelectorAll("div, span, p, h1, h2, h3")).filter(e => e.children.length === 0 && /turn to throw/i.test(e.textContent || ""));
    for (const e of els) {
      const m = /^\s*(.+?)['’‘`]s\s+turn to throw/i.exec((e.textContent || "").trim());
      if (!m) continue;
      const name = m[1].trim().toLowerCase();
      if (!name) continue;
      const hit = panels.map((p, i) => (p.textContent || "").toLowerCase().includes(name) ? i : -1).filter(i => i >= 0);
      if (hit.length === 1) { idx = hit[0]; break; }
    }
    vcamBannerCache = { at: Date.now(), idx };
    return idx;
  }

  function activePlayerFromDom() {
    const panels = arrowPanels();
    if (panels.length >= 2) {
      const byBanner = activePlayerFromBanner(panels);
      if (byBanner !== null) return byBanner;
      const sig = panels.map(panelSignals);
      const only = (test) => { const hit = sig.map((x, i) => test(x) ? i : -1).filter(i => i >= 0); return hit.length === 1 ? hit[0] : null; };
      let r;
      // 1. a class that says "this one is active"
      if ((r = only(x => /active|current|turn|selected|highlight|throwing/i.test(x.extra.join(" ")))) !== null) return r;
      // 2. the arrow is drawn on only one panel
      if ((r = only(x => !!x.pseudo)) !== null) return r;
      // 3. everyone else carries a "dimmed" class
      const dim = sig.map(x => /opacity|inactive|disabled|gray|grey/i.test(x.extra.join(" ")));
      if (dim.filter(Boolean).length === sig.length - 1) return dim.indexOf(false);
      // 4. the active panel is the least dimmed / the largest
      const maxOp = Math.max(...sig.map(x => x.opacity)), minOp = Math.min(...sig.map(x => x.opacity));
      if (maxOp - minOp > 0.05 && (r = only(x => x.opacity === maxOp)) !== null) return r;
      const maxSc = Math.max(...sig.map(x => x.scale)), minSc = Math.min(...sig.map(x => x.scale));
      if (maxSc - minSc > 0.005 && (r = only(x => x.scale === maxSc)) !== null) return r;
      // 5. only the thrower has a running total for this turn showing
      if ((r = only(x => x.interimText !== "" && x.interimText !== "0")) !== null) return r;
      // 6. fresh leg (everyone on the same score): whoever has the "started leg" marker throws first
      const sc = readAllScores();
      if (sc.length === sig.length && sc.every(v => v === sc[0]) && (r = only(x => x.started)) !== null) return r;
    }
    // local-match layout: only the thrower's panel has an interim score
    const teams = Array.from(document.querySelectorAll("app-match-team-score"));
    const withInterim = [];
    teams.forEach((t, i) => { if (t.querySelector("app-in-game-interim-score")) withInterim.push(i); });
    return withInterim.length === 1 ? withInterim[0] : null;
  }

  // Shift-click on the TV button: collect what the zoom can see on this page
  // (each score's parent chain + a tags-only copy of its panel) and copy it
  // to the clipboard, so layout problems can be diagnosed without DevTools.
  function buildZoomDebugDump() {
    const lines = [];
    lines.push("AD2DC " + (typeof GM_info !== "undefined" ? GM_info.script.version : "?") + " zoom debug @ " + new Date().toLocaleTimeString());
    lines.push("url: " + location.pathname);
    lines.push("scores read: " + JSON.stringify(readAllScores()) + " | domActive=" + activePlayerFromDom() + " | activePlayer=" + vcamActivePlayer + " | myPanel=" + vcamLocalPlayer +
      " | dartsThisTurn=" + dartsThisTurn + " | zoomTarget=" + vcamZoomTarget + " | hold=" + (vcamHold ? JSON.stringify(vcamHold) : "none") +
      " | streams=" + vcamActive.join(","));
    arrowPanels().forEach((p, i) => { const g = panelSignals(p); lines.push("player panel " + i + ": extraClasses=[" + g.extra.join(" ") + "] pseudo=" + JSON.stringify(g.pseudo) + " opacity=" + g.opacity + " scale=" + g.scale + " bg=" + g.bg + " border=" + g.border + " color=" + g.color + " interimText=" + JSON.stringify(g.interimText) + " startedLeg=" + g.started + " fullClass=" + p.className); });
    lines.push("player panels found: " + arrowPanels().length);
    // keyboard / input-mode picker (for "turn on dart-by-dart" problems)
    const strip = (el, n) => el.outerHTML.replace(/<!--[\s\S]*?-->/g, "").replace(/>[^<]+</g, "><").replace(/ style="[^"]*"/g, "").slice(0, n);
    const kbTags = Array.from(new Set(Array.from(document.querySelectorAll("*")).map(e => e.tagName.toLowerCase()).filter(t => /keyboard|keypad|input-mode|score-input/.test(t))));
    lines.push("keyboard-ish elements: " + (kbTags.join(", ") || "none") + " | app-single-dart-keyboard present: " + !!document.querySelector("app-single-dart-keyboard"));
    const dd = document.querySelectorAll("app-select-keyboard-dropdown");
    lines.push("app-select-keyboard-dropdown count: " + dd.length + " | mode toggle found: " + !!findDartCounterModeToggle() + " | current icon: " + (findDartCounterModeToggle() ? Array.from(findDartCounterModeToggle().querySelectorAll("span[class*=icon-]")).map(x => x.className).join(" ; ") : "n/a"));
    dd.forEach((d, i) => lines.push("dropdown " + i + ": " + strip(d, 1500)));
    const icons = Array.from(document.querySelectorAll('[class*="icon-keyboard"]')).map(e => e.className + " <" + e.parentElement.tagName.toLowerCase() + "." + (e.parentElement.className || "").toString().slice(0, 60) + ">");
    lines.push("keyboard icons on page: " + (icons.join(" || ") || "none"));
    lines.push("team panels: " + document.querySelectorAll("app-match-team-score").length + ", interim elements: " + document.querySelectorAll("app-in-game-interim-score").length);
    document.querySelectorAll("app-remaining-score").forEach((e, i) => {
      lines.push("--- score " + i + ": " + e.textContent.trim());
      let p = e, panel = null;
      for (let k = 0; k < 10 && p.parentElement; k++) {
        p = p.parentElement;
        lines.push("  " + p.tagName.toLowerCase() + " scores=" + p.querySelectorAll("app-remaining-score").length + " interim=" + p.querySelectorAll("app-in-game-interim-score").length +
          " cls=" + (p.className || "").toString().split(" ").slice(0, 5).join("."));
        if (!panel && p.querySelectorAll("app-remaining-score").length === 1 && k >= 2) panel = p;
      }
      if (panel) lines.push("  panel html: " + panel.outerHTML.replace(/<!--[\s\S]*?-->/g, "").replace(/>[^<]+</g, "><").replace(/ style="[^"]*"/g, "").slice(0, 1800));
    });
    return lines.join("\n");
  }
  function copyText(text) {
    try { navigator.clipboard.writeText(text).catch(() => fallback()); } catch (e) { fallback(); }
    function fallback() {
      const ta = document.createElement("textarea");
      ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy"); } catch (e) {}
      ta.remove();
    }
  }

  function updateZoomTarget() {
    const scores = readAllScores();
    const domActive = activePlayerFromDom();
    if (domActive !== null && domActive !== vcamActivePlayer) {
      vcamActivePlayer = domActive;
      log("Checkout zoom: active player is", domActive + 1, "(interim score panel)");
    }
    for (let i = 0; i < scores.length; i++) {
      const prev = vcamLastScores[i];
      if (scores[i] !== null && prev !== undefined && prev !== null) {
        if (domActive === null && scores[i] < prev && vcamActivePlayer !== i) { vcamActivePlayer = i; log("Checkout zoom: active player is", i + 1, "(score dropped)"); }
        else if (domActive === null && scores[i] > prev + 40) { vcamActivePlayer = null; } // new leg — start over
      }
    }
    vcamLastScores = scores;
    // The zoom only follows YOUR score (player 1, the first panel) — whose turn it is doesn't matter.
    // (Change with GM value vcam_zoom_player: 0 = player 1, 1 = player 2.)
    // Online games: the local player isn't always the first panel, so learn it — see handleDartLabel.
    vcamActivePlayer = vcamLocalPlayer !== null ? vcamLocalPlayer : GM_getValue("vcam_zoom_player", 0);

    let target = null;
    if (dartsThisTurn >= 3 && Date.now() - lastDartAt > 25000) dartsThisTurn = 0; // stale count (missed takeout) must not block zooming
    if (vcamZoomOn() && vcamActive.length && dartsThisTurn < 3 && vcamActivePlayer !== null) {
      const r = scores[vcamActivePlayer];
      if (r === 50) target = 25;
      else if (r !== null && r !== undefined && r >= 2 && r <= 40 && r % 2 === 0) target = r / 2;
    }

    // A checkout stays zoomed on the winning double until Submit is clicked.
    // Remember the double we were zoomed on; once that player's score hits 0
    // hold it. Released by Submit, by an undo (score back above 0), by
    // switching the zoom off, or after 2 minutes as a safety net.
    if (vcamHold) {
      const rr = scores[vcamHold.player];
      if (!vcamZoomOn() || !vcamActive.length || (rr !== 0 && rr !== null && rr !== undefined) || Date.now() - vcamHold.at > 120000) {
        log("Checkout zoom: hold released");
        vcamHold = null;
      } else {
        target = vcamHold.target;
      }
    } else if (target !== null) {
      vcamLastZoom = { player: vcamActivePlayer, target };
    } else if (vcamLastZoom && vcamZoomOn() && scores[vcamLastZoom.player] === 0) {
      vcamHold = { player: vcamLastZoom.player, target: vcamLastZoom.target, at: Date.now() };
      target = vcamHold.target;
      log("Checkout zoom: checkout! holding on the double until Submit");
    } else if (vcamLastZoom && scores[vcamLastZoom.player] !== 0) {
      vcamLastZoom = null;
    }
    if (target !== vcamZoomTarget) {
      vcamZoomTarget = target;
      log("Checkout zoom:", target === null ? "off" : (target === 25 ? "Bull" : "D" + target));
    }
  }

  function startVirtualCamStream(camIndex) {
    const canvas = document.createElement("canvas");
    canvas.width = VCAM_OUT; canvas.height = VCAM_OUT;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#000"; ctx.fillRect(0, 0, canvas.width, canvas.height);
    const stream = canvas.captureStream(30);
    let stopped = false;
    let req = null;
    const zs = { cx: null, cy: null, w: 0, h: 0 }; // smoothed zoom state, in source-picture pixels

    // Painting is separate from receiving: frames from AutoDarts can arrive
    // slowly, but rotation and zoom must respond immediately, so the newest
    // frame is re-painted ~30x a second with the current rotation/zoom.
    let lastBmp = null;
    function render() {
      const bmp = lastBmp;
      if (!bmp) return;
      const W = bmp.width, H = bmp.height;

      // Output is a fixed SQUARE. The picture is cropped to the board (plus a margin for the
      // number ring), centred, and fitted into the square — so any spare room is black, split
      // evenly on both sides. (Board position comes from the AutoDarts calibration; without
      // it the whole picture is fitted instead.)
      let baseX = W / 2, baseY = H / 2, baseW = W, baseH = H;
      const bd = vcamBoards && vcamBoards[camIndex];
      if (bd && bd.doubleOuters && bd.doubleOuters.length) {
        const kx = W / vcamCamW, ky = H / vcamCamH;
        const xs = bd.doubleOuters.map(q => q[0] * kx), ys = bd.doubleOuters.map(q => q[1] * ky);
        const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
        const m = vcamSquareMargin();
        // keep the FULL height of the picture (all the context round the board) and a band of
        // the picture's width centred on the board; the fit below splits any spare room evenly
        baseX = (minX + maxX) / 2; baseY = H / 2;
        baseW = Math.min(W, (maxX - minX) * m); baseH = H;
      }

      // zoom (smoothed) toward the finishing double, or back out
      let tx = baseX, ty = baseY, tw = baseW, th = baseH;
      if (vcamZoomTarget !== null) {
        const c = doubleCentre(camIndex, vcamZoomTarget);
        if (c) { tx = c.x * W / vcamCamW; ty = c.y * H / vcamCamH; tw = th = baseW / vcamZoomFactor(); }
      }
      if (zs.cx === null) { zs.cx = baseX; zs.cy = baseY; zs.w = baseW; zs.h = baseH; }
      zs.cx += (tx - zs.cx) * 0.18; zs.cy += (ty - zs.cy) * 0.18;
      zs.w += (tw - zs.w) * 0.18; zs.h += (th - zs.h) * 0.18;
      const sw = Math.min(zs.w, W), sh = Math.min(zs.h, H);
      const sx = Math.min(Math.max(zs.cx - sw / 2, 0), W - sw);
      const sy = Math.min(Math.max(zs.cy - sh / 2, 0), H - sh);

      // Rotation is applied only to this DartCounter feed — AutoDarts
      // itself still sees the camera unrotated.
      const rot = GM_getValue("vcam_rotation_" + camIndex, 0);
      const O = VCAM_OUT;
      if (canvas.width !== O || canvas.height !== O) { canvas.width = O; canvas.height = O; }
      ctx.save();
      ctx.translate(O / 2, O / 2);
      ctx.rotate(rot * Math.PI / 180);
      ctx.fillStyle = "#000";
      ctx.fillRect(-O / 2, -O / 2, O, O);
      const k = O / Math.max(sw, sh), dw = sw * k, dh = sh * k;
      ctx.drawImage(bmp, sx, sy, sw, sh, -dw / 2, -dh / 2, dw, dh);
      ctx.restore();
      const st = vcamStats[camIndex] || (vcamStats[camIndex] = { frames: 0 });
      st.rot = rot; st.w = canvas.width; st.h = canvas.height;
    }
    const renderTimer = setInterval(render, 33);

    function connect() {
      if (stopped) return;
      let buf = new Uint8Array(0);
      req = GM_xmlhttpRequest({
        method: "GET",
        url: adBase() + "/api/streams/live?cam=" + camIndex,
        responseType: "stream",
        onloadstart: async (res) => {
          try {
            const reader = res.response.getReader();
            while (!stopped) {
              const { value, done } = await reader.read();
              if (done) break;
              const merged = new Uint8Array(buf.length + value.length);
              merged.set(buf); merged.set(value, buf.length);
              buf = merged;
              // pull out every complete JPEG (FFD8 ... FFD9), draw the newest
              let last = null;
              for (;;) {
                let s = -1, e = -1;
                for (let i = 0; i < buf.length - 1; i++) { if (buf[i] === 0xFF && buf[i + 1] === 0xD8) { s = i; break; } }
                if (s < 0) { buf = new Uint8Array(0); break; }
                for (let i = s + 2; i < buf.length - 1; i++) { if (buf[i] === 0xFF && buf[i + 1] === 0xD9) { e = i + 2; break; } }
                if (e < 0) { buf = buf.slice(s); break; }
                last = buf.slice(s, e);
                buf = buf.slice(e);
              }
              if (last) {
                const bmp = await createImageBitmap(new Blob([last], { type: "image/jpeg" }));
                if (lastBmp) lastBmp.close();
                lastBmp = bmp; // the render loop below paints it (and re-paints it on rotate/zoom changes)
                const st = vcamStats[camIndex] || (vcamStats[camIndex] = { frames: 0 });
                st.frames++; st.lastFrameAt = Date.now();
              }
            }
          } catch (e) { log("Virtual cam", camIndex, "stream error:", e && e.message); }
          if (!stopped) setTimeout(connect, 1000); // dropped — reconnect
        },
        onerror: () => { if (!stopped) setTimeout(connect, 2000); }
      });
    }
    connect();

    const track = stream.getVideoTracks()[0];
    const origStop = track.stop.bind(track);
    vcamActive.push(camIndex); GM_setValue("vcam_last", camIndex); updateVcamRotateBtn();
    loadVcamBoards(true); // pick up a fresh calibration whenever a camera starts
    track.stop = () => {
      stopped = true;
      clearInterval(renderTimer);
      const k = vcamActive.indexOf(camIndex); if (k >= 0) vcamActive.splice(k, 1);
      updateVcamRotateBtn();
      try { req && req.abort(); } catch (e) {}
      origStop();
    };
    log("Virtual cam", camIndex, "started");
    return stream;
  }

  function installVirtualCameras() {
    const md = unsafeWindow.navigator.mediaDevices;
    if (!md || md.__ad2dcPatched) return;
    md.__ad2dcPatched = true;
    const origEnum = md.enumerateDevices.bind(md);
    const origGUM = md.getUserMedia.bind(md);

    md.enumerateDevices = async function () {
      let list = [];
      try { list = Array.from(await origEnum()); } catch (e) {}
      for (let i = 0; i < VCAM_COUNT; i++) {
        list.push({ deviceId: vcamId(i), kind: "videoinput", label: "AutoDarts Camera " + (i + 1), groupId: "ad2dc",
          toJSON() { return { deviceId: this.deviceId, kind: this.kind, label: this.label, groupId: this.groupId }; } });
      }
      return list;
    };

    function requestedDeviceId(c) {
      const d = c && c.video && c.video.deviceId;
      if (!d) return null;
      if (typeof d === "string") return d;
      if (Array.isArray(d)) return d[0];
      return d.exact || d.ideal || null;
    }

    md.getUserMedia = async function (constraints) {
      const id = requestedDeviceId(constraints);
      const m = id && /^ad2dc-autodarts-cam-(\d)$/.exec(Array.isArray(id) ? id[0] : id);
      if (!m) return origGUM(constraints);
      const stream = startVirtualCamStream(parseInt(m[1], 10));
      if (constraints.audio) { // keep any mic request working
        try { const a = await origGUM({ audio: constraints.audio }); a.getAudioTracks().forEach(t => stream.addTrack(t)); } catch (e) {}
      }
      return stream;
    };

    loadVcamBoards();
    // AutoDarts may not be calibrated / reachable yet when the page loads: keep asking until it is
    setInterval(() => { if (!vcamBoards) loadVcamBoards(); }, 4000);
    GM_registerMenuCommand("Set AutoDarts address (now " + adBase() + ")", () => {
      const v = prompt("AutoDarts local address (the board's API), e.g. http://127.0.0.1:3180", adBase());
      if (v && /^https?:\/\//i.test(v.trim())) { GM_setValue("autodarts_base", v.trim().replace(/\/+$/, "")); location.reload(); }
    });
    setInterval(updateZoomTarget, 200);
    // Submit (clicked by the user or by Auto Submit) ends a checkout hold
    document.addEventListener("click", (ev) => {
      const b0 = findSubmitButton();
      if (b0 && b0.contains(ev.target)) { dartsThisTurn = 0; vcamTurnOver(); } // Submit = new turn
      if (!vcamHold) return;
      const b = b0;
      if (b && b.contains(ev.target)) { log("Checkout zoom: Submit clicked — releasing hold"); vcamHold = null; vcamLastZoom = null; updateZoomTarget(); }
    }, true);
    log("Virtual AutoDarts cameras installed in DartCounter's camera list");
  }

  if (isDartCounter) { ensureToggleUI(); installVirtualCameras(); }

  if (isAutoDarts) {
    preloadCallerAudio();

    function updateHeartbeat() { GM_setValue("autodarts_heartbeat", Date.now()); }
    updateHeartbeat();
    setInterval(updateHeartbeat, 5000);

    // Catches the case where this frame finishes loading AFTER the Bridge
    // was already turned on — the value-change listener earlier in the
    // script only fires on FUTURE changes, so a freshly created embedded
    // view would otherwise miss the enable signal and never start reading
    // darts, even though its heartbeat still looks fine.
    if (GM_getValue("bridge_state", false)) {
      bridgeEnabled = true;
      startAutodartsProducer();
    }

    // --- Test hook: simulate a real detected dart from THIS console (the
    // AutoDarts side), publishing through the exact same GM_setValue call
    // a genuine detected throw would use — so DartCounter has no way to
    // tell it apart from a real one. Run from the AutoDarts tab/embedded
    // view's own DevTools console:
    //   AD2DC_simulateDart("T20")   e.g. S1, D20, T19, 50, 25, M10, MISS
    //   AD2DC_simulateTakeout()     simulates pulling darts out afterward
    // unsafeWindow (not window) — Tampermonkey runs in an isolated JS
    // world, so a plain window.X assignment isn't visible from the page's
    // own DevTools console. unsafeWindow is Tampermonkey's explicit way to
    // expose something to the real page.
    unsafeWindow.AD2DC_simulateDart = function (label) {
      seq += 1;
      const payload = { seq, label: String(label), slot: 0, sessionId: producerSessionId, ts: Date.now() };
      GM_setValue(CFG.storeDartKey, payload);
      log("[TEST] Simulated dart published:", label);
    };
    unsafeWindow.AD2DC_simulateTakeout = function () {
      takeoutSeq += 1;
      GM_setValue(CFG.storeTakeoutKey, { seq: takeoutSeq, sessionId: producerSessionId, ts: Date.now() });
      log("[TEST] Simulated takeout event published, seq", takeoutSeq);
    };
    log("Test hooks ready: AD2DC_simulateDart('T20'), AD2DC_simulateTakeout()");
  }

  // --- Producer: publish EACH dart the moment it lands, not at end of round ---
  function startAutodartsProducer() {
    if (pollIntervalId) return;
    let lastSeen = ["-", "-", "-"]; // last known value per dart slot this turn
    let lastPhase = null;

    // AutoDarts' own status label cycles through these exact phrases as a
    // dart sequence completes and gets taken out — much more reliable than
    // guessing which WAIT/STABLE/DART/HAND/TAKEOUT badge has a filled
    // background (that heuristic wasn't firing reliably). Matched
    // case-insensitively, and takeout completion specifically matches on
    // the keyword "finished" rather than the exact full phrase — the same
    // kind of exact-string fragility bit us for real with Bull/BULL
    // earlier, so this is hardened against wording/casing drift up front.
    const PHASE_LABELS_RE = /^(throw detected|takeout started|takeout in progress|takeout finished)$/i;
    const TAKEOUT_FINISHED_RE = /finished/i;

    function readDarts() {
      const els = document.getElementsByClassName(CFG.autodartsSpanClass);
      const darts = [];
      for (let i = 0; i < els.length; i++) darts.push(els[i].textContent.trim());
      return darts;
    }

    // Dart slot values always take one of these exact shapes — "-" for
    // empty, a segment code, or a plain number — unlike the status/phase
    // labels, which are full words or phrases. Matching by shape means
    // this keeps working even if AutoDarts ever adds, removes, or
    // reorders status elements ahead of the 3 dart slots; the old
    // fixed-position slice(2, 5) would silently misattribute darts to the
    // wrong slot if that ever happened.
    const DART_VALUE_RE = /^(-|MISS|OUT|BULL|DBULL|SBULL|OUTER|\d{1,2}|[SDTMsdtm]\d{1,2})$/i;

    function extractDartSlots(allEls) {
      const matches = allEls.filter(t => DART_VALUE_RE.test(t));
      if (matches.length === 3) return matches;
      // The old fallback guessed fixed positions (slice(2,5)) here — but
      // that's exactly the fragility this function exists to avoid. If the
      // shape is ever genuinely wrong, guessing risks silently entering a
      // wrong score into a live match, which is worse than entering
      // nothing. Refuse instead: treat this tick as "no darts detected"
      // and log it loudly so a real mismatch doesn't slip by unnoticed.
      log("extractDartSlots: unexpected dart-slot shape — refusing to guess. RAW:", allEls);
      return ["-", "-", "-"];
    }

    let lastRawLogged = "";

    function tick() {
      if (!bridgeEnabled) return;
      const allEls = readDarts();
      // Only slots 2,3,4 are treated as the 3 dart values — but log the FULL
      // element list raw whenever it changes, so we can see the true shape
      // and catch cases where a miss shifts the index or uses a different label.
      const rawSnapshot = allEls.join("|");
      if (CFG.debug && rawSnapshot !== lastRawLogged) {
        log("RAW spans:", allEls);
        lastRawLogged = rawSnapshot;
      }

      const current = extractDartSlots(allEls);

      for (let i = 0; i < 3; i++) {
        const val = current[i] || "-";
        if (val !== "-" && val !== "" && val !== lastSeen[i]) {
          // a new dart landed in this slot — publish immediately
          seq += 1;
          GM_setValue(CFG.storeDartKey, { seq, label: val, slot: i, sessionId: producerSessionId, ts: Date.now() });
          if (CFG.debug) log("Published dart:", val, "slot", i);

          const callerScore = extractCallerScore(parseDartLabel(val));
          if (callerScore) playCallerNumber(callerScore);
        }
        lastSeen[i] = val;
      }

      // full reset detected (new turn) — clear tracking
      if (current.length === 3 && current.every(d => d === "-" || d === "")) {
        lastSeen = ["-", "-", "-"];
      }

      // Detect takeout: fire once when the phase text transitions to "Takeout
      // finished" — but NOT on the very first reading after startup, since
      // that's just capturing whatever leftover status was already on
      // screen (often already "Takeout finished" from before), not a real
      // new event. lastPhase === null means "haven't recorded a baseline
      // yet", so skip firing that one time.
      const currentPhase = allEls.find(t => PHASE_LABELS_RE.test(t)) || null;
      if (currentPhase !== lastPhase) {
        if (CFG.debug) log("Throw phase changed:", lastPhase, "->", currentPhase);
        if (lastPhase !== null && currentPhase && TAKEOUT_FINISHED_RE.test(currentPhase)) {
          takeoutSeq += 1;
          GM_setValue(CFG.storeTakeoutKey, { seq: takeoutSeq, sessionId: producerSessionId, ts: Date.now() });
          log("Published takeout event, seq", takeoutSeq);
        }
        lastPhase = currentPhase;
      }
    }

    pollIntervalId = setInterval(tick, CFG.pollIntervalMs);
    log("Producer active (dart-by-dart mode).");
  }

  // One dart / one takeout arriving from AutoDarts (via the old page
  // producer or the board's local API) — enter it into DartCounter.
  function handleDartLabel(label, playCaller) {
    dartsThisTurn++; lastDartAt = Date.now();
    // The score that drops right after one of MY darts is entered is my panel.
    if (vcamLocalPath !== location.pathname) { vcamLocalPath = location.pathname; vcamLocalPlayer = null; }
    const scoresBefore = readAllScores();
    setTimeout(() => {
      const after = readAllScores();
      const dropped = after.map((v, i) => (scoresBefore[i] != null && v != null && v < scoresBefore[i]) ? i : -1).filter(i => i >= 0);
      if (dropped.length === 1 && vcamLocalPlayer !== dropped[0]) {
        vcamLocalPlayer = dropped[0];
        log("Checkout zoom: my panel is player", dropped[0] + 1, "(its score dropped after my dart)");
      }
    }, 1800);
    const parsed = parseDartLabel(label);
    if (playCaller) { const sc = extractCallerScore(parsed); if (sc) playCallerNumber(sc); }
    queueDartEntry(parsed);
  }

  let lastTakeoutAt = 0;
  function handleTakeout() {
    if (Date.now() - lastTakeoutAt < 4000) return; // 'finished' status and 'darts cleared' can both fire — only one Submit
    lastTakeoutAt = Date.now();
    dartsThisTurn = 0;
    vcamTurnOver();

    if (!autoSubmitEnabled) {
      log("Takeout detected — Auto Submit is off, skipping");
      return;
    }

    // Route through the same queue dart entries use — otherwise Submit
    // could fire while the last dart's own click sequence (tab click,
    // wait, number click) is still in progress, interrupting it or
    // submitting a turn before the final dart is actually entered.
    dartEntryQueue = dartEntryQueue
      .then(() => {
        const submitBtn = findSubmitButton();
        if (clickEl(submitBtn)) {
          log("Auto Submit — clicked Submit after takeout");
        } else {
          log("FAILED — Submit button not found on takeout");
          notify("AD2DC Error", "Submit button not found", true);
        }
      })
      .catch(e => log("Auto Submit error:", e));
  }

  // --- API mode: read darts straight from the board's local API
  // (/api/state), so no AutoDarts web page is needed (v2.x has none). The
  // request goes through GM_xmlhttpRequest, which is allowed to reach the
  // local board from the https DartCounter page.
  let apiMode = false, apiPollId = null, apiBusy = false, apiLastThrows = null, apiLastPhase = null;

  function fetchBoardState() {
    return new Promise((resolve) => {
      GM_xmlhttpRequest({
        method: "GET", url: adBase() + "/api/state", timeout: 3000,
        onload: (r) => { try { resolve(JSON.parse(r.responseText)); } catch (e) { resolve(null); } },
        onerror: () => resolve(null), ontimeout: () => resolve(null)
      });
    });
  }

  async function probeBoardApi(attempts = 4) {
    for (let i = 0; i < attempts; i++) {
      const st = await fetchBoardState();
      if (st && typeof st === "object" && ("throws" in st || "status" in st || "connected" in st)) return st;
      await new Promise(r => setTimeout(r, 400));
    }
    return null;
  }

  function dartLabelFromThrow(t) {
    const seg = t && t.segment;
    if (!seg) return null;
    return String(seg.name || "");
  }

  function startApiPoller() {
    if (apiPollId) return;
    apiMode = true; apiLastThrows = null; apiLastPhase = null; apiBusy = false;
    preloadCallerAudio();
    apiPollId = setInterval(async () => {
      if (!bridgeEnabled || apiBusy) return;
      apiBusy = true;
      try {
        const st = await fetchBoardState();
        if (!st) return;
        const throws = Array.isArray(st.throws) ? st.throws : [];
        const n = throws.length;
        if (apiLastThrows === null) { apiLastThrows = n; log("API poller: started, board shows", n, "dart(s) already"); }
        if (n > apiLastThrows) {
          for (let i = apiLastThrows; i < n; i++) {
            const label = dartLabelFromThrow(throws[i]);
            log("API dart", i + 1, ":", label);
            if (label) handleDartLabel(label, true);
          }
        }
        const cleared = apiLastThrows > 0 && n === 0;
        apiLastThrows = n;
        // v1 reports the phase in "status" ("Takeout in progress"); v2 keeps
        // status on "Throw" and reports it in "event" ("Takeout finished").
        const phase = (st.status || "") + "|" + (st.event || "");
        if (cleared && /takeout/i.test(phase)) { log("API darts cleared during takeout"); handleTakeout(); }
        if (phase !== apiLastPhase) {
          if (CFG.debug) log("Board phase:", apiLastPhase, "->", phase);
          if (apiLastPhase !== null && /takeout finished/i.test(phase) && !/takeout finished/i.test(apiLastPhase)) { log("API takeout finished"); handleTakeout(); }
          apiLastPhase = phase;
        }
      } finally { apiBusy = false; }
    }, 200);
    log("API poller active — reading", adBase() + "/api/state");
  }

  function stopApiPoller() {
    if (apiPollId) { clearInterval(apiPollId); apiPollId = null; }
    apiMode = false;
  }

  // --- Consumer: enter each dart as it arrives, and Submit on takeout ---
  let lastSeqHandled = 0;
  let lastTakeoutSeqHandled = 0;
  let lastDartSessionSeen = null;
  let lastTakeoutSessionSeen = null;
  let consumerStarted = false;

  function startDartCounterConsumer() {
    // Each time the Bridge turns on, the embedded AutoDarts view is torn
    // down and recreated from scratch — its own dart counter restarts at 1
    // each time. Reset our "already handled" trackers to match, otherwise
    // every dart from the fresh instance looks like a duplicate of an
    // already-processed one and gets silently ignored.
    lastSeqHandled = 0;
    lastTakeoutSeqHandled = 0;
    lastDartSessionSeen = null;
    lastTakeoutSessionSeen = null;
    dartsThisTurn = 0;

    if (consumerStarted) return; // listeners themselves only need attaching once
    consumerStarted = true;

    GM_addValueChangeListener(CFG.storeDartKey, (name, oldVal, newVal) => {
      if (!bridgeEnabled || !newVal) return;

      // A producer session change (the AutoDarts iframe reloading on its
      // own, not via a Bridge toggle) restarts its seq counter at 1 too —
      // seq alone can't tell that apart from an old duplicate. Catch it
      // here so genuine new darts from a silently-restarted producer
      // don't get discarded.
      if (newVal.sessionId !== lastDartSessionSeen) {
        log("New producer session detected for darts — resetting dedup tracking");
        lastDartSessionSeen = newVal.sessionId;
        lastSeqHandled = 0;
      }
      if (newVal.seq <= lastSeqHandled) return; // avoid re-processing on load
      lastSeqHandled = newVal.seq;

      handleDartLabel(newVal.label);
    });

    GM_addValueChangeListener(CFG.storeTakeoutKey, (name, oldVal, newVal) => {
      if (!bridgeEnabled || !newVal) return;

      if (newVal.sessionId !== lastTakeoutSessionSeen) {
        log("New producer session detected for takeouts — resetting dedup tracking");
        lastTakeoutSessionSeen = newVal.sessionId;
        lastTakeoutSeqHandled = 0;
      }
      if (newVal.seq <= lastTakeoutSeqHandled) return;
      lastTakeoutSeqHandled = newVal.seq;
      handleTakeout();
    });

    log("Consumer active (dart-by-dart mode).");
  }
})();
