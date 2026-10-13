"use strict";
let input = null;
var __dirpath = "/scripts";
var __filepath = "/scripts/index.js";
var module = {exports:{}};
var exports = module.exports;
const displayState = drawingState(0xffff, 1);
let longPress = false;

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
// Route console.* to the runtime console instead of the browser's dev tools.
function consoleText(value) {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.stack || String(value);
  if (value !== null && typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch (e) {}
  }
  return String(value);
}
function consoleMethod(prefix) {
  return function() {
    print((prefix ? prefix + " " : "") + Array.prototype.map.call(arguments, consoleText).join(" "));
  };
}
globalThis.console = {
  log: consoleMethod(""), info: consoleMethod(""), debug: consoleMethod(""),
  warn: consoleMethod("[warn]"), error: consoleMethod("[error]")
};
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

function drawingState(textColor, textSize) {
  return {textColor, textSize, cursorX:0, cursorY:0, alignX:"left", alignY:"top"};
}

function drawingApi(width, height, state, target) {
  function emit(op, args) {
    postMessage({
      ...target, op:op, args:args || [],
      textColor:state.textColor, textSize:state.textSize,
      alignX:state.alignX, alignY:state.alignY
    });
  }
  return {
    width:()=>width, height:()=>height,
    color:color,
    fill:c=>emit("fill",[c]),
    setCursor:(x,y)=>{state.cursorX=x;state.cursorY=y;},
    // print intentionally leaves the cursor unchanged; only println advances Y.
    print:function(){emit("text",[Array.prototype.slice.call(arguments).join(" "),state.cursorX,state.cursorY]);},
    println:function(){
      emit("text",[Array.prototype.slice.call(arguments).join(" "),state.cursorX,state.cursorY]);
      state.cursorY += 8 * state.textSize;
    },
    setTextColor:c=>{state.textColor=c;},
    setTextAlign:(a,b)=>{
      state.alignX = (a===1 || a==="center") ? "center" : (a===2 || a==="right") ? "right" : "left";
      state.alignY = (b===2 || b==="middle") ? "middle" : (b===3 || b==="bottom") ? "bottom" : "top";
    },
    setTextSize:s=>{state.textSize=Math.max(1,Math.trunc(Number(s)||1));},
    drawText:(t,x,y)=>emit("text",[t,x,y]),
    drawString:(t,x,y)=>emit("text",[t,x,y]),
    drawPixel:(x,y,c)=>emit("pixel",[x,y,c]),
    drawLine:(x,y,x2,y2,c)=>emit("line",[x,y,x2,y2,c]),
    drawRect:(x,y,w,h,c)=>emit("rect",[x,y,w,h,c]),
    drawFillRect:(x,y,w,h,c)=>emit("fillRect",[x,y,w,h,c]),
    // Both surfaces retain the first color instead of rendering a gradient.
    drawFillRectGradient:(x,y,w,h,c1)=>emit("fillRect",[x,y,w,h,c1]),
    drawRoundRect:(x,y,w,h,r,c)=>emit("roundRect",[x,y,w,h,r,c]),
    drawFillRoundRect:(x,y,w,h,r,c)=>emit("fillRoundRect",[x,y,w,h,r,c]),
    drawCircle:(x,y,r,c)=>emit("circle",[x,y,r,c]),
    drawFillCircle:(x,y,r,c)=>emit("fillCircle",[x,y,r,c]),
    drawXBitmap:(x,y,b,w,h,c,bg)=>emit("xbitmap",[x,y,Array.from(b),w,h,c,bg]),
    drawBitmap:(x,y,b,w,h,c,bg)=>emit("xbitmap",[x,y,Array.from(b),w,h,c,bg])
  };
}

