(() => {
  "use strict";

  const W = 320, H = 170;
  const canvas = document.getElementById("screen");
  const ctx = canvas.getContext("2d", { alpha: false });
  const renderer = new PixelRenderer(ctx, W, H);
  let renderFrame = null;
  const logEl = document.getElementById("log");
  const MAX_LOG_ENTRIES = 500;
  const MAX_LOG_CHARS = 100000;
  const MAX_LOG_ENTRY_CHARS = 10000;
  const logEntries = [];
  let logChars = 0;
  const statusEl = document.getElementById("status");
  const urlEl = document.getElementById("url");
  const appSourceEl = document.getElementById("appSource");
  function updateAppSource() {
    urlEl.hidden = appSourceEl.value !== "custom";
  }
  appSourceEl.addEventListener("change", () => {
    updateAppSource();
    if (!urlEl.hidden) urlEl.focus();
  });
  updateAppSource();
  let worker = null;
  let inputView = null;
  let loadVersion = 0;
  let pendingLoad = null;
  let audioContext = null;
  let activeTone = null;
  const sprites = new Map();

  const themeSelect = document.getElementById("theme");
  const THEME_STORAGE_KEY = "bruce-emulator-theme";
  let themeColors = {bg: 0, primary: 0xffff, secondary: 0xffff};

  function cssColorToRgb565(value) {
    const hex = String(value).trim().replace(/^#/, "");
    if (!/^[0-9a-f]{6}$/i.test(hex)) return 0;
    const rgb = parseInt(hex, 16);
    return (((rgb >> 19) & 31) << 11) | (((rgb >> 10) & 63) << 5) | ((rgb >> 3) & 31);
  }

  function readThemeColors() {
    const style = getComputedStyle(document.documentElement);
    return {
      bg: cssColorToRgb565(style.getPropertyValue("--screen-bg")),
      primary: cssColorToRgb565(style.getPropertyValue("--accent")),
      secondary: cssColorToRgb565(style.getPropertyValue("--text"))
    };
  }

  function applyTheme(name, persist) {
    if (!Array.from(themeSelect.options).some(option => option.value === name)) name = "neon";
    document.documentElement.dataset.theme = name;
    themeSelect.value = name;
    themeColors = readThemeColors();
    if (persist) {
      try {
        localStorage.setItem(THEME_STORAGE_KEY, name);
      } catch (e) {
        // Browsers may block storage; the theme still applies for this visit.
      }
    }
    if (!worker) clearScreen();
  }

  let initialTheme = "neon";
  try {
    initialTheme = localStorage.getItem(THEME_STORAGE_KEY) || "neon";
  } catch (e) {
    // Use the default theme when storage is unavailable.
  }
  themeSelect.addEventListener("change", () => applyTheme(themeSelect.value, true));
  applyTheme(initialTheme, false);

  const bezel = canvas.parentElement;
  const device = bezel.parentElement;
  const deviceColumn = device.parentElement;
  const workspace = deviceColumn.parentElement;
  function updateDisplaySize() {
    const ratio = window.devicePixelRatio || 1;
    const bezelStyle = getComputedStyle(bezel);
    const deviceStyle = getComputedStyle(device);
    const workspaceStyle = getComputedStyle(workspace);
    const columns = Number(workspaceStyle.getPropertyValue("--device-columns"));
    const gap = parseFloat(workspaceStyle.columnGap);
    const columnWidth = (workspace.clientWidth - gap * (columns - 1)) / columns;
    const frameWidth = parseFloat(deviceStyle.paddingLeft) + parseFloat(deviceStyle.paddingRight) +
      parseFloat(deviceStyle.borderLeftWidth) + parseFloat(deviceStyle.borderRightWidth) +
      parseFloat(bezelStyle.paddingLeft) + parseFloat(bezelStyle.paddingRight);
    // Measure the workspace, not the shrink-wrapped device, to avoid resize feedback.
    const available = Math.min(760, columnWidth) - frameWidth;
    const pixelScale = available * ratio / W;
    const scale = window.matchMedia("(max-width: 650px)").matches
      ? Math.max(1, pixelScale)
      : Math.max(1, Math.floor(pixelScale));
    const deviceWidth = W * scale / ratio + frameWidth;
    deviceColumn.style.width = `${deviceWidth}px`;
    workspace.style.setProperty("--device-width", `${deviceWidth}px`);
    workspace.parentElement.style.setProperty("--header-width", `${deviceWidth * columns + gap * (columns - 1)}px`);
    canvas.style.width = `${W * scale / ratio}px`;
    canvas.style.height = `${H * scale / ratio}px`;
    canvas.style.transform = "none";
    // Align the canvas origin as well as its size to physical screen pixels.
    const bounds = canvas.getBoundingClientRect();
    const offsetX = (Math.ceil(bounds.left * ratio) - bounds.left * ratio) / ratio;
    const offsetY = (Math.ceil(bounds.top * ratio) - bounds.top * ratio) / ratio;
    canvas.style.transform = `translate(${offsetX}px, ${offsetY}px)`;
    workspace.style.setProperty("--device-height", `${device.getBoundingClientRect().height}px`);
  }
  const displayResizeObserver = new ResizeObserver(updateDisplaySize);
  displayResizeObserver.observe(workspace);
  displayResizeObserver.observe(device);
  window.addEventListener("resize", updateDisplaySize);
  updateDisplaySize();

  document.getElementById("screenshot").onclick = () => {
    renderer.present();
    const screenshot = document.createElement("canvas");
    screenshot.width = W * 2;
    screenshot.height = H * 2;
    const screenshotContext = screenshot.getContext("2d", { alpha: false });
    screenshotContext.imageSmoothingEnabled = false;
    screenshotContext.drawImage(canvas, 0, 0, screenshot.width, screenshot.height);
    const link = document.createElement("a");
    link.download = "bruce-screen-" + new Date().toISOString().replace(/[:.]/g, "-") + ".png";
    link.href = screenshot.toDataURL("image/png");
    document.body.appendChild(link);
    link.click();
    link.remove();
  };

  if (!window.crossOriginIsolated || typeof SharedArrayBuffer === "undefined") {
    setStatus("Setup required", "error");
    log("SharedArrayBuffer requires a cross-origin-isolated page. For hosting, use HTTPS with Cross-Origin-Opener-Policy: same-origin and Cross-Origin-Embedder-Policy: require-corp.");
    log("For local development, run python3 start-server.py, open http://localhost:8080, and reload.");
    log("Opening index.html directly or using python3 -m http.server will not work.");
    document.getElementById("loadUrl").disabled = true;
    document.getElementById("loadFile").disabled = true;
    document.getElementById("file").disabled = true;
    return;
  }

  // Keyboard slots use bit 1 for a queued press and bit 2 for a held control.
  // Slots 5-7 are reserved for audio synchronization and worker wakeups.
  // Slots 8-15 hold character codes of held Cardputer keys for getKeysPressed().
  const sab = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 16);
  inputView = new Int32Array(sab);
  const heldKeys = new Map();
  const heldPointers = new Map();
  const charSlots = new Map();

  function setStatus(text, cls) {
    statusEl.textContent = text;
    statusEl.className = "status " + (cls || "idle");
  }
  function log(msg) {
    let line = `[${new Date().toLocaleTimeString()}] ${String(msg)}`;
    if (line.length > MAX_LOG_ENTRY_CHARS) {
      line = line.slice(0, MAX_LOG_ENTRY_CHARS - 1) + "…";
    }
    logEntries.push(line);
    logChars += line.length + 1;
    while (logEntries.length > MAX_LOG_ENTRIES || logChars > MAX_LOG_CHARS) {
      logChars -= logEntries.shift().length + 1;
    }
    logEl.textContent = logEntries.join("\n");
    logEl.scrollTop = logEl.scrollHeight;
  }

  function unlockAudio() {
    if (!window.AudioContext) return null;
    if (!audioContext) {
      try {
        audioContext = new AudioContext();
      } catch (e) {
        log(`Audio unavailable: ${e.message}`);
        return null;
      }
    }
    if (audioContext.state === "suspended") {
      audioContext.resume().catch(e => {
        log(`Audio could not start: ${e.message}`);
        stopAudio();
      });
    }
    return audioContext;
  }

  function completeTone(id) {
    if (!inputView) return;
    Atomics.store(inputView, 6, id);
    Atomics.notify(inputView, 6);
  }

  function stopAudio() {
    if (!activeTone) return;
    const tone = activeTone;
    activeTone = null;
    tone.oscillator.onended = null;
    tone.oscillator.stop();
    tone.oscillator.disconnect();
    tone.gain.disconnect();
    completeTone(tone.id);
  }

  function playTone(id, frequency, duration) {
    const context = unlockAudio();
    if (!context) {
      log("Audio is not supported by this browser.");
      completeTone(id);
      return;
    }
    const hz = Number(frequency);
    const milliseconds = Number(duration);
    if (!Number.isFinite(hz) || hz <= 0 || hz > 20000 ||
        !Number.isFinite(milliseconds) || milliseconds < 0) {
      log(`Invalid audio tone: ${frequency} Hz for ${duration} ms.`);
      completeTone(id);
      return;
    }

    stopAudio();
    if (milliseconds === 0) {
      completeTone(id);
      return;
    }

    const oscillator = context.createOscillator();
    const gain = context.createGain();
    const now = context.currentTime;
    const seconds = milliseconds / 1000;
    const ramp = Math.min(0.005, seconds / 2);
    oscillator.frequency.setValueAtTime(hz, now);
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.12, now + ramp);
    gain.gain.setValueAtTime(0.12, now + seconds - ramp);
    gain.gain.linearRampToValueAtTime(0, now + seconds);
    oscillator.connect(gain);
    gain.connect(context.destination);
    activeTone = { id, oscillator, gain };
    oscillator.onended = () => {
      if (activeTone && activeTone.oscillator === oscillator) activeTone = null;
      oscillator.disconnect();
      gain.disconnect();
      completeTone(id);
    };
    oscillator.start(now);
    oscillator.stop(now + milliseconds / 1000);
  }

  function clearScreen() {
    renderer.render({op: "fill", args: [themeColors.bg]});
    renderer.present();
  }
  clearScreen();

  function render(msg) {
    try {
      renderer.render(msg);
      if (renderFrame === null) {
        renderFrame = requestAnimationFrame(() => {
          renderFrame = null;
          renderer.present();
        });
      }
    } catch (e) { log("Render error: " + e.message); }
  }

  function start(code, name) {
    stopRuntime(false);
    clearScreen();
    setStatus("Running", "running");
    log(`Loading ${name || "script"}...`);
    const runningWorker = new Worker("emulator-worker.js", {type:"classic"});
    worker = runningWorker;
    runningWorker.onmessage = e => {
      if (worker !== runningWorker) return;
      const m = e.data;
      if (m.type === "draw") render(m);
      else if (m.type === "log") log(m.text);
      else if (m.type === "spriteCreate") {
        const surface = document.createElement("canvas");
        surface.width = m.width;
        surface.height = m.height;
        const surfaceContext = surface.getContext("2d", {alpha:false});
        sprites.set(m.id, new PixelRenderer(surfaceContext, m.width, m.height));
      }
      else if (m.type === "spriteDraw") {
        const sprite = sprites.get(m.id);
        if (sprite) {
          try {
            sprite.render(m);
          } catch (e) {
            log(`Sprite render error: ${e.message}`);
          }
        }
      }
      else if (m.type === "spritePush") {
        const sprite = sprites.get(m.id);
        if (sprite) {
          try {
            renderer.blit(sprite, Math.trunc(Number(m.x)), Math.trunc(Number(m.y)), m.transparent);
            if (renderFrame === null) {
              renderFrame = requestAnimationFrame(() => {
                renderFrame = null;
                renderer.present();
              });
            }
          } catch (e) {
            log(`Sprite push error: ${e.message}`);
          }
        }
      }
      else if (m.type === "spriteDelete") sprites.delete(m.id);
      else if (m.type === "audio") {
        if (m.op === "tone") playTone(m.id, m.frequency, m.duration);
        else if (m.op === "stop") stopAudio();
      }
      else if (m.type === "prompt") {
        const response = new Int32Array(m.response);
        try {
          const value = (window.prompt(m.title, m.value) || "").slice(0,m.maxlen);
          response[1] = value.length;
          for (let i = 0; i < value.length; i++) response[i + 2] = value.charCodeAt(i);
          resetInput();
          Atomics.store(response,0,1);
        } catch (e) {
          log(`Keyboard prompt failed: ${e.message}`);
          Atomics.store(response,0,-1);
        } finally {
          Atomics.notify(response,0);
        }
      }
      else if (m.type === "done") {
        if (!pendingLoad) setStatus("Finished", "done");
        log("Script finished.");
      }
      else if (m.type === "error") {
        if (!pendingLoad) setStatus("Error", "error");
        log(m.text);
      }
    };
    runningWorker.onerror = e => {
      if (worker !== runningWorker) return;
      if (!pendingLoad) setStatus("Error", "error");
      log(`Worker error: ${e.message}`);
    };
    try {
      runningWorker.postMessage({type:"start", code, sab, name:name || "index.js", theme:themeColors});
    } catch (e) {
      stopRuntime(false);
      throw e;
    }
  }

  function stopRuntime(writeLog=true) {
    if (worker) {
      worker.terminate();
      worker = null;
      sprites.clear();
      setStatus("Stopped", "idle");
      if (writeLog) log("Script stopped.");
    }
    stopAudio();
    resetInput();
  }

  function cancelPendingLoad() {
    loadVersion++;
    const load = pendingLoad;
    pendingLoad = null;
    if (load) load.controller.abort();
    return Boolean(load);
  }

  function beginLoad() {
    cancelPendingLoad();
    const load = {version:loadVersion, controller:new AbortController()};
    pendingLoad = load;
    return load;
  }

  function isCurrentLoad(load) {
    return pendingLoad === load && load.version === loadVersion && !load.controller.signal.aborted;
  }

  function stop(writeLog=true) {
    const loading = cancelPendingLoad();
    stopRuntime(writeLog);
    if (loading) {
      setStatus("Stopped", "idle");
      if (writeLog) log("Pending load cancelled.");
    }
  }

  async function loadScript(load, readCode, name, failureMessage, hint) {
    setStatus("Loading...", "running");
    try {
      const code = await readCode(load.controller.signal);
      if (!isCurrentLoad(load)) return;
      start(code, name());
    } catch (e) {
      if (!isCurrentLoad(load)) return;
      setStatus("Error", "error");
      log(`${failureMessage}: ${e.message || e.name || String(e)}`);
      if (hint) log(hint);
    } finally {
      if (pendingLoad === load) pendingLoad = null;
    }
  }

  function readFile(file, signal) {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(new DOMException("File read cancelled", "AbortError"));
        return;
      }
      const reader = new FileReader();
      const abort = () => reader.abort();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error || new Error("Could not read the file"));
      reader.onabort = () => reject(new DOMException("File read cancelled", "AbortError"));
      reader.onloadend = () => signal.removeEventListener("abort", abort);
      signal.addEventListener("abort", abort, {once:true});
      try {
        reader.readAsText(file, "UTF-8");
      } catch (e) {
        signal.removeEventListener("abort", abort);
        reject(e);
      }
    });
  }

  async function loadUrl() {
    unlockAudio();
    const load = beginLoad();
    const custom = appSourceEl.value === "custom";
    const url = custom ? urlEl.value.trim() : appSourceEl.value;
    if (!url || (custom && !urlEl.reportValidity())) {
      pendingLoad = null;
      setStatus("Invalid URL", "error");
      log("Enter a valid JavaScript URL before loading.");
      urlEl.focus();
      return;
    }
    log(`Fetching ${url}`);
    await loadScript(
      load,
      async signal=>{
        const r = await fetch(url, {cache:"no-store", signal});
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.text();
      },
      ()=>decodeURIComponent(new URL(url).pathname.split("/").pop() || "remote.js"),
      "URL load failed",
      "If the remote host blocks browser CORS, download the .js file and use Load .js."
    );
  }

  function press(index) {
    Atomics.or(inputView, index, 1);
    Atomics.notify(inputView, 7, 1);
  }

  function holdChar(source, char) {
    if (!char || charSlots.has(source)) return;
    for (let slot = 8; slot < 16; slot++) {
      if ([...charSlots.values()].includes(slot) || Atomics.load(inputView, slot) !== 0) continue;
      charSlots.set(source, slot);
      Atomics.store(inputView, slot, char.charCodeAt(0) | 0x10000);
      return;
    }
  }

  function releaseChar(source) {
    const slot = charSlots.get(source);
    if (slot === undefined) return;
    charSlots.delete(source);
    const value = Atomics.load(inputView, slot);
    // Keep quick taps visible until the app has read them once.
    //noinspection JSBitwiseOperatorUsage
    if (value & 0x10000) {
      if (Atomics.compareExchange(inputView, slot, value, value | 0x20000) === value) return;
    }
    Atomics.store(inputView, slot, 0);
  }

  function updateHeld(index) {
    if ([...heldKeys.values()].includes(index) || [...heldPointers.values()].includes(index)) {
      Atomics.or(inputView, index, 2);
    } else {
      Atomics.and(inputView, index, ~2);
    }
  }

  function resetInput() {
    heldKeys.clear();
    heldPointers.clear();
    charSlots.clear();
    for (let index = 0; index < 4; index++) Atomics.store(inputView, index, 0);
    for (let slot = 8; slot < 16; slot++) Atomics.store(inputView, slot, 0);
  }

  document.getElementById("loadUrl").onclick = loadUrl;
  document.getElementById("loadFile").onclick = () => {
    unlockAudio();
    document.getElementById("file").click();
  };
  document.getElementById("stop").onclick = () => stop();
  document.getElementById("clearLog").onclick = () => {
    logEntries.length = 0;
    logChars = 0;
    logEl.textContent = "";
  };

  document.getElementById("file").onchange = async e => {
    const file = e.target.files[0];
    if (!file) return;
    e.target.value = "";
    const load = beginLoad();
    log(`Reading ${file.name}`);
    await loadScript(load, signal=>readFile(file, signal), ()=>file.name, "File load failed");
  };

  // Cardputer has no separate nav buttons: Prev/Next are the "," and "/" keys.
  const buttonChars = [",", "", "/", ""];
  ["encLeft", "enc", "encRight", "esc"].forEach((id, index) => {
    const button = document.getElementById(id);
    button.addEventListener("pointerdown", e => {
      if (e.button !== 0) return;
      button.setPointerCapture(e.pointerId);
      heldPointers.set(e.pointerId, index);
      updateHeld(index);
      holdChar("pointer:" + e.pointerId, buttonChars[index]);
      press(index);
    });
    const release = e => {
      heldPointers.delete(e.pointerId);
      updateHeld(index);
      releaseChar("pointer:" + e.pointerId);
    };
    button.addEventListener("pointerup", release);
    button.addEventListener("pointercancel", release);
    button.addEventListener("lostpointercapture", release);
    button.onclick = e => {
      if (e.detail !== 0) return;
      holdChar("click:" + id, buttonChars[index]);
      releaseChar("click:" + id);
      press(index);
    };
  });

  // Mirrors Bruce's Cardputer mapping: ",;" = Prev, "/." = Next, Enter = Sel, "`"/Backspace = Esc.
  const keyIndexes = new Map([
    ["ArrowLeft", 0], ["ArrowUp", 0], [",", 0], [";", 0],
    ["Enter", 1],
    ["ArrowRight", 2], ["ArrowDown", 2], ["/", 2], [".", 2],
    ["Escape", 3], ["Backspace", 3], ["`", 3]
  ]);
  const arrowChars = new Map([["ArrowUp", ";"], ["ArrowDown", "."], ["ArrowLeft", ","], ["ArrowRight", "/"]]);
  const keyChar = e => arrowChars.get(e.key) || (e.key.length === 1 ? e.key : "");
  window.addEventListener("keydown", e => {
    if (e.target instanceof Element &&
        (e.target.closest("input, select, textarea, .toolbar, .panel-actions") || e.target.isContentEditable)) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const index = keyIndexes.get(e.key);
    const char = keyChar(e);
    if (index === undefined && !char) return;
    e.preventDefault();
    if (e.repeat || heldKeys.has(e.code)) return;
    heldKeys.set(e.code, index);
    holdChar("key:" + e.code, char);
    if (index === undefined) return;
    updateHeld(index);
    press(index);
  });
  window.addEventListener("keyup", e => {
    if (!heldKeys.has(e.code)) return;
    const index = heldKeys.get(e.code);
    heldKeys.delete(e.code);
    releaseChar("key:" + e.code);
    if (index !== undefined) updateHeld(index);
  });
  window.addEventListener("blur", resetInput);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) resetInput();
  });

  log("Ready. Load a Bruce .js app.");
  log("Choose an app or Custom URL, then click Load app.");
})();
