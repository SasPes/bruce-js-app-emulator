(() => {
  "use strict";

  let W = 320, H = 170;
  const canvas = document.getElementById("screen");
  const ctx = canvas.getContext("2d", { alpha: false });
  let renderer = new PixelRenderer(ctx, W, H);
  let renderFrame = null;
  const logEl = document.getElementById("log");
  const consolePanel = logEl.parentElement;
  const consoleToggle = document.getElementById("toggleConsole");
  consoleToggle.onclick = () => {
    const collapsed = consolePanel.classList.toggle("console-collapsed");
    consoleToggle.setAttribute("aria-expanded", String(!collapsed));
    consoleToggle.textContent = (collapsed ? "▶" : "▼") + " Runtime console";
    if (!collapsed) logEl.scrollTop = logEl.scrollHeight;
  };
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
  // Set once the user picks from the dropdown; the saved-script restore then leaves it alone.
  let sourceTouched = false;
  // Replaced when the script editor section runs; re-selects the last script's dropdown entry.
  let reapplySource = () => {};
  appSourceEl.addEventListener("change", () => {
    sourceTouched = true;
    updateAppSource();
    if (appSourceEl.value === "script") showScriptEditor();
    if (!urlEl.hidden) urlEl.focus();
  });
  updateAppSource();

  // Build optgroups per category from the Bruce App Store index (runnable .js apps only).
  const STORE_INDEX = "https://raw.githubusercontent.com/BruceDevices/App-Store-Data/refs/heads/main/releases/category-all.json";
  async function loadStoreApps() {
    const end = document.getElementById("storeEnd");
    try {
      const response = await fetch(STORE_INDEX);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      const categories = [...data.categories].sort((a, b) => a.name.localeCompare(b.name));
      for (const category of categories) {
        const group = document.createElement("optgroup");
        group.label = "  " + category.name;
        const apps = [...category.apps].sort((a, b) => a.name.localeCompare(b.name));
        for (const app of apps) {
          const first = app.files && app.files[0];
          const source = first && (typeof first === "string" ? first : first.source);
          if (!source || !source.toLowerCase().endsWith(".js")) continue;
          const path = (app.path || "/").replace(/^\/|\/$/g, "");
          const parts = [app.owner, app.repo, app.commit, ...(path ? path.split("/") : []), source];
          const option = document.createElement("option");
          option.value = encodeURI("https://raw.githubusercontent.com/" + parts.join("/"));
          option.textContent = app.name;
          group.appendChild(option);
        }
        if (group.children.length) end.before(group);
      }
    } catch (e) {
      log(`Could not load Bruce App Store list: ${e.message}`);
    }
    // The restored script may be one of the store apps that only just got added.
    if (!sourceTouched) reapplySource();
  }
  loadStoreApps();
  // Simulated networks; the selected index goes to the worker through input slot 4 (0 = none).
  const WIFI_NETWORKS = [
    {SSID:"Emulator-WiFi", encryptionType:"WPA2_PSK", RSSI:-45, BSSID:"02:00:00:00:00:01", channel:6},
    {SSID:"Guest-Network", encryptionType:"OPEN", RSSI:-60, BSSID:"02:00:00:00:00:02", channel:1},
    {SSID:"Office-5G", encryptionType:"WPA2_PSK", RSSI:-72, BSSID:"02:00:00:00:00:03", channel:11},
    {SSID:"Neighbour", encryptionType:"WPA3_PSK", RSSI:-85, BSSID:"02:00:00:00:00:04", channel:3}
  ];
  const wifiNetworkEl = document.getElementById("wifiNetwork");
  wifiNetworkEl.add(new Option("Wi-Fi: none", "0"));
  WIFI_NETWORKS.forEach((network, index) => {
    wifiNetworkEl.add(new Option(`Wi-Fi: ${network.SSID}`, String(index + 1)));
  });
  wifiNetworkEl.value = "1";
  function syncWifiNetwork() {
    if (inputView) Atomics.store(inputView, 4, Number(wifiNetworkEl.value));
  }
  wifiNetworkEl.addEventListener("change", () => {
    syncWifiNetwork();
    const network = WIFI_NETWORKS[Number(wifiNetworkEl.value) - 1];
    log(network ? `Wi-Fi connected to ${network.SSID}` : "Wi-Fi disconnected");
  });
  // HTTP mode goes to the worker through input slot 16 (0 = direct, 1 = server /proxy).
  const httpModeEl = document.getElementById("httpMode");
  // config.js sets serverProxy to false on static hosts, where there is no /proxy endpoint.
  if (window.EMULATOR_CONFIG && window.EMULATOR_CONFIG.serverProxy === false) {
    httpModeEl.querySelector('option[value="1"]').remove();
  }
  function syncHttpMode() {
    if (inputView) Atomics.store(inputView, 16, Number(httpModeEl.value));
  }
  httpModeEl.addEventListener("change", () => {
    syncHttpMode();
    log({
      "0": "HTTP requests are sent directly (CORS applies)",
      "1": "HTTP requests use the server proxy",
      "2": "HTTP requests use the Corsfix public CORS proxy"
    }[httpModeEl.value]);
  });
  let worker = null;
  let inputView = null;
  let loadVersion = 0;
  let pendingLoad = null;
  let audioContext = null;
  let activeTone = null;
  const sprites = new Map();

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
    // Side by side the header spans the full width; stacked it matches the device.
    workspace.parentElement.style.setProperty("--header-width", columns === 2 ? "100%" : `${deviceWidth}px`);
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

  const resolutionEl = document.getElementById("resolution");
  const customBoxEl = document.getElementById("customResolution");
  const customWEl = document.getElementById("customW");
  const customHEl = document.getElementById("customH");
  const screenshotBtn = document.getElementById("screenshot");
  const RESOLUTION_KEY = "bruce-emulator-resolution";
  // Device dropdown, built from devices.js ahead of the "Custom" entry.
  const customOption = resolutionEl.querySelector('option[value="custom"]');
  for (const device of window.DEVICES) {
    const [dw, dh] = device.screen;
    const option = new Option(`${device.name} (${dw} × ${dh})`, device.name);
    option.dataset.size = `${dw}x${dh}`;
    resolutionEl.insertBefore(option, customOption);
  }
  resolutionEl.value = window.DEFAULT_DEVICE;
  // Hardware details (chip, battery, flash, PSRAM) come from the selected device; Custom keeps the last one.
  let currentDevice = window.DEVICES.find(d => d.name === window.DEFAULT_DEVICE);
  const sideLabelEl = document.querySelector(".side-label");
  let boardName = "";
  // Names the device on the device body.
  function applyDeviceName() {
    const custom = resolutionEl.value === "custom";
    boardName = custom ? "Custom" : resolutionEl.value;
    currentDevice = window.DEVICES.find(d => d.name === resolutionEl.value) || currentDevice;
    const [vendor, ...rest] = boardName.split(" ");
    sideLabelEl.textContent = "";
    sideLabelEl.append(rest.length ? vendor.toUpperCase() : boardName);
    if (rest.length) sideLabelEl.append(document.createElement("br"), rest.join(" "));
  }
  function applyResolution() {
    let w, h;
    if (resolutionEl.value === "custom") {
      w = Math.trunc(Number(customWEl.value));
      h = Math.trunc(Number(customHEl.value));
      if (!(w >= 1 && w <= 1024 && h >= 1 && h <= 1024)) return;
    } else {
      [w, h] = resolutionEl.selectedOptions[0].dataset.size.split("x").map(Number);
    }
    try {
      localStorage.setItem(RESOLUTION_KEY, JSON.stringify({device: resolutionEl.value, w, h}));
    } catch (e) {}
    applyDeviceName();
    if (w === W && h === H) return;
    // Running worker holds the old size; stop it before resizing.
    if (worker) stopRuntime(false);
    W = w; H = h;
    canvas.width = W;
    canvas.height = H;
    renderer = new PixelRenderer(ctx, W, H);
    screenshotBtn.title = `Save screenshot (${W * 2} x ${H * 2})`;
    clearScreen();
    updateDisplaySize();
    log(`Resolution set to ${W} x ${H}.`);
  }
  resolutionEl.addEventListener("change", () => {
    const custom = resolutionEl.value === "custom";
    if (custom) {
      // Custom starts from the current resolution.
      customWEl.value = W;
      customHEl.value = H;
    }
    customBoxEl.hidden = !custom;
    applyDeviceName();
    applyResolution();
  });
  customWEl.addEventListener("change", applyResolution);
  customHEl.addEventListener("change", applyResolution);
  // Restore the last chosen device or custom size.
  try {
    const saved = JSON.parse(localStorage.getItem(RESOLUTION_KEY) || "null");
    if (saved && [...resolutionEl.options].some(o => o.value === saved.device)) {
      resolutionEl.value = saved.device;
      if (saved.device === "custom") {
        customWEl.value = saved.w;
        customHEl.value = saved.h;
        customBoxEl.hidden = false;
      }
      applyResolution();
    }
  } catch (e) {}
  applyDeviceName();

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
  const sab = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 17);
  inputView = new Int32Array(sab);
  syncWifiNetwork();
  syncHttpMode();
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
    renderer.render({op: "clear"});
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

  // Virtual storage: keys are "sd:/path" or "littlefs:/path" with text contents. The page owns
  // the files (kept in localStorage); a worker gets a copy when it starts and reports changes.
  const STORAGE_KEY = "bruce-emulator-storage";
  // Files hold text, or for binary data (images, ...) one character per byte. Binary files are
  // kept in binaryKeys and saved to localStorage as base64, which is compact and survives JSON.
  const storageFiles = Object.create(null);
  const binaryKeys = new Set();
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    for (const [key, value] of Object.entries(saved)) {
      if (value !== null && typeof value === "object" && typeof value.b64 === "string") {
        storageFiles[key] = atob(value.b64);
        binaryKeys.add(key);
      } else {
        storageFiles[key] = String(value);
      }
    }
  } catch (e) {}
  // Raw file bytes to what the emulated storage holds: text if valid UTF-8, else a byte string.
  function bytesToStorage(bytes) {
    try {
      return {text: new TextDecoder("utf-8", {fatal: true}).decode(bytes), binary: false};
    } catch (e) {
      return {text: Array.from(bytes, byte => String.fromCharCode(byte)).join(""), binary: true};
    }
  }
  function storageToBytes(key) {
    const text = storageFiles[key];
    return binaryKeys.has(key) ? Uint8Array.from(text, character => character.charCodeAt(0) & 0xff)
      : new TextEncoder().encode(text);
  }
  function forgetStorageFile(key) {
    delete storageFiles[key];
    binaryKeys.delete(key);
  }
  const storageTreeEl = document.getElementById("storageTree");
  const storageEmptyEl = document.getElementById("storageEmpty");
  const storageSummaryEl = document.getElementById("storageSummary");
  const storageEditorEl = document.getElementById("storageEditor");
  const storageEditorPathEl = document.getElementById("storageEditorPath");
  const storageEditorTextEl = document.getElementById("storageEditorText");
  const storageFsEl = document.getElementById("storageFs");
  const storageUploadInputEl = document.getElementById("storageUploadInput");
  let storageEditingKey = null;
  let storageRenderFrame = null;
  let storageSaveWarned = false;

  function saveStorage() {
    try {
      const saved = {};
      for (const [key, value] of Object.entries(storageFiles)) {
        saved[key] = binaryKeys.has(key) ? {b64: btoa(value)} : value;
      }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
    } catch (e) {
      if (!storageSaveWarned) {
        storageSaveWarned = true;
        log("Storage is not being kept between visits (browser storage is full or blocked).");
      }
    }
  }
  function scheduleStorageRender() {
    if (storageRenderFrame !== null) return;
    storageRenderFrame = requestAnimationFrame(() => {
      storageRenderFrame = null;
      renderStorage();
    });
  }
  let storageSaveTimer = null;
  function storageChanged() {
    // Apps may write in tight loops; batch the persistence and rendering.
    if (storageSaveTimer === null) {
      storageSaveTimer = setTimeout(() => {
        storageSaveTimer = null;
        saveStorage();
      }, 300);
    }
    scheduleStorageRender();
  }
  window.addEventListener("pagehide", () => {
    if (storageSaveTimer !== null) {
      clearTimeout(storageSaveTimer);
      storageSaveTimer = null;
      saveStorage();
    }
  });
  function storageBytes(text) {
    return new TextEncoder().encode(text).length;
  }
  function formatBytes(bytes) {
    return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
  }
  function describeStorageKey(key) {
    const split = key.indexOf(":");
    return {label: key.slice(0, split) === "sd" ? "SD" : "LittleFS", path: key.slice(split + 1)};
  }
  function storageButton(text, onClick, extraClass) {
    const button = document.createElement("button");
    button.textContent = text;
    button.className = "text-button" + (extraClass ? " " + extraClass : "");
    button.onclick = onClick;
    return button;
  }
  // Directories the user collapsed, as "fs:/dir" keys; everything else starts expanded.
  const collapsedDirs = new Set();
  function buildStorageTree() {
    const roots = new Map([["sd", {children: new Map()}], ["littlefs", {children: new Map()}]]);
    for (const key of Object.keys(storageFiles)) {
      const split = key.indexOf(":");
      const fs = key.slice(0, split);
      if (!roots.has(fs)) roots.set(fs, {children: new Map()});
      let node = roots.get(fs);
      const parts = key.slice(split + 1).split("/").filter(Boolean);
      parts.forEach((part, index) => {
        if (!node.children.has(part)) node.children.set(part, {children: new Map()});
        node = node.children.get(part);
        if (index === parts.length - 1) node.fileKey = key;
      });
    }
    return roots;
  }
  function countFiles(node) {
    let count = node.fileKey ? 1 : 0;
    for (const child of node.children.values()) count += countFiles(child);
    return count;
  }
  function treeRow(node, name, dirKey, isFile) {
    const item = document.createElement("li");
    const row = document.createElement("div");
    row.className = "tree-row";
    const size = document.createElement("span");
    size.className = "tree-size";
    if (isFile) {
      const label = document.createElement("span");
      label.className = "tree-name";
      label.textContent = (binaryKeys.has(node.fileKey) ? "🖼️ " : "📄 ") + name;
      size.textContent = formatBytes(storageToBytes(node.fileKey).length);
      row.append(
        label, size,
        ...(binaryKeys.has(node.fileKey) ? [] : [storageButton("Edit", () => openStorageEditor(node.fileKey))]),
        storageButton("Download", () => downloadStorageFile(node.fileKey)),
        storageButton("Delete", () => deleteStorageFile(node.fileKey), "danger")
      );
    } else {
      const collapsed = collapsedDirs.has(dirKey);
      const toggle = document.createElement("button");
      toggle.className = "tree-toggle";
      toggle.setAttribute("aria-expanded", String(!collapsed));
      toggle.textContent = `${collapsed ? "▶" : "▼"} 📁 ${name}`;
      toggle.onclick = () => {
        if (!collapsedDirs.delete(dirKey)) collapsedDirs.add(dirKey);
        renderStorage();
      };
      const files = countFiles(node);
      size.textContent = `${files} file${files === 1 ? "" : "s"}`;
      row.append(toggle, size);
    }
    item.append(row);
    return item;
  }
  function renderTreeChildren(node, dirPrefix) {
    const list = document.createElement("ul");
    // Folders first, then files, each alphabetical.
    const entries = [...node.children.entries()].sort(([nameA, a], [nameB, b]) => {
      const dirA = a.children.size > 0, dirB = b.children.size > 0;
      return dirA === dirB ? nameA.localeCompare(nameB) : dirA ? -1 : 1;
    });
    for (const [name, child] of entries) {
      const isFile = child.children.size === 0 && child.fileKey !== undefined;
      const dirKey = `${dirPrefix}/${name}`;
      const item = treeRow(child, name, dirKey, isFile);
      if (!isFile && !collapsedDirs.has(dirKey)) item.append(renderTreeChildren(child, dirKey));
      list.append(item);
    }
    return list;
  }
  function renderStorage() {
    const fileCount = Object.keys(storageFiles).length;
    storageTreeEl.textContent = "";
    const names = {sd: "SD card", littlefs: "LittleFS"};
    for (const [fs, root] of buildStorageTree()) {
      const dirKey = `${fs}:`;
      const item = treeRow(root, names[fs] || fs, dirKey, false);
      if (!collapsedDirs.has(dirKey)) item.append(renderTreeChildren(root, dirKey));
      storageTreeEl.append(item);
    }
    storageEmptyEl.hidden = fileCount > 0;
    storageSummaryEl.textContent = fileCount ? `(${fileCount})` : "";
  }
  function warnIfRunning() {
    if (worker) log("Storage changed in the browser; the running app sees it the next time it loads.");
  }
  function normalizeStoragePath(path) {
    return "/" + path.trim().replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/{2,}/g, "/");
  }
  function openStorageEditor(key, text) {
    storageEditingKey = key;
    storageEditorPathEl.value = key === null ? "" : describeStorageKey(key).path;
    storageEditorPathEl.disabled = false;
    storageEditorTextEl.value = key === null ? (text || "") : storageFiles[key];
    storageEditorEl.hidden = false;
    storageEditorPathEl.focus();
  }
  function closeStorageEditor() {
    storageEditingKey = null;
    storageEditorEl.hidden = true;
  }
  function saveStorageEditor() {
    const path = normalizeStoragePath(storageEditorPathEl.value);
    if (path === "/") {
      storageEditorPathEl.focus();
      return;
    }
    const fs = storageEditingKey === null ? storageFsEl.value : storageEditingKey.slice(0, storageEditingKey.indexOf(":"));
    const key = `${fs}:${path}`;
    if (storageEditingKey !== null && storageEditingKey !== key) forgetStorageFile(storageEditingKey);
    storageFiles[key] = storageEditorTextEl.value;
    binaryKeys.delete(key);
    closeStorageEditor();
    storageChanged();
    warnIfRunning();
  }
  function deleteStorageFile(key) {
    forgetStorageFile(key);
    if (storageEditingKey === key) closeStorageEditor();
    storageChanged();
    warnIfRunning();
  }
  function downloadStorageFile(key) {
    const url = URL.createObjectURL(new Blob([storageToBytes(key)], {type: binaryKeys.has(key) ? "application/octet-stream" : "text/plain"}));
    const link = document.createElement("a");
    link.href = url;
    link.download = describeStorageKey(key).path.split("/").pop() || "file.txt";
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }
  document.getElementById("storageNew").onclick = () => openStorageEditor(null);
  document.getElementById("storageEditorSave").onclick = saveStorageEditor;
  document.getElementById("storageEditorCancel").onclick = closeStorageEditor;
  document.getElementById("storageClear").onclick = () => {
    if (!Object.keys(storageFiles).length) return;
    if (!window.confirm("Delete all files in the emulated storage?")) return;
    for (const key of Object.keys(storageFiles)) forgetStorageFile(key);
    closeStorageEditor();
    storageChanged();
    warnIfRunning();
  };
  document.getElementById("storageUpload").onclick = () => storageUploadInputEl.click();
  storageUploadInputEl.addEventListener("change", async () => {
    for (const file of storageUploadInputEl.files) {
      try {
        const key = `${storageFsEl.value}:${normalizeStoragePath(file.name)}`;
        const {text, binary} = bytesToStorage(new Uint8Array(await file.arrayBuffer()));
        storageFiles[key] = text;
        if (binary) binaryKeys.add(key);
        else binaryKeys.delete(key);
      } catch (e) {
        log(`Could not read ${file.name}: ${e.message}`);
      }
    }
    storageUploadInputEl.value = "";
    storageChanged();
    warnIfRunning();
  });
  renderStorage();

  // Script editor: always shows the script that was last started; Run restarts with the edited text.
  const scriptEditorEl = document.getElementById("scriptEditor");
  let activeScriptName = "";
  // The last started script is kept in localStorage and put back in the editor after a refresh
  // (it is not run automatically).
  const LAST_SCRIPT_KEY = "bruce-emulator-last-script";
  // Where the script came from: {kind:"url", url} or {kind:"file", name}, so the dropdown can match.
  let activeSource = null;
  function applySource(source) {
    if (!source) return;
    if (source.kind === "file") {
      const value = "file:" + source.name;
      let option = [...appSourceEl.options].find(o => o.value === value);
      if (!option) {
        option = new Option("File: " + source.name, value);
        appSourceEl.add(option, 0);
      }
      appSourceEl.value = value;
    } else if (source.kind === "script") {
      appSourceEl.value = "script";
    } else if (source.kind === "url") {
      const option = [...appSourceEl.options].find(o => o.value === source.url && !o.disabled);
      if (option) {
        appSourceEl.value = source.url;
      } else {
        appSourceEl.value = "custom";
        urlEl.value = source.url;
      }
    }
    updateAppSource();
  }
  try {
    const last = JSON.parse(localStorage.getItem(LAST_SCRIPT_KEY) || "null");
    if (last && typeof last.code === "string") {
      scriptEditorEl.value = last.code;
      activeScriptName = String(last.name || "index.js");
      activeSource = last.source || null;
      applySource(activeSource);
      reapplySource = () => applySource(activeSource);
    }
  } catch (e) {}
  function runEditor() {
    if (!scriptEditorEl.value.trim()) return;
    start(scriptEditorEl.value, activeScriptName || "editor.js", activeSource);
  }
  document.getElementById("editorRun").onclick = runEditor;
  document.getElementById("editorSave").onclick = () => {
    const url = URL.createObjectURL(new Blob([scriptEditorEl.value], {type: "text/javascript"}));
    const link = document.createElement("a");
    link.href = url;
    link.download = /\.js$/i.test(activeScriptName) ? activeScriptName : (activeScriptName || "script") + ".js";
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };
  function showScriptEditor() {
    document.getElementById("editorPanel").open = true;
    scriptEditorEl.focus();
  }
  // Typing or pasting code makes it the "Custom Script", which the play button then runs.
  let editorSaveTimer = null;
  scriptEditorEl.addEventListener("input", () => {
    activeSource = {kind: "script"};
    activeScriptName = "custom.js";
    applySource(activeSource);
    clearTimeout(editorSaveTimer);
    editorSaveTimer = setTimeout(() => {
      try {
        localStorage.setItem(LAST_SCRIPT_KEY, JSON.stringify({name: activeScriptName, code: scriptEditorEl.value, source: activeSource}));
      } catch (e) {}
    }, 300);
  });
  scriptEditorEl.addEventListener("keydown", event => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      runEditor();
    } else if (event.key === "Tab" && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey) {
      // Insert two spaces instead of leaving the field; Esc then Tab still moves focus on.
      event.preventDefault();
      scriptEditorEl.setRangeText("  ", scriptEditorEl.selectionStart, scriptEditorEl.selectionEnd, "end");
    }
  });

  function start(code, name, source) {
    activeScriptName = name || "index.js";
    if (source) {
      activeSource = source;
      applySource(source);
    }
    if (scriptEditorEl.value !== code) scriptEditorEl.value = code;
    try {
      localStorage.setItem(LAST_SCRIPT_KEY, JSON.stringify({name: activeScriptName, code, source: activeSource}));
    } catch (e) {}
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
      else if (m.type === "storageWrite") {
        storageFiles[m.key] = m.value;
        if (m.binary) binaryKeys.add(m.key);
        else binaryKeys.delete(m.key);
        storageChanged();
      }
      else if (m.type === "storageRemove") {
        forgetStorageFile(m.key);
        storageChanged();
      }
      else if (m.type === "wifiSelect") {
        wifiNetworkEl.value = String(m.index);
        const network = WIFI_NETWORKS[m.index - 1];
        log(network ? `Wi-Fi connected to ${network.SSID}` : "Wi-Fi disconnected");
      }
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
      runningWorker.postMessage({type:"start", code, sab, name:name || "index.js", width:W, height:H, board:boardName, hardware:currentDevice, wifiNetworks:WIFI_NETWORKS, storage:{...storageFiles}, storageBinary:[...binaryKeys]});
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

  async function loadScript(load, readCode, name, failureMessage, hint, source) {
    setStatus("Loading...", "running");
    try {
      const code = await readCode(load.controller.signal);
      if (!isCurrentLoad(load)) return;
      start(code, name(), source);
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
    if (appSourceEl.value === "script") {
      if (scriptEditorEl.value.trim()) {
        if (!activeSource || activeSource.kind !== "script") {
          activeSource = {kind: "script"};
          activeScriptName = "custom.js";
        }
        runEditor();
      } else {
        log("Custom Script: paste or type code in the script editor first.");
        showScriptEditor();
      }
      return;
    }
    if (appSourceEl.value.startsWith("file:")) {
      // A previously loaded local file: its code lives in the editor, there is no URL to fetch.
      if (scriptEditorEl.value.trim()) runEditor();
      else log("Use Load .js to pick the file again.");
      return;
    }
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
      "If the remote host blocks browser CORS, download the .js file and use Load .js.",
      {kind: "url", url}
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
    await loadScript(load, signal=>readFile(file, signal), ()=>file.name, "File load failed", undefined, {kind: "file", name: file.name});
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