const display = {
  ...drawingApi(320, 170, displayState, {type:"draw"}),
  getRotation:()=>1,
  getBrightness:()=>100
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
  const state = drawingState(displayState.textColor, displayState.textSize);
  const api = drawingApi(width, height, state, {type:"spriteDraw", id:id});
  return {
    ...api,
    fillScreen:api.fill,
    fillSprite:api.fill,
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
      const characterCode = value % 0x10000;
      if (value >= 0x20000) Atomics.compareExchange(input, slot, value, 0);
      else if (value >= 0x10000) Atomics.compareExchange(input, slot, value, characterCode);
      const key = String.fromCharCode(characterCode);
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
  const normalized = "/" + path.replace(/^\/+/, "");
  const fs = qualified ? name.fs : ("sd:" + normalized in storageMap ? "sd" : "littlefs");
  if (fs !== "sd" && fs !== "littlefs") throw new TypeError("Unsupported virtual filesystem: " + fs);
  return fs + ":" + normalized;
}
function storageSpace(fs, total) {
  const bytes = Object.keys(storageMap).filter(name=>name.startsWith(fs + ":")).reduce(
    (sum,name)=>sum + storageByteLength(name), 0);
  const used = Math.ceil(bytes / 1024);
  total = Math.max(total, used);
  return {total:total, used:used, free:total-used};
}
// Keys whose contents are raw bytes (one character per byte) rather than text, e.g. images saved
// by httpFetch. The page keeps these as base64.
const binaryFiles = new Set();
function storageByteLength(key) {
  return binaryFiles.has(key) ? storageMap[key].length : new TextEncoder().encode(storageMap[key]).length;
}
function storageWrite(name,value,mode,binary) {
  const key = storageKey(name);
  storageMap[key] = (mode === "append" ? storageMap[key] || "" : "") + String(value);
  // Appending to a binary file keeps it binary; any other text write makes it text.
  if (binary || (mode === "append" && binaryFiles.has(key))) binaryFiles.add(key);
  else binaryFiles.delete(key);
  // The page persists the files and shows them in its storage browser.
  postMessage({type:"storageWrite", key:key, value:storageMap[key], binary:binaryFiles.has(key)});
  return true;
}
const storage = {
  read:(name)=>storageMap[storageKey(name)] || "",
  readdir:(name,options)=>{
    let key = storageKey(name);
    if (typeof name === "string") {
      const sdKey = "sd:" + key.slice(key.indexOf(":") + 1);
      const sdPrefix = sdKey.replace(/\/+$/, "") + "/";
      if (Object.keys(storageMap).some(file=>file.startsWith(sdPrefix))) key = sdKey;
    }
    const prefix = key.replace(/\/+$/, "") + "/";
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
          size:isDirectory ? 0 : storageByteLength(file)
        });
      }
    }
    if (!entries.size && key !== "littlefs:/" && key !== "sd:/") {
      throw new Error("Virtual directory does not exist: " + name);
    }
    const sorted = Array.from(entries.values()).sort((a,b)=>a.name.localeCompare(b.name));
    return options && options.withFileTypes ? sorted : sorted.map(entry=>entry.name);
  },
  write:(name,value,mode)=>storageWrite(name,value,mode,false),
  remove:(name)=>{
    const key = storageKey(name);
    const exists = key in storageMap;
    delete storageMap[key];
    binaryFiles.delete(key);
    if (exists) postMessage({type:"storageRemove", key:key});
    return exists;
  },
  spaceLittleFS:()=>storageSpace("littlefs",hardware.flash * 256),
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
    const match = /^storage\s+remove\s+(.+)$/.exec(command.trim());
    if (!match) {
      print("Unsupported serial command in emulator: " + command);
      return false;
    }
    const removed = storage.remove(match[1]);
    if (!removed) print("Virtual file not found: " + match[1]);
    return removed;
  }
};

// Synthetic hardware readings, not measurements of the host computer. The specs come from
// devices.js
importScripts("devices.js");
let deviceBoard = DEFAULT_DEVICE;
let hardware = DEVICES.find(d=>d.name === DEFAULT_DEVICE);
const device = {
  getName:()=>"Bruce Web Emulator",
  getBoard:()=>deviceBoard,
  getModel:()=>hardware.esp + " (simulated)",
  getBruceVersion:()=>BRUCE_VERSION,
  // Devices without a battery report 0, as there is no fuel gauge to read.
  getBattery:()=>hardware.battery ? 100 : 0,
  getBatteryDetailed:()=>{
    const mAh = hardware.battery;
    return {
      battery_percent:mAh ? 100 : 0,
      remaining_capacity:mAh,
      full_capacity:mAh,
      design_capacity:mAh,
      is_charging:false,
      charging_voltage:0,
      charging_current:0,
      time_to_empty:Math.round(mAh * 0.6),
      average_power_use:mAh ? 420 : 0,
      voltage:mAh ? 4.2 : 0,
      voltage_raw:mAh ? 4200 : 0,
      current_instant:mAh ? -100 : 0,
      current_average:mAh ? -100 : 0,
      current_raw:mAh ? -100 : 0
    };
  },
  getFreeHeapSize:()=>{
    const psram = hardware.psram * 1024 * 1024;
    return {
      ram_free:256 * 1024,
      ram_min_free:240 * 1024,
      ram_largest_free_block:128 * 1024,
      ram_size:320 * 1024,
      psram_free:psram,
      psram_size:psram,
      psram_largest_free_block:psram
    };
  },
  getEEPROMSize:()=>512
};

