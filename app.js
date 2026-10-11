(() => {
  "use strict";

  const W = 320, H = 170;
  const canvas = document.getElementById("screen");
  const ctx = canvas.getContext("2d", { alpha: false });
  const renderer = new PixelRenderer(ctx, W, H);
  let renderFrame = null;
  const logEl = document.getElementById("log");
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
  let currentBlobUrl = null;
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
    const scale = Math.max(1, Math.floor(available * ratio / W));
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
    const line = `[${new Date().toLocaleTimeString()}] ${String(msg)}`;
    logEl.textContent += (logEl.textContent ? "\n" : "") + line;
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

  const workerSource = `
    "use strict";
    let input = null;
    var __dirpath = "/scripts";
    var __filepath = "/scripts/index.js";
    var module = {exports:{}};
    var exports = module.exports;
    let textColor = 0xffff;
    let textSize = 1;
    let cursorX = 0, cursorY = 0;
    let alignX = "left", alignY = "top";
    let longPress = false;

    function emit(op, args) {
      postMessage({type:"draw", op:op, args:args || [], textColor:textColor, textSize:textSize, alignX:alignX, alignY:alignY});
    }
    function color(r,g,b) {
      return ((Math.round(r)&248)<<8) | ((Math.round(g)&252)<<3) | (Math.round(b)>>3);
    }
    function delay(ms) {
      Atomics.wait(input, 7, 0, Math.max(0, Number(ms)||0));
    }
    function print() {
      postMessage({type:"log", text:Array.prototype.slice.call(arguments).join(" ")});
    }
    function println() { print.apply(null, arguments); }
    let gcNoticeShown = false;
    function gc() {
      if (!gcNoticeShown) {
        print("gc(): browser garbage collection is automatic; forced collection is unavailable");
        gcNoticeShown = true;
      }
    }
    if (typeof console === "undefined") {
      var console = { log: print, error: print, warn: print };
    }
    function now() { return Date.now(); }
    function to_string(value) {
      return arguments.length ? String(value) : "";
    }
    function parse_int(value) {
      return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
        ? Number(value) : NaN;
    }
    function random(min, max) {
      if (typeof min !== "number") return Math.floor(Math.random() * 0x80000000);
      min = min | 0;
      if (typeof max !== "number") {
        return min === 0 ? 0 : Math.floor(Math.random() * Math.abs(min));
      }
      max = max | 0;
      return min >= max ? min : min + Math.floor(Math.random() * (max - min));
    }

    // Bruce global constants for the current configured theme.
    var BRUCE_BGCOLOR = 0x0000;
    var BRUCE_PRICOLOR = color(255, 0, 255);
    var BRUCE_SECCOLOR = color(231, 190, 231);
    var BRUCE_VERSION = "web-emulator-0.1";

    function consume(index, hold) {
      const state = Atomics.and(input,index,~1);
      return hold || longPress ? state !== 0 : (state & 1) !== 0;
    }

    const display = {
      width:()=>320, height:()=>170,
      getRotation:()=>1,
      getBrightness:()=>100,
      color:color,
      fill:c=>emit("fill",[c]),
      setCursor:(x,y)=>{cursorX=x;cursorY=y;},
      print:function(){ emit("text",[Array.prototype.slice.call(arguments).join(" "),cursorX,cursorY]); },
      println:function(){ emit("text",[Array.prototype.slice.call(arguments).join(" "),cursorX,cursorY]); cursorY += 8*textSize; },
      setTextColor:c=>{textColor=c;},
      setTextAlign:(a,b)=>{
        alignX = (a===1 || a==="center") ? "center" : (a===2 || a==="right") ? "right" : "left";
        alignY = (b===2 || b==="middle") ? "middle" : (b===3 || b==="bottom") ? "bottom" : "top";
      },
      setTextSize:s=>{textSize=Math.max(1, Math.trunc(Number(s)||1));},
      drawText:(t,x,y)=>emit("text",[t,x,y]),
      drawString:(t,x,y)=>emit("text",[t,x,y]),
      drawPixel:(x,y,c)=>emit("pixel",[x,y,c]),
      drawLine:(x,y,x2,y2,c)=>emit("line",[x,y,x2,y2,c]),
      drawRect:(x,y,w,h,c)=>emit("rect",[x,y,w,h,c]),
      drawFillRect:(x,y,w,h,c)=>emit("fillRect",[x,y,w,h,c]),
      drawFillRectGradient:(x,y,w,h,c1,c2,direction)=>{
        // Gradient fallback retains the first color.
        emit("fillRect",[x,y,w,h,c1]);
      },
      drawRoundRect:(x,y,w,h,r,c)=>emit("roundRect",[x,y,w,h,r,c]),
      drawFillRoundRect:(x,y,w,h,r,c)=>emit("fillRoundRect",[x,y,w,h,r,c]),
      drawCircle:(x,y,r,c)=>emit("circle",[x,y,r,c]),
      drawFillCircle:(x,y,r,c)=>emit("fillCircle",[x,y,r,c]),
      drawXBitmap:(x,y,b,w,h,c,bg)=>emit("xbitmap",[x,y,Array.from(b),w,h,c,bg]),
      drawBitmap:(x,y,b,w,h,c,bg)=>emit("xbitmap",[x,y,Array.from(b),w,h,c,bg])
    };

    function setTextSize(size) { display.setTextSize(size); }
    function setTextColor(color) { display.setTextColor(color); }

    let nextSpriteId = 0;
    let nextSpriteFrame = 0;
    function pushSprite(id, x, y, transparent) {
      // Hardware display transfers naturally pace games with no explicit delay.
      let remaining = nextSpriteFrame - performance.now();
      while (remaining > 0) {
        Atomics.wait(input, 7, 0, remaining);
        remaining = nextSpriteFrame - performance.now();
      }
      nextSpriteFrame = performance.now() + 1000 / 30;
      postMessage({
        type:"spritePush", id:id, x:x === undefined ? 0 : x,
        y:y === undefined ? 0 : y, transparent:transparent
      });
    }
    function createSprite(width, height) {
      width = width === undefined ? display.width() : Math.trunc(Number(width));
      height = height === undefined ? display.height() : Math.trunc(Number(height));
      if (!Number.isInteger(width) || !Number.isInteger(height) ||
          width <= 0 || height <= 0 || width * height > 4194304) {
        throw new RangeError("Sprite dimensions must be positive and no larger than 4 megapixels");
      }
      const id = ++nextSpriteId;
      postMessage({type:"spriteCreate", id:id, width:width, height:height});
      let spriteTextColor = textColor;
      let spriteTextSize = textSize;
      let spriteAlignX = "left", spriteAlignY = "top";
      let spriteCursorX = 0, spriteCursorY = 0;
      function spriteEmit(op, args) {
        postMessage({
          type:"spriteDraw", id:id, op:op, args:args || [],
          textColor:spriteTextColor, textSize:spriteTextSize,
          alignX:spriteAlignX, alignY:spriteAlignY
        });
      }
      return {
        width:()=>width, height:()=>height,
        color:color,
        fill:c=>spriteEmit("fill",[c]),
        fillScreen:c=>spriteEmit("fill",[c]),
        fillSprite:c=>spriteEmit("fill",[c]),
        setCursor:(x,y)=>{spriteCursorX=x;spriteCursorY=y;},
        print:function(){spriteEmit("text",[Array.prototype.slice.call(arguments).join(" "),spriteCursorX,spriteCursorY]);},
        println:function(){
          spriteEmit("text",[Array.prototype.slice.call(arguments).join(" "),spriteCursorX,spriteCursorY]);
          spriteCursorY += 8 * spriteTextSize;
        },
        setTextColor:c=>{spriteTextColor=c;},
        setTextAlign:(a,b)=>{
          spriteAlignX = (a===1 || a==="center") ? "center" : (a===2 || a==="right") ? "right" : "left";
          spriteAlignY = (b===2 || b==="middle") ? "middle" : (b===3 || b==="bottom") ? "bottom" : "top";
        },
        setTextSize:s=>{spriteTextSize=Math.max(1,Math.trunc(Number(s)||1));},
        drawText:(t,x,y)=>spriteEmit("text",[t,x,y]),
        drawString:(t,x,y)=>spriteEmit("text",[t,x,y]),
        drawPixel:(x,y,c)=>spriteEmit("pixel",[x,y,c]),
        drawLine:(x,y,x2,y2,c)=>spriteEmit("line",[x,y,x2,y2,c]),
        drawRect:(x,y,w,h,c)=>spriteEmit("rect",[x,y,w,h,c]),
        drawFillRect:(x,y,w,h,c)=>spriteEmit("fillRect",[x,y,w,h,c]),
        drawFillRectGradient:(x,y,w,h,c1)=>spriteEmit("fillRect",[x,y,w,h,c1]),
        drawRoundRect:(x,y,w,h,r,c)=>spriteEmit("roundRect",[x,y,w,h,r,c]),
        drawFillRoundRect:(x,y,w,h,r,c)=>spriteEmit("fillRoundRect",[x,y,w,h,r,c]),
        drawCircle:(x,y,r,c)=>spriteEmit("circle",[x,y,r,c]),
        drawFillCircle:(x,y,r,c)=>spriteEmit("fillCircle",[x,y,r,c]),
        drawXBitmap:(x,y,b,w,h,c,bg)=>spriteEmit("xbitmap",[x,y,Array.from(b),w,h,c,bg]),
        drawBitmap:(x,y,b,w,h,c,bg)=>spriteEmit("xbitmap",[x,y,Array.from(b),w,h,c,bg]),
        pushSprite:(x,y,transparent)=>pushSprite(id,x,y,transparent),
        deleteSprite:()=>postMessage({type:"spriteDelete",id:id})
      };
    }
    display.createSprite = createSprite;

    const keyboard = {
      numKeyboard:function(){
        let value;
        do {
          value = keyboard.keyboard.apply(null,arguments);
          if (value && !/^[0-9]+$/.test(value)) print("Numeric keyboard requires digits only; please enter a number");
        } while (value && !/^[0-9]+$/.test(value));
        return value;
      },
      setLongPress:enabled=>{longPress=Boolean(enabled);},
      getPrevPress:(hold)=>consume(0,hold),
      getSelPress:(hold)=>consume(1,hold),
      getNextPress:(hold)=>consume(2,hold),
      getEscPress:(hold)=>consume(3,hold),
      getAnyPress:(hold)=>[0,1,2,3].some(i=>consume(i,hold)),
      getKeysPressed:()=>{
        const keys = [];
        for (let slot = 8; slot < 16; slot++) {
          const value = Atomics.load(input, slot);
          if (!value) continue;
          // 0x10000: not read yet, 0x20000: released before it was read.
          if (value & 0x20000) Atomics.compareExchange(input, slot, value, 0);
          else if (value & 0x10000) Atomics.compareExchange(input, slot, value, value & 0xFFFF);
          const key = String.fromCharCode(value & 0xFFFF);
          if (!keys.includes(key)) keys.push(key);
        }
        return keys;
      },
      keyboard:(value,maxlen,title,masked)=>{
        const maskRequested = typeof value === "number" ? title === true : masked === true;
        if (maskRequested && !unavailableInputs.has("keyboard.masked")) {
          print("Browser keyboard prompts are not password-masked; use a throwaway PIN or password only");
          unavailableInputs.add("keyboard.masked");
        }
        if (typeof value === "number") {
          title = maxlen;
          maxlen = value;
          value = "";
        }
        maxlen = maxlen === undefined ? 76 : Number(maxlen);
        if (!Number.isInteger(maxlen) || maxlen < 0 || maxlen > 4096) {
          throw new RangeError("Keyboard input length must be between 0 and 4096");
        }
        const response = new Int32Array(new SharedArrayBuffer((maxlen + 2) * 4));
        postMessage({type:"prompt",title:title || "Input",maxlen:maxlen,value:String(value || ""),response:response.buffer});
        while (Atomics.load(response,0) === 0) Atomics.wait(response,0,0);
        if (Atomics.load(response,0) === -1) throw new Error("Keyboard prompt failed");
        let result = "";
        for (let i = 0; i < response[1]; i++) result += String.fromCharCode(response[i + 2]);
        return result;
      }
    };

    const storageMap = Object.create(null);
    function storageKey(name) {
      const qualified = name !== null && typeof name === "object";
      const path = qualified ? name.path : name;
      if (typeof path !== "string" || !path) throw new TypeError("Storage requires a file path");
      const normalized = "/" + path.replace(/^\\/+/, "");
      const fs = qualified ? name.fs : ("sd:" + normalized in storageMap ? "sd" : "littlefs");
      if (fs !== "sd" && fs !== "littlefs") throw new TypeError("Unsupported virtual filesystem: " + fs);
      return fs + ":" + normalized;
    }
    function storageSpace(fs, total) {
      const bytes = Object.keys(storageMap).filter(name=>name.startsWith(fs + ":")).reduce(
        (sum,name)=>sum + new TextEncoder().encode(storageMap[name]).length, 0);
      const used = Math.ceil(bytes / 1024);
      total = Math.max(total, used);
      return {total:total, used:used, free:total-used};
    }
    const storage = {
      read:(name)=>storageMap[storageKey(name)] || "",
      readdir:(name,options)=>{
        let key = storageKey(name);
        if (typeof name === "string") {
          const sdKey = "sd:" + key.slice(key.indexOf(":") + 1);
          const sdPrefix = sdKey.replace(/\\/+$/, "") + "/";
          if (Object.keys(storageMap).some(file=>file.startsWith(sdPrefix))) key = sdKey;
        }
        const prefix = key.replace(/\\/+$/, "") + "/";
        const entries = new Map();
        for (const file of Object.keys(storageMap)) {
          if (!file.startsWith(prefix)) continue;
          const relative = file.slice(prefix.length);
          const entryName = relative.split("/")[0];
          if (!entryName) continue;
          const isDirectory = relative.includes("/");
          if (!entries.has(entryName) || isDirectory) {
            entries.set(entryName,{
              name:entryName,isDirectory:isDirectory,
              size:isDirectory ? 0 : new TextEncoder().encode(storageMap[file]).length
            });
          }
        }
        if (!entries.size && key !== "littlefs:/" && key !== "sd:/") {
          throw new Error("Virtual directory does not exist: " + name);
        }
        const sorted = Array.from(entries.values()).sort((a,b)=>a.name.localeCompare(b.name));
        return options && options.withFileTypes ? sorted : sorted.map(entry=>entry.name);
      },
      write:(name,value,mode)=>{
        const key = storageKey(name);
        storageMap[key] = (mode === "append" ? storageMap[key] || "" : "") + String(value);
        return true;
      },
      remove:(name)=>{
        const key = storageKey(name);
        const exists = key in storageMap;
        delete storageMap[key];
        return exists;
      },
      spaceLittleFS:()=>storageSpace("littlefs",2048),
      spaceSDCard:()=>storageSpace("sd",32768)
    };

    const unavailableInputs = new Set();
    function readUnavailableInput(name,timeout,unit) {
      if (!Number.isFinite(timeout) || timeout < 0) {
        throw new RangeError(name + " timeout must be a non-negative finite number");
      }
      if (!unavailableInputs.has(name)) {
        print(name + ": no physical input in emulator; reads return an empty string after the timeout");
        unavailableInputs.add(name);
      }
      delay(timeout * unit);
      return "";
    }

    const serial = {
      print:function(){print.apply(null,Array.from(arguments,String));},
      println:function(){println.apply(null,Array.from(arguments,String));},
      readln:(timeout = 10000)=>readUnavailableInput("serial.readln",timeout,1),
      cmd:(command)=>{
        if (typeof command !== "string") throw new TypeError("serial.cmd requires a command string");
        const match = /^storage\\s+remove\\s+(.+)$/.exec(command.trim());
        if (!match) {
          print("Unsupported serial command in emulator: " + command);
          return false;
        }
        const removed = storage.remove(match[1]);
        if (!removed) print("Virtual file not found: " + match[1]);
        return removed;
      }
    };

    // Synthetic hardware readings, not measurements of the host computer.
    const device = {
      getName:()=>"Bruce Web Emulator",
      getBoard:()=>"LILYGO T-Embed CC1101",
      getModel:()=>"ESP32-S3 (simulated)",
      getBruceVersion:()=>BRUCE_VERSION,
      getBattery:()=>100,
      getBatteryDetailed:()=>({
        battery_percent:100,
        remaining_capacity:1500,
        full_capacity:1500,
        design_capacity:1500,
        is_charging:false,
        charging_voltage:0,
        charging_current:0,
        time_to_empty:900,
        average_power_use:420,
        voltage:4.2,
        voltage_raw:4200,
        current_instant:-100,
        current_average:-100,
        current_raw:-100
      }),
      getFreeHeapSize:()=>({
        ram_free:256 * 1024,
        ram_min_free:240 * 1024,
        ram_largest_free_block:128 * 1024,
        ram_size:320 * 1024,
        psram_free:8 * 1024 * 1024,
        psram_size:8 * 1024 * 1024,
        psram_largest_free_block:8 * 1024 * 1024
      }),
      getEEPROMSize:()=>512
    };

    const wifi = {
      connectDialog:()=>{
        print("Wi-Fi connection is unavailable in emulator; remaining disconnected");
        return false;
      },
      httpFetch:()=>{
        const message = "wifi.httpFetch is not supported in emulator; no network request was sent";
        print(message);
        throw new Error(message);
      },
      connected:()=>{
        if (!unavailableInputs.has("wifi.connected")) {
          print("wifi.connected: simulated Wi-Fi is disconnected; network operations are unavailable");
          unavailableInputs.add("wifi.connected");
        }
        return false;
      },
      getIPAddress:()=>"0.0.0.0",
      getMACAddress:()=>"02:00:00:00:00:01"
    };

    const gpioValues = new Map();
    const gpio = {
      analogWrite:(pin,value)=>{
        if (!Number.isInteger(pin) || pin < 0 || pin > 48) {
          throw new RangeError("gpio.analogWrite requires an ESP32-S3 pin number between 0 and 48");
        }
        if (!Number.isInteger(value) || value < 0 || value > 255) {
          throw new RangeError("gpio.analogWrite requires a value between 0 and 255");
        }
        if (gpioValues.get(pin) === value) return;
        gpioValues.set(pin,value);
        print("Simulated GPIO (no physical output): analogWrite pin " + pin + " = " + value);
      }
    };

    const battery = {
      level:()=>device.getBattery()
    };

    const ir = {
      read:(timeout = 10)=>readUnavailableInput("ir.read",timeout,1000),
      readRaw:(timeout = 10)=>readUnavailableInput("ir.readRaw",timeout,1000),
      transmit:(data,protocol = "NEC",bits = 32)=>{
        if (typeof data !== "string" || !/^(?:0x)?[0-9a-f]+$/i.test(data)) {
          throw new TypeError("ir.transmit requires a hexadecimal data string");
        }
        if (typeof protocol !== "string" || !protocol.trim()) {
          throw new TypeError("ir.transmit requires a protocol name");
        }
        if (!Number.isInteger(bits) || bits < 1 || bits > 64) {
          throw new RangeError("ir.transmit bit count must be between 1 and 64");
        }
        print("Simulated IR transmit (no physical signal): " + protocol + " " + bits + " bits " + data);
        return true;
      }
    };

    let subghzFrequency = 433.92;
    const subghz = {
      setFrequency:frequency=>{
        if (!Number.isFinite(frequency) || frequency <= 0 || frequency > 4294.967295) {
          throw new RangeError("subghz.setFrequency requires a positive frequency in MHz");
        }
        subghzFrequency = frequency;
        print("Simulated Sub-GHz frequency (no radio hardware): " + frequency + " MHz");
      },
      read:(timeout = 10)=>readUnavailableInput("subghz.read",timeout,1000),
      readRaw:(timeout = 10)=>readUnavailableInput("subghz.readRaw",timeout,1000),
      transmit:(data,frequency = 433920000,te = 174,count = 10)=>{
        if (typeof data !== "string" || !/^(?:0x)?[0-9a-f]+$/i.test(data)) {
          throw new TypeError("subghz.transmit requires a hexadecimal data string");
        }
        if (!Number.isInteger(frequency) || frequency <= 0 || frequency > 4294967295) {
          throw new RangeError("subghz.transmit requires a positive frequency in Hz");
        }
        if (!Number.isInteger(te) || te <= 0 || te > 4294967295 ||
            !Number.isInteger(count) || count <= 0 || count > 4294967295) {
          throw new RangeError("subghz.transmit requires positive integer timing and repeat count");
        }
        print("Simulated Sub-GHz transmit (no physical signal): " + data + " at " +
          frequency + " Hz, TE " + te + " us, repeats " + count);
        return true;
      },
      transmitFile:filename=>{
        if (typeof filename !== "string" || !filename) {
          throw new TypeError("subghz.transmitFile requires a filename");
        }
        print("subghz.transmitFile is not supported in emulator: " + filename);
        return false;
      }
    };

    let badusbReady = false;
    const badusbHeld = new Set();
    function badusbAction(action,value) {
      if (!badusbReady) throw new Error("Call badusb.setup() before USB keyboard actions");
      if (action === "print" || action === "println") {
        if (typeof value !== "string") throw new TypeError("badusb." + action + " requires text");
      } else if (!Number.isInteger(value) || value < 0 || value > 255) {
        throw new RangeError("badusb." + action + " requires a key code between 0 and 255");
      }
      if (action === "hold") badusbHeld.add(value);
      if (action === "release" || action === "press") badusbHeld.delete(value);
      print("Simulated BadUSB (no host keystrokes): " + action + " " + JSON.stringify(value));
    }
    const badusb = {
      setup:()=>{
        badusbReady = true;
        badusbHeld.clear();
        print("Simulated BadUSB setup (no USB device or host keystrokes)");
        return true;
      },
      print:text=>badusbAction("print",text),
      println:text=>badusbAction("println",text),
      press:key=>badusbAction("press",key),
      pressRaw:key=>badusbAction("pressRaw",key),
      hold:key=>badusbAction("hold",key),
      release:key=>badusbAction("release",key),
      releaseAll:()=>{
        if (!badusbReady) throw new Error("Call badusb.setup() before USB keyboard actions");
        badusbHeld.clear();
        print("Simulated BadUSB (no host keystrokes): releaseAll");
      },
      runFile:filename=>{
        if (typeof filename !== "string" || !filename) {
          throw new TypeError("badusb.runFile requires a filename");
        }
        print("badusb.runFile is not supported in emulator: " + filename);
        return false;
      }
    };

    function withDialogDrawing(draw) {
      const saved = {textColor, textSize, cursorX, cursorY, alignX, alignY};
      textColor = BRUCE_PRICOLOR;
      textSize = 1;
      alignX = "left";
      alignY = "top";
      try {
        return draw();
      } finally {
        textColor = saved.textColor;
        textSize = saved.textSize;
        cursorX = saved.cursorX;
        cursorY = saved.cursorY;
        alignX = saved.alignX;
        alignY = saved.alignY;
      }
    }

    function dialogFrame(title, hint) {
      display.fill(BRUCE_BGCOLOR);
      display.drawRoundRect(2, 2, 316, 166, 4, BRUCE_PRICOLOR);
      display.drawString(title, 10, 12);
      display.drawString(hint, 10, 152);
    }

    const dialog = {
      createTextViewer:(text,options = {})=>{
        const fontSize = options.fontSize === undefined ? 1 : options.fontSize;
        const x = options.startX === undefined ? 10 : options.startX;
        const y = options.startY === undefined ? 10 : options.startY;
        const width = options.width === undefined ? 310 : options.width;
        const height = options.height === undefined ? 160 : options.height;
        if (!Number.isInteger(fontSize) || fontSize < 1 ||
            !Number.isFinite(x) || !Number.isFinite(y) ||
            !Number.isFinite(width) || !Number.isFinite(height) ||
            width < 6 * fontSize || height < 8 * fontSize) {
          throw new RangeError("Text viewer requires valid coordinates and room for at least one character");
        }
        const columns = Math.floor(width / (6 * fontSize));
        const rows = Math.floor(height / (8 * fontSize));
        let lines = [], top = 0, closed = false;
        function checkOpen() {
          if (closed) throw new Error("Text viewer has been closed");
        }
        function setText(value) {
          checkOpen();
          if (typeof value !== "string") throw new TypeError("Text viewer requires a text string");
          lines = [];
          for (const original of value.replace(/\\r/g,"").split("\\n")) {
            let remaining = original;
            let continuation = false;
            while (remaining.length) {
              const prefix = continuation && options.indentWrappedLines && columns > 1 ? " " : "";
              const capacity = columns - prefix.length;
              let end = Math.min(capacity,remaining.length);
              if (remaining.length > capacity) {
                const space = remaining.lastIndexOf(" ",capacity);
                if (space > 0) end = space;
              }
              lines.push(prefix + remaining.slice(0,end));
              remaining = remaining.slice(end);
              if (remaining.startsWith(" ")) remaining = remaining.slice(1);
              continuation = true;
            }
            if (!original.length) lines.push("");
          }
          top = 0;
        }
        function scrollToLine(line) {
          checkOpen();
          if (!Number.isInteger(line)) throw new TypeError("Text viewer line index must be an integer");
          top = Math.max(0,Math.min(line,Math.max(0,lines.length - rows)));
        }
        const viewer = {
          setText:setText,
          clear:()=>{checkOpen();lines = [];top = 0;},
          getMaxLines:()=>{checkOpen();return lines.length;},
          getLine:index=>{
            checkOpen();
            if (!Number.isInteger(index) || index < 0 || index >= lines.length) {
              throw new RangeError("Text viewer line index is out of range");
            }
            return lines[index];
          },
          getVisibleText:()=>{checkOpen();return lines.slice(top,top + rows).join("\\n");},
          scrollToLine:scrollToLine,
          scrollUp:()=>scrollToLine(top - 1),
          scrollDown:()=>scrollToLine(top + 1),
          draw:()=>{
            checkOpen();
            return withDialogDrawing(()=>{
              display.drawFillRect(x,y,width,height,BRUCE_BGCOLOR);
              display.setTextSize(fontSize);
              for (let i = top; i < Math.min(top + rows,lines.length); i++) {
                display.drawString(lines[i],x,y + (i - top) * 8 * fontSize);
              }
            });
          },
          close:()=>{lines = [];closed = true;}
        };
        setText(text);
        return viewer;
      },
      prompt:(title,maxlen,value)=>keyboard.keyboard(value,maxlen,title),
      info:(message,waitForInput)=>dialog.success(message,waitForInput,"Info"),
      choice:(choices)=>{
        if (!choices || typeof choices !== "object") {
          throw new TypeError("dialog.choice requires an array or object");
        }
        const entries = Array.isArray(choices)
          ? choices.map(item=>typeof item === "string" ? [item,item] : item)
          : Object.entries(choices);
        if (!entries.length || entries.some(item=>!Array.isArray(item) ||
            typeof item[0] !== "string" || typeof item[1] !== "string")) {
          throw new TypeError("dialog.choice requires non-empty string choices or label/value pairs");
        }
        return withDialogDrawing(()=>{
          let selected = 0, redraw = true;
          while (true) {
            if (redraw) {
              dialogFrame("Choose", "Left/Right: choose  Enter: select  Esc: back");
              const top = Math.floor(selected / 6) * 6;
              for (let i = top; i < Math.min(top + 6, entries.length); i++) {
                const y = 36 + (i - top) * 18;
                if (i === selected) display.drawRect(6,y - 3,308,16,BRUCE_SECCOLOR);
                display.drawString(entries[i][0].slice(0,49),10,y);
              }
              redraw = false;
            }
            if (keyboard.getEscPress()) return "";
            if (keyboard.getSelPress()) return entries[selected][1];
            if (keyboard.getNextPress()) {
              selected = (selected + 1) % entries.length;
              redraw = true;
            } else if (keyboard.getPrevPress()) {
              selected = (selected + entries.length - 1) % entries.length;
              redraw = true;
            }
            delay(25);
          }
        });
      },
      message:(message,buttons)=>{
        if (buttons && Object.keys(buttons).length) {
          print(message);
          return dialog.choice(Object.entries(buttons).map(([key,label])=>
            [String(label),key === "right" ? "right" : String(label)]));
        }
        dialog.success(message,true);
        return "right";
      },
      error:(message,waitForInput)=>{
        print("Error: " + message);
        return dialog.success(message,waitForInput);
      },
      success:(message, waitForInput, title = "Success")=>{
        postMessage({type:"log", text:String(message)});
        return withDialogDrawing(()=>{
          dialogFrame(title, waitForInput ? "Press any control to continue" : "");
          const words = String(message).trim().split(/\\s+/);
          let line = "", y = 36;
          for (const word of words) {
            if ((line + word).length > 48) {
              display.drawString(line, 10, y);
              y += 12;
              line = "";
            }
            line += (line ? " " : "") + word;
          }
          display.drawString(line, 10, y);
          if (waitForInput) {
            while (!keyboard.getAnyPress()) delay(25);
          } else {
            delay(1500);
          }
        });
      },
      pickFile:(directory, options)=>{
        return withDialogDrawing(()=>{
          const prefix = "/" + String(directory || "/").replace(/^\\/+|\\/+$/g, "") + "/";
          const normalizedPrefix = prefix === "//" ? "/" : prefix;
          const files = [...new Set(Object.keys(storageMap).map(name=>name.slice(name.indexOf(":") + 1)))]
            .filter(name=>name.startsWith(normalizedPrefix)).sort();
          if (!files.length) {
            postMessage({type:"log", text:"No virtual files in " + normalizedPrefix + ". Save a file in this script first."});
            dialogFrame("Load file", "Press any control to return");
            display.drawString("No saved files in " + normalizedPrefix, 10, 40);
            while (!keyboard.getAnyPress()) delay(25);
            return "";
          }
          let selected = 0, redraw = true;
          while (true) {
            if (redraw) {
              dialogFrame("Load file", "Left/Right: choose  Enter: load  Esc: back");
              const top = Math.floor(selected / 6) * 6;
              for (let i = top; i < Math.min(top + 6, files.length); i++) {
                const y = 36 + (i - top) * 18;
                if (i === selected) display.drawRect(6, y - 3, 308, 16, BRUCE_SECCOLOR);
                const name = files[i].slice(normalizedPrefix.length);
                const label = options && options.withFileTypes ? name : name.replace(/\\.[^.]+$/, "");
                display.drawString(label.slice(0, 49), 10, y);
              }
              redraw = false;
            }
            if (keyboard.getEscPress()) return "";
            if (keyboard.getSelPress()) return files[selected];
            if (keyboard.getNextPress()) {
              selected = (selected + 1) % files.length;
              redraw = true;
            } else if (keyboard.getPrevPress()) {
              selected = (selected + files.length - 1) % files.length;
              redraw = true;
            }
            delay(25);
          }
        });
      }
    };

    const audio = {
      tone:(frequency,duration,wait)=>{
        const id = Atomics.add(input,5,1) + 1;
        postMessage({type:"audio", op:"tone", id:id, frequency:frequency, duration:duration});
        if (wait) {
          while (Atomics.load(input,6) !== id) {
            Atomics.wait(input,6,Atomics.load(input,6));
          }
        }
      },
      stop:()=>postMessage({type:"audio", op:"stop"})
    };

    function require(name) {
      if (name==="display") return display;
      if (name==="keyboard") return keyboard;
      if (name==="storage") return storage;
      if (name==="serial") return serial;
      if (name==="dialog") return dialog;
      if (name==="audio") return audio;
      if (name==="device") return device;
      if (name==="battery") return battery;
      if (name==="gpio") return gpio;
      if (name==="wifi") return wifi;
      if (name==="ir") return ir;
      if (name==="badusb") return badusb;
      if (name==="subghz") return subghz;
      throw new Error("Unsupported Bruce module in emulator: "+name);
    }

    onmessage = function(e) {
      if (e.data.type==="start") {
        input = new Int32Array(e.data.sab);
        __filepath = __dirpath + "/" + (e.data.name || "index.js");
        try {
          // Bruce's current scripting environment is ES5-oriented; the emulator
          // intentionally exposes the same globals instead of wrapping the app.
          eval(e.data.code);
          postMessage({type:"done"});
        } catch(err) {
          postMessage({type:"error", text:err && (err.stack || err.message) || String(err)});
        }
      }
    };
  `;

  function start(code, name) {
    stop(false);
    clearScreen();
    setStatus("Running", "running");
    log(`Loading ${name || "script"}...`);
    const blob = new Blob([workerSource], {type:"application/javascript"});
    currentBlobUrl = URL.createObjectURL(blob);
    worker = new Worker(currentBlobUrl);
    worker.onmessage = e => {
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
      else if (m.type === "done") { setStatus("Finished", "done"); log("Script finished."); }
      else if (m.type === "error") { setStatus("Error", "error"); log(m.text); }
    };
    worker.onerror = e => { setStatus("Error","error"); log(`Worker error: ${e.message}`); };
    worker.postMessage({type:"start", code, sab, name:name || "index.js"});
  }

  function stop(writeLog=true) {
    if (worker) {
      worker.terminate();
      worker = null;
      sprites.clear();
      setStatus("Stopped", "idle");
      if (writeLog) log("Script stopped.");
    }
    stopAudio();
    resetInput();
    if (currentBlobUrl) {
      URL.revokeObjectURL(currentBlobUrl);
      currentBlobUrl = null;
    }
  }

  async function loadUrl() {
    unlockAudio();
    const custom = appSourceEl.value === "custom";
    const url = custom ? urlEl.value.trim() : appSourceEl.value;
    if (!url || (custom && !urlEl.reportValidity())) {
      setStatus("Invalid URL", "error");
      log("Enter a valid JavaScript URL before loading.");
      urlEl.focus();
      return;
    }
    setStatus("Loading...", "running");
    log(`Fetching ${url}`);
    try {
      const r = await fetch(url, {cache:"no-store"});
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const code = await r.text();
      start(code, decodeURIComponent(new URL(url).pathname.split("/").pop() || "remote.js"));
    } catch (e) {
      setStatus("Error", "error");
      log(`Fetch failed: ${e.message}`);
      log("If the remote host blocks browser CORS, download the .js file and use Load .js.");
    }
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
  document.getElementById("clearLog").onclick = () => { logEl.textContent=""; };

  document.getElementById("file").onchange = async e => {
    const file = e.target.files[0];
    if (!file) return;
    const code = await file.text();
    start(code, file.name);
    e.target.value = "";
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
