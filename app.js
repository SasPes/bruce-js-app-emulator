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

  // Shared input state: previous, select, next, esc.
  // The worker consumes one-shot presses by atomically exchanging 1 -> 0.
  const sab = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 8);
  inputView = new Int32Array(sab);

  function setStatus(text, cls) {
    statusEl.textContent = text;
    statusEl.className = "status " + (cls || "idle");
  }
  function log(msg) {
    const line = `[${new Date().toLocaleTimeString()}] ${String(msg)}`;
    logEl.textContent += (logEl.textContent ? "\n" : "") + line;
    logEl.scrollTop = logEl.scrollHeight;
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
    let textColor = 0xffff;
    let textSize = 1;
    let cursorX = 0, cursorY = 0;
    let alignX = "left", alignY = "top";

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
    if (typeof console === "undefined") {
      var console = { log: print, error: print, warn: print };
    }
    function now() { return Date.now(); }

    // Bruce global constants for the current configured theme.
    var BRUCE_BGCOLOR = 0x0000;
    var BRUCE_PRICOLOR = color(255, 0, 255);
    var BRUCE_SECCOLOR = color(231, 190, 231);
    var BRUCE_VERSION = "web-emulator-0.1";

    function consume(index, hold) {
      if (hold) return Atomics.load(input,index) === 1;
      return Atomics.exchange(input,index,0) === 1;
    }

    const display = {
      width:()=>320, height:()=>170,
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

    const keyboard = {
      getPrevPress:(hold)=>consume(0,hold),
      getSelPress:(hold)=>consume(1,hold),
      getNextPress:(hold)=>consume(2,hold),
      getEscPress:(hold)=>consume(3,hold),
      getAnyPress:(hold)=>{
        if (hold) return [0,1,2,3].some(i=>Atomics.load(input,i)===1);
        return [0,1,2,3].some(i=>Atomics.exchange(input,i,0)===1);
      },
      getKeysPressed:()=>[],
      keyboard:(title,maxlen,value)=>{
        postMessage({type:"prompt",title:title,maxlen:maxlen,value:value});
        // Wait until main thread responds by storing a flag/value is beyond v0.1.
        return value || "";
      }
    };

    const storageMap = {};
    const storage = {
      read:(name)=>storageMap[name] || "",
      write:(name,value)=>{storageMap[name]=String(value);return true;},
      remove:(name)=>{delete storageMap[name];}
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
      success:(message, waitForInput)=>{
        postMessage({type:"log", text:String(message)});
        return withDialogDrawing(()=>{
          dialogFrame("Success", waitForInput ? "Press any control to continue" : "");
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
          const prefix = String(directory || "/").replace(/\\/+$/, "") + "/";
          const files = Object.keys(storageMap).filter(name=>name.startsWith(prefix)).sort();
          if (!files.length) {
            postMessage({type:"log", text:"No virtual files in " + prefix + ". Save a file in this script first."});
            dialogFrame("Load file", "Press any control to return");
            display.drawString("No saved files in " + prefix, 10, 40);
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
                const name = files[i].slice(prefix.length);
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

    function require(name) {
      if (name==="display") return display;
      if (name==="keyboard") return keyboard;
      if (name==="storage") return storage;
      if (name==="dialog") return dialog;
      throw new Error("Unsupported Bruce module in emulator: "+name);
    }

    onmessage = function(e) {
      if (e.data.type==="start") {
        input = new Int32Array(e.data.sab);
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
      else if (m.type === "prompt") log(`Prompt requested: ${m.title || "Input"} (v0.1 returns initial value)`);
      else if (m.type === "done") { setStatus("Finished", "done"); log("Script finished."); }
      else if (m.type === "error") { setStatus("Error", "error"); log(m.text); }
    };
    worker.onerror = e => { setStatus("Error","error"); log(`Worker error: ${e.message}`); };
    worker.postMessage({type:"start", code, sab});
  }

  function stop(writeLog=true) {
    if (worker) {
      worker.terminate();
      worker = null;
      setStatus("Stopped", "idle");
      if (writeLog) log("Script stopped.");
    }
    if (currentBlobUrl) {
      URL.revokeObjectURL(currentBlobUrl);
      currentBlobUrl = null;
    }
  }

  async function loadUrl() {
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
      start(code, url.split("/").pop() || "remote.js");
    } catch (e) {
      setStatus("Error", "error");
      log(`Fetch failed: ${e.message}`);
      log("If the remote host blocks browser CORS, download the .js file and use Load .js.");
    }
  }

  function press(index) {
    Atomics.store(inputView, index, 1);
    Atomics.notify(inputView, 7, 1);
  }

  document.getElementById("loadUrl").onclick = loadUrl;
  document.getElementById("loadFile").onclick = () => document.getElementById("file").click();
  document.getElementById("stop").onclick = () => stop();
  document.getElementById("clearLog").onclick = () => { logEl.textContent=""; };

  document.getElementById("file").onchange = async e => {
    const file = e.target.files[0];
    if (!file) return;
    const code = await file.text();
    start(code, file.name);
    e.target.value = "";
  };

  document.getElementById("encLeft").onclick = () => press(0);
  document.getElementById("enc").onclick = () => press(1);
  document.getElementById("encRight").onclick = () => press(2);
  document.getElementById("esc").onclick = () => press(3);

  window.addEventListener("keydown", e => {
    if (e.target instanceof Element &&
        (e.target.closest("input, select, textarea, .toolbar, .panel-actions") || e.target.isContentEditable)) return;
    if (["ArrowLeft","ArrowRight","Enter","Escape"].includes(e.key)) e.preventDefault();
    if (e.repeat) return;
    if (e.key==="ArrowLeft") press(0);
    else if (e.key==="Enter") press(1);
    else if (e.key==="ArrowRight") press(2);
    else if (e.key==="Escape") press(3);
  });

  log("Ready. Load a Bruce .js app.");
  log("Choose Key Decoding, Magic 8 Ball, Morse Code, or Custom URL, then click Load app.");
})();
