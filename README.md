# Bruce LILYGO T-Embed CC1101 Web Emulator

A browser emulator for Bruce JavaScript apps on the LILYGO T-Embed CC1101,
with a **320 x 170** pixel display.

![Bruce emulator running Key Decoding alongside the runtime console](ss/ss.png)

## Run

Requires **Python 3** and a modern browser. No additional packages or build step.
From the project directory:

```bash
python3 start-server.py
```

Open [localhost:8080](http://localhost:8080).

Use the included server for `SharedArrayBuffer` support. Opening `index.html`
directly or using `python3 -m http.server` will not work.

## Usage

- Select **Key Decoding**, **Magic 8 Ball**, or **Morse Code**, then click the play icon.
- Use **Custom URL** or the upload icon to load another `.js` app.
- **Stop** ends the app; the camera icon saves the display as a **640 x 340 PNG**.

Presets require internet access. If CORS blocks a URL, download the script
and upload it locally.

## Controls

| Key | Action |
| --- | --- |
| Left Arrow | Previous |
| Enter | Select |
| Right Arrow | Next |
| Escape | Back |

On-screen buttons provide the same controls.

## Supported features

- `require("display")`
- `require("keyboard")`
- `require("dialog")` success messages and virtual file picker
- `delay(ms)`
- `print()` / `println()`
- Display drawing, text, colors, XBitmap
- Blocking Bruce-style polling loops
