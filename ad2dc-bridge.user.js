// ==UserScript==
// @name         AutoDarts ↔ DartCounter Bridge (Dart-by-Dart)
// @namespace    autodarts.dartcounter.bridge.dbd
// @version      1.50.0
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
// @grant        unsafeWindow
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
  const callerEnabled = true; // hardcoded on for this test — a proper toggle can replace this later
  const callerAudioCache = {};

  function preloadCallerAudio() {
    for (let n = 1; n <= 20; n++) {
      const audio = new Audio(CALLER_BASE_URL + n + ".wav");
      audio.preload = "auto";
      callerAudioCache[n] = audio;
    }
    log("Caller: preloaded 1-20 audio files from", CALLER_BASE_URL);
  }

  // Strips the Single/Double/Treble prefix and just returns the base
  // number, e.g. "T20" -> 20, "S7" -> 7, "14" -> 14. Returns null for
  // anything that isn't a plain numbered segment (MISS, Bull, Outer, "-").
  function extractCallerNumber(rawLabel) {
    const s = String(rawLabel || "").trim().toUpperCase();
    if (!s || s === "-") return null;
    if (/^\d{1,2}$/.test(s)) return parseInt(s, 10);
    const m = /^[SDT](\d{1,2})$/.exec(s);
    return m ? parseInt(m[1], 10) : null;
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
    return containers[0].querySelector("div.relative.cursor-pointer.p-2\\.5");
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

  async function tryEnforceDartCounterInputMode() {
    const toggle = findDartCounterModeToggle();
    if (!toggle) { log("enforceDartCounterInputMode: no toggle element found — not on a match page?"); return true; } // nothing to retry for — not on a match page

    if (toggle.querySelector("span.icon-keyboard_single")) {
      log("DartCounter input mode already dart-by-dart — nothing to do");
      return true;
    }

    log("enforceDartCounterInputMode: opening dropdown, watching the whole page for the option to appear...");

    const option = await new Promise((resolve) => {
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        observer.disconnect();
        clearInterval(poll);
        resolve(result);
      };

      // Primary: react the instant the option is added anywhere on the page.
      const observer = new MutationObserver(() => {
        const found = findDartCounterModeOptionAnywhere(toggle, "icon-keyboard_single");
        if (found) finish(found);
      });
      observer.observe(document.body, { childList: true, subtree: true });

      // Backup: poll too, in case it appears via an attribute/visibility
      // change rather than a new node the observer would catch.
      let attempts = 0;
      const poll = setInterval(() => {
        attempts++;
        const found = findDartCounterModeOptionAnywhere(toggle, "icon-keyboard_single");
        if (found) { finish(found); return; }
        if (attempts >= 30) finish(null); // ~6s timeout
      }, 200);

      clickEl(toggle); // opens the dropdown — click happens after listeners are armed
    });

    if (option) {
      clickEl(option);
      log("Switched DartCounter input mode to dart-by-dart");
      return true;
    } else {
      log("FAILED — dart-by-dart mode option not found anywhere on the page");
      clickEl(toggle); // best effort: close the dropdown again
      return false;
    }
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
      showAutodartsFrame(); // starts loading now — needs a moment before its heartbeat appears
      // Run these one after another, not overlapping — clicking the
      // Settings page's Auto Submit toggle at the same time as opening the
      // input-mode dropdown was interfering with it, causing extra retries.
      await enforceDartCounterInputMode();
      enforceDartCounterAutoSubmitOff();
      const ready = await waitForAutodartsReady();
      if (!ready) {
        bridgeEnabled = false;
        updateToggleUI(false);
        hideAutodartsFrame();
        notify("AutoDarts not found", "The embedded AutoDarts view didn't load in time — try again.", true);
        return;
      }
      notify("AD2DC-Bridge (dart-by-dart)", "ready - waiting for darts");
      updateToggleUI(true);
      autoSubmitEnabled = true;
      updateAutoSubmitUI();
      startDartCounterConsumer();
    } else if (isAutoDarts) {
      startAutodartsProducer();
    }
  }

  function onBridgeDisabled() {
    stopKeepAlive();
    if (isDartCounter) {
      notify("AD2DC-Bridge", "disabled");
      updateToggleUI(false);
      hideAutodartsFrame();
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
  let toggleWrap = null;
  let turnScoreEl = null;
  let turnScoreTotal = 0;

  // Point value of one parsed dart — used to keep the running turn-score display current.
  function scoreFromParsed(parsed) {
    if (!parsed) return 0;
    if (parsed.tab === "MISS") return 0;
    if (parsed.tab === "Bull") return 50;
    if (parsed.tab === "Outer") return 25;
    if (parsed.tab === "Single") return parsed.num;
    if (parsed.tab === "Double") return parsed.num * 2;
    if (parsed.tab === "Treble") return parsed.num * 3;
    return 0;
  }

  function updateTurnScoreUI() {
    if (!turnScoreEl) return;
    turnScoreEl.textContent = String(turnScoreTotal);
  }

  function addToTurnScore(points) {
    turnScoreTotal += points;
    updateTurnScoreUI();
  }

  function resetTurnScore() {
    turnScoreTotal = 0;
    updateTurnScoreUI();
  }

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
      if (!autodartsFrame) return;
      const rect = el.getBoundingClientRect();
      GM_setValue("bridge_ui_geom_expanded", { width: rect.width, height: rect.height });
    }).observe(el);
  }

  function updateAutoSubmitUI() {
    if (!autoSubmitBtn) return;
    autoSubmitBtn.textContent = autoSubmitEnabled ? "ON" : "OFF";
    autoSubmitBtn.style.background = autoSubmitEnabled ? "#059669" : "#6b7280";
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
    toggleWrap.style.width = (savedGeom ? savedGeom.width : 480) + "px";
    toggleWrap.style.height = (savedGeom ? savedGeom.height : 420) + "px";
  }

  function hideAutodartsFrame() {
    if (autodartsFrame) { autodartsFrame.remove(); autodartsFrame = null; }
    if (toggleWrap) { toggleWrap.style.height = "auto"; toggleWrap.style.width = "auto"; }
  }

  function ensureToggleUI() {
    if (toggleBtn) return;
    const wrap = document.createElement("div");
    toggleWrap = wrap;
    Object.assign(wrap.style, {
      position: "fixed", top: "10px", left: "50%",
      zIndex: "99999",
      background: "#1f2937", color: "#fff", padding: "8px 10px", borderRadius: "6px",
      fontFamily: "monospace", fontSize: "12px",
      display: "flex", flexDirection: "column", gap: "6px",
      userSelect: "none",
      resize: "both", overflow: "hidden"
    });

    const savedPos = GM_getValue("bridge_ui_pos", null);
    if (savedPos) {
      wrap.style.top = Math.max(savedPos.top, MIN_TOP) + "px";
      wrap.style.left = savedPos.left + "px";
      wrap.style.transform = "none";
    } else {
      wrap.style.transform = "translateX(-50%)";
    }

    // Drag handle — dragging over the embedded AutoDarts view (when shown)
    // doesn't work reliably, since the iframe captures its own mouse
    // events, so dragging only starts from this row.
    const dragHandle = document.createElement("div");
    Object.assign(dragHandle.style, {
      display: "flex", gap: "16px", alignItems: "center",
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

    // Running turn score — sums each dart as it's entered, resets on takeout
    const scoreGroup = document.createElement("div");
    Object.assign(scoreGroup.style, { display: "flex", gap: "8px", alignItems: "center" });
    const scoreLabel = document.createElement("span");
    scoreLabel.textContent = "Score";
    turnScoreEl = document.createElement("span");
    Object.assign(turnScoreEl.style, {
      padding: "6px 14px", border: "1px solid #374151", borderRadius: "4px",
      background: "#111827", color: "#fbbf24", fontFamily: "monospace", fontWeight: "bold",
      fontSize: "18px", minWidth: "40px", textAlign: "center"
    });
    turnScoreEl.textContent = "0";
    scoreGroup.appendChild(scoreLabel);
    scoreGroup.appendChild(turnScoreEl);

    // Update check — opens the script's own raw source URL in a new tab.
    // Tampermonkey intercepts that navigation itself and shows its
    // install/update page (same as pasting the URL into the address bar
    // manually) — there's no API for a userscript to trigger Tampermonkey's
    // update check directly, so this is the reliable way to get the same
    // result with one click instead of digging through the dashboard.
    const updateBtn = document.createElement("button");
    updateBtn.textContent = "Update";
    Object.assign(updateBtn.style, {
      cursor: "pointer", padding: "6px 10px", border: "1px solid #374151",
      borderRadius: "4px", background: "#6b7280", color: "#fff",
      fontFamily: "monospace", fontSize: "11px"
    });
    updateBtn.addEventListener("click", () => {
      window.open(CFG.updateUrl, "_blank");
    });

    dragHandle.appendChild(bridgeGroup);
    dragHandle.appendChild(autoSubmitGroup);
    dragHandle.appendChild(scoreGroup);
    dragHandle.appendChild(updateBtn);
    wrap.appendChild(dragHandle);
    document.documentElement.appendChild(wrap);
    makeDraggable(wrap, dragHandle);
    updateToggleUI(bridgeEnabled);
    updateAutoSubmitUI();
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

      <p><strong>The three boxes</strong><br>
      <strong>Bridge</strong> — main on/off switch.<br>
      <strong>Auto Submit</strong> — presses DartCounter's Submit button for
      you after a takeout (e.g. after a bust). Turns on automatically with
      the Bridge; toggle off to press Submit yourself instead.<br>
      <strong>Score</strong> — running total for the current throw, adds up
      as each dart lands, resets when darts are pulled from the board.</p>

      <p><strong>Staying up to date</strong><br>
      This script auto-updates in the background — Tampermonkey checks the
      source on GitHub periodically on its own. Want it right now instead
      of waiting? Click <strong>Update</strong> below the Score
      box — it opens the source in a new tab and Tampermonkey handles the
      rest.</p>

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

  if (isDartCounter) { ensureToggleUI(); }

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
    // background (that heuristic wasn't firing reliably).
    const PHASE_LABELS = ["Throw detected", "Takeout started", "Takeout in progress", "Takeout finished"];

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
      // Shape didn't come out as expected — fall back to the old
      // assumption rather than fail outright, but log it loudly so a
      // real mismatch doesn't slip by unnoticed.
      log("extractDartSlots: expected 3 dart-shaped values, found", matches.length, "— falling back to fixed positions. RAW:", allEls);
      return allEls.slice(2, 5);
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
          log("Published dart:", val, "slot", i);

          const callerNum = extractCallerNumber(val);
          if (callerNum) playCallerNumber(callerNum);
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
      const currentPhase = allEls.find(t => PHASE_LABELS.includes(t)) || null;
      if (currentPhase !== lastPhase) {
        log("Throw phase changed:", lastPhase, "->", currentPhase);
        if (lastPhase !== null && currentPhase === "Takeout finished") {
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
    resetTurnScore();

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

      const parsed = parseDartLabel(newVal.label);
      queueDartEntry(parsed);
      addToTurnScore(scoreFromParsed(parsed));
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

      resetTurnScore(); // darts pulled from the board — clear the running total regardless of Auto Submit

      if (!autoSubmitEnabled) {
        log("Takeout detected — Auto Submit is off, skipping");
        return;
      }

      const submitBtn = findSubmitButton();
      if (clickEl(submitBtn)) {
        log("Auto Submit — clicked Submit after takeout");
      } else {
        log("FAILED — Submit button not found on takeout");
        notify("AD2DC Error", "Submit button not found", true);
      }
    });

    log("Consumer active (dart-by-dart mode).");
  }
})();