// Simulated station. The network chosen in the page selector (input slot 4: 0 = none,
// n = network n) is the one the device is "connected" to, with no connect call needed.
// httpFetch uses the browser's own connection. Nothing touches real Wi-Fi hardware.
let WIFI_NETWORKS = [];
function wifiCurrent() {
  const selected = Atomics.load(input,4);
  return selected >= 1 && selected <= WIFI_NETWORKS.length ? WIFI_NETWORKS[selected - 1] : null;
}
function wifiSelect(index) {
  Atomics.store(input,4,index);
  postMessage({type:"wifiSelect", index:index});
}
const wifi = {
  connectDialog:()=>{
    const current = wifiCurrent();
    if (!current) {
      print("Wi-Fi: no network selected in the emulator");
      return false;
    }
    return true;
  },
  connect:(ssid,timeout = 10,password)=>{
    if (typeof ssid !== "string" || !ssid) {
      throw new TypeError("wifi.connect requires an SSID string");
    }
    if (!Number.isFinite(timeout) || timeout < 0) {
      throw new RangeError("wifi.connect timeout must be a non-negative number of seconds");
    }
    if (password !== undefined && typeof password !== "string") {
      throw new TypeError("wifi.connect password must be a string");
    }
    const index = WIFI_NETWORKS.findIndex(network=>network.SSID === ssid);
    if (index < 0) {
      print("Wi-Fi: network not found: " + ssid);
      return false;
    }
    wifiSelect(index + 1);
    return true;
  },
  disconnect:()=>{
    if (wifiCurrent()) wifiSelect(0);
    return true;
  },
  scan:()=>WIFI_NETWORKS.map(network=>({...network})),
  connected:()=>wifiCurrent() !== null,
  getIPAddress:()=>wifi.connected() ? "192.168.1.100" : "0.0.0.0",
  getMACAddress:()=>"02:00:00:00:00:01",
  httpFetch:(url,options = {})=>{
    if (typeof url !== "string" || !url) {
      throw new TypeError("wifi.httpFetch requires a URL string");
    }
    if (options === null || typeof options !== "object") {
      throw new TypeError("wifi.httpFetch options must be an object");
    }
    if (!wifi.connected()) {
      throw new Error("wifi.httpFetch: Wi-Fi is not connected");
    }
    const method = String(options.method || "GET").toUpperCase();
    const request = new XMLHttpRequest();
    // Input slot 16 is set from the page: 0 direct, 1 the server's /proxy, 2 the Corsfix public proxy.
    const mode = Atomics.load(input,16);
    const useProxy = mode === 1;
    const useCorsfix = mode === 2;
    const given = options.headers || {};
    try {
      if (useProxy) {
        request.open(method,"/proxy?url=" + encodeURIComponent(url),false);
        const sent = {};
        for (const name of Object.keys(given)) sent[name] = String(given[name]);
        request.setRequestHeader("X-Proxy-Headers",JSON.stringify(sent));
      } else {
        // Corsfix takes the raw target URL after "?" and adds the CORS headers; it only allows
        // a few request headers, anything else makes the browser's preflight fail.
        request.open(method,useCorsfix ? "https://proxy.corsfix.com/?" + url : url,false);
        for (const name of Object.keys(given)) {
          try {
            request.setRequestHeader(name,String(given[name]));
          } catch (e) {
            print("wifi.httpFetch: browser does not allow header " + name);
          }
        }
      }
      if (options.save) request.overrideMimeType("text/plain; charset=x-user-defined");
      request.send(options.body === undefined || method === "GET" || method === "HEAD"
        ? null : String(options.body));
    } catch (e) {
      print(useProxy
        ? "wifi.httpFetch failed: could not reach the emulator's /proxy endpoint"
        : useCorsfix
          ? "wifi.httpFetch failed: Corsfix could not fetch " + url + " (limit reached, blocked header, or unreachable)"
          : "wifi.httpFetch failed (network error or blocked by CORS): " + url);
      return {status:0, ok:false, body:"", headers:{}};
    }
    if (useProxy && request.getResponseHeader("X-Proxy-Error")) {
      print("wifi.httpFetch failed: proxy could not reach " + url);
      return {status:0, ok:false, body:"", headers:{}};
    }
    const headers = {};
    for (const line of request.getAllResponseHeaders().trim().split(/\r?\n/)) {
      const split = line.indexOf(":");
      if (split > 0) headers[line.slice(0,split).trim().toLowerCase()] = line.slice(split + 1).trim();
    }
    let body = request.responseText;
    // options.save {fs, path, mode} writes the response to storage instead of returning it.
    if (options.save) {
      const ok = request.status >= 200 && request.status < 300;
      if (ok) {
        // x-user-defined gives one character per byte (0xF780-0xF7FF for bytes >= 0x80).
        const bytes = Uint8Array.from(body, character=>character.charCodeAt(0) & 0xff);
        let text, binary = false;
        try {
          text = new TextDecoder("utf-8",{fatal:true}).decode(bytes);
        } catch (e) {
          // Not text: keep one character per byte; the page stores it as base64.
          text = Array.from(bytes, byte=>String.fromCharCode(byte)).join("");
          binary = true;
        }
        storageWrite(options.save,text,options.save.mode,binary);
        return {status:request.status, ok:true, body:"", length:bytes.length, headers};
      }
      return {status:request.status, ok:false, body:"", length:0, headers};
    }
    // responseType "json" returns the parsed value; unparseable bodies stay as text.
    if (options.responseType === "json") {
      try {
        body = JSON.parse(body);
      } catch (e) {
        print("wifi.httpFetch: response is not valid JSON");
      }
    }
    return {
      status:request.status,
      ok:request.status >= 200 && request.status < 300,
      body,
      headers
    };
  }
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

const subghz = {
  setFrequency:frequency=>{
    if (!Number.isFinite(frequency) || frequency <= 0 || frequency > 4294.967295) {
      throw new RangeError("subghz.setFrequency requires a positive frequency in MHz");
    }
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
  const saved = {...displayState};
  displayState.textColor = BRUCE_PRICOLOR;
  displayState.textSize = 1;
  displayState.alignX = "left";
  displayState.alignY = "top";
  try {
    return draw();
  } finally {
    Object.assign(displayState, saved);
  }
}

function dialogFrame(title, hint) {
  display.fill(BRUCE_BGCOLOR);
  display.drawRoundRect(2, 2, 316, 166, 4, BRUCE_PRICOLOR);
  display.drawString(title, 10, 12);
  display.drawString(hint, 10, 152);
}

function navigateMenu(count, title, hint, labelAt, valueAt) {
  let selected = 0, redraw = true;
  while (true) {
    if (redraw) {
      dialogFrame(title, hint);
      const top = Math.floor(selected / 6) * 6;
      for (let i = top; i < Math.min(top + 6, count); i++) {
        const y = 36 + (i - top) * 18;
        if (i === selected) display.drawRect(6, y - 3, 308, 16, BRUCE_SECCOLOR);
        display.drawString(labelAt(i).slice(0, 49), 10, y);
      }
      redraw = false;
    }
    if (keyboard.getEscPress()) return "";
    if (keyboard.getSelPress()) return valueAt(selected);
    if (keyboard.getNextPress()) {
      selected = (selected + 1) % count;
      redraw = true;
    } else if (keyboard.getPrevPress()) {
      selected = (selected + count - 1) % count;
      redraw = true;
    }
    delay(25);
  }
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
      for (const original of value.replace(/\r/g,"").split("\n")) {
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
      getVisibleText:()=>{checkOpen();return lines.slice(top,top + rows).join("\n");},
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
    return withDialogDrawing(()=>navigateMenu(
      entries.length, "Choose", "Left/Right: choose  Enter: select  Esc: back",
      i=>entries[i][0], i=>entries[i][1]
    ));
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
      const words = String(message).trim().split(/\s+/);
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
      const prefix = "/" + String(directory || "/").replace(/^\/+|\/+$/g, "") + "/";
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
      return navigateMenu(
        files.length, "Load file", "Left/Right: choose  Enter: load  Esc: back",
        i=>{
          const name = files[i].slice(normalizedPrefix.length);
          return options && options.withFileTypes ? name : name.replace(/\.[^.]+$/, "");
        },
        i=>files[i]
      );
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

// These APIs are consumed by downloaded scripts rather than this worker itself.
Object.assign(globalThis, {
  exports, module, gc, now, to_string, parse_int, random, setTextSize, setTextColor, require
});

onmessage = function(e) {
  if (e.data.type==="start") {
    input = new Int32Array(e.data.sab);
    WIFI_NETWORKS = e.data.wifiNetworks || [];
    if (e.data.board) deviceBoard = e.data.board;
    hardware = DEVICES.find(d=>d.name === e.data.device) || hardware;
    // Files saved earlier (kept by the page), so apps see the same storage on every run.
    Object.assign(storageMap, e.data.storage || {});
    for (const key of e.data.storageBinary || []) binaryFiles.add(key);
    const w = e.data.width || 320, h = e.data.height || 170;
    Object.assign(display, drawingApi(w, h, displayState, {type:"draw"}));
    display.getRotation = () => h > w ? 0 : 1;
    __filepath = __dirpath + "/" + (e.data.name || "index.js");
    try {
      // Bruce's current scripting environment is ES5-oriented; the emulator
      // intentionally exposes the same globals instead of wrapping the app.
      eval(e.data.code);
      postMessage({type:"done"});
    } catch(err) {
      // Firefox stacks omit the message, so lead with it.
      const stack = err && err.stack || "";
      const head = err && err.message ? (err.name || "Error") + ": " + err.message : String(err);
      postMessage({type:"error", text:stack.includes(head) ? stack : head + (stack ? "\n" + stack : "")});
    }
  }
};
