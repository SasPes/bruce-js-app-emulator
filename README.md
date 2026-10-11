# Bruce LILYGO T-Embed CC1101 Web Emulator

A browser emulator for Bruce JavaScript apps on the LILYGO T-Embed CC1101,
with a **320 x 170** pixel display.

**Live emulator:** [bruce-js-app-emulator.saspes.workers.dev](https://bruce-js-app-emulator.saspes.workers.dev/)

![Bruce emulator running Key Decoding alongside the runtime console](ss/ss.png)

## Run

Requires **Python 3** and a modern browser. No additional packages or build step.
From the project directory:

```bash
python3 start-server.py
```

Open [localhost:8080](http://localhost:8080)

Use the included server for `SharedArrayBuffer` support. Opening `index.html`
directly or using `python3 -m http.server` will not work.

## Deploy to Cloudflare Pages

The whole emulator runs in the browser and can be hosted on Cloudflare Pages'
Free plan. No Python server, Pages Functions, dependencies, or environment
variables are needed in production.

1. Push the project, including `_headers`, to GitHub.
2. In Cloudflare, open **Workers & Pages > Create application > Pages** and
   import the GitHub repository.
3. Use the following deployment settings:

| Setting | Value |
| --- | --- |
| Framework preset | None |
| Production branch | `main` |
| Root directory | Default (repository root) |
| Build command | `mkdir -p dist && cp index.html style.css app.js pixel-renderer.js _headers dist/` |
| Build output directory | `dist` |
| Environment variables | None |

4. Select **Save and Deploy**, then open the generated HTTPS `*.pages.dev` URL.
   Subsequent pushes to `main` deploy automatically.

The build command only copies the browser assets, so local server and IDE files
are not published. The `_headers` file must be in the deployment output: it sets
`Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp`, which enable the cross-origin
isolation required by `SharedArrayBuffer`. Cloudflare provides HTTPS.

Custom script URLs must use HTTPS and allow CORS from the deployed site.
Hosting on Pages does not bypass restrictions imposed by script hosts; download
and upload the script locally if its URL is blocked.

## Usage

- Select **Key Decoding**, **Magic 8 Ball**, **Morse Code**, or an app under **Apps from Bruce App Store**, then click the play icon.
- Use **Custom URL** or the upload icon to load another `.js` app.
- **Stop** ends the app; the camera icon saves the display as a **640 x 340 PNG**.

Presets require internet access. If CORS blocks a URL, download the script
and upload it locally.

## Controls

| Key | Action |
| --- | --- |
| Left / Up Arrow, `,`, `;` | Previous |
| Enter | Select |
| Right / Down Arrow, `/`, `.` | Next |
| Escape, Backspace, `` ` `` | Back |

On-screen buttons provide the same controls.

## Supported features

- `require("display")`
- `require("keyboard")`
- `keyboard.setLongPress(enabled)` held-control polling (disabled by default)
- `keyboard.getKeysPressed()` currently held Cardputer keys
- `require("dialog")` choice menus, blocking messages, info/success/error messages, and virtual file picker
- `keyboard.keyboard(initialText, maxLength, prompt)` browser text input (up to 4096 characters)
- `keyboard.numKeyboard()` uses the same argument forms and requests digits-only input; browser prompts are not password-masked, even when the script requests masking. Use throwaway PINs/passwords only.
- `require("serial")` print/println to the runtime console, timeout-only `readln(timeoutMs = 10000)`, and `cmd("storage remove <path>")` for virtual files; other commands log a warning and return `false`
- `require("audio")` tone playback and stop
- `require("device")` name, board, model, Bruce version, battery, heap, and EEPROM information
- `require("battery")` compatibility module with `level()` returning the same simulated 100% reading as `device.getBattery()`
- `require("gpio")` simulated `analogWrite(pin, value)` for ESP32-S3 pin numbers 0-48 and PWM values 0-255; changed values are logged only, with no physical output. Other GPIO methods are not supported.
- `dialog.prompt(title, maxLength, initialText)` uses browser text input for apps such as RGB Controller.
- `dialog.createTextViewer(text, options)` supports wrapped text, `setText`, `clear`, `draw`, `scrollUp`, `scrollDown`, `scrollToLine`, `getLine`, `getMaxLines`, `getVisibleText`, and `close`. Options include `fontSize`, `startX`, `startY`, `width`, `height`, and `indentWrappedLines`.
- `require("wifi")` IP and MAC address getters and `connected()` (always `false`, with a one-time notice); `connectDialog()` logs that connection is unavailable and returns `false`. `httpFetch()` logs and throws an explicit unsupported-operation error without sending a request.
- `require("ir")` simulated `transmit(data, protocol = "NEC", bits = 32)` with hexadecimal data; transmissions are logged and return `true`, but no physical infrared signal is sent. `read(timeoutSeconds = 10)` and `readRaw(timeoutSeconds = 10)` return an empty string after the timeout and log the lack of physical input once. File transmission is not supported.
- `require("badusb")` simulated `setup`, `print`, `println`, `press`, `pressRaw`, `hold`, `release`, and `releaseAll`; call `setup()` first. Actions are logged only: no USB device is created and no host keystrokes are sent. `runFile` logs that it is unsupported and returns `false`.
- `require("subghz")` simulated `setFrequency(MHz)` and `transmit(hexData, frequencyHz = 433920000, te = 174, count = 10)`; transmissions are logged only and return `true`. `read`/`readRaw` return an empty string after their timeout in seconds (default 10), with a one-time notice that no physical input is available. `transmitFile` logs that it is unsupported and returns `false`.
- `require("storage")` in-memory files, directory listings (`readdir`, including `withFileTypes`), and space information, with string paths or `{fs: "sd" | "littlefs", path: "/file"}`; virtual files reset when the app restarts
- `display.getRotation()` and `display.getBrightness()`
- Legacy globals `setTextSize(size)` and `setTextColor(color)` share the display module's text state
- `display.createSprite()` offscreen drawing and push (paced at up to 30 FPS)
- `delay(ms)`
- `now()` and `random()`, `random(max)`, `random(min, max)` (integer, upper bound exclusive)
- `gc()` compatibility global; logs once that browser garbage collection is automatic and cannot be forced
- `__dirpath` is the virtual `/scripts` directory; `__filepath` includes the loaded script's filename (URL filenames are decoded). These paths do not access the host filesystem.
- CommonJS `exports` and `module.exports` are available for compiled script compatibility; `require()` still resolves only the emulator's supported Bruce modules.
- Bruce globals `to_string(value)` and `parse_int(value)`; `parse_int` uses numeric conversion like the firmware, rather than JavaScript's `parseInt`
- `print()` / `println()`
- Display drawing, text, colors, XBitmap
- Blocking Bruce-style polling loops
