(() => {
  "use strict";

  // Seven rows of five bits per glyph, with a blank column/row for a 6x8 cell.
  const FONT = {
    " ": "00000000000000", "!": "04040404040004", '"': "0a0a0a00000000",
    "#": "0a0a1f0a1f0a0a", "$": "040f140e051e04", "%": "18190204081303",
    "&": "0c12140815120d", "'": "04040800000000", "(": "02040808080402",
    ")": "08040202020408", "*": "000a041f040a00", "+": "0004041f040400",
    ",": "00000000000408", "-": "0000001f000000", ".": "00000000000004",
    "/": "01010204081010", "0": "0e11131519110e", "1": "040c040404040e",
    "2": "0e11010204081f", "3": "1e01010e01011e", "4": "02060a121f0202",
    "5": "1f10101e01011e", "6": "0608101e11110e", "7": "1f010204080808",
    "8": "0e11110e11110e", "9": "0e11110f01020c", ":": "00040400040400",
    ";": "00040400040408", "<": "01020408040201", "=": "00001f001f0000",
    ">": "10080402040810", "?": "0e110102040004", "@": "0e11171d10100e",
    "A": "0e11111f111111", "B": "1e11111e11111e", "C": "0e11101010110e",
    "D": "1e11111111111e", "E": "1f10101e10101f", "F": "1f10101e101010",
    "G": "0e11101711110f", "H": "1111111f111111", "I": "0e04040404040e",
    "J": "0702020202120c", "K": "11121418141211", "L": "1010101010101f",
    "M": "111b1515111111", "N": "11191513111111", "O": "0e11111111110e",
    "P": "1e11111e101010", "Q": "0e11111115120d", "R": "1e11111e141211",
    "S": "0f10100e01011e", "T": "1f040404040404", "U": "1111111111110e",
    "V": "11111111110a04", "W": "11111115151b11", "X": "11110a040a1111",
    "Y": "11110a04040404", "Z": "1f01020408101f", "[": "0e08080808080e",
    "\\": "10100804020101", "]": "0e02020202020e", "^": "040a1100000000",
    "_": "0000000000001f", "`": "08040200000000", "a": "00000e010f110f",
    "b": "1010161911111e", "c": "00000e1110110e", "d": "01010d1311110f",
    "e": "00000e111f100e", "f": "0609091c080808", "g": "00000f110f010e",
    "h": "10101619111111", "i": "04000c0404040e", "j": "0200060202120c",
    "k": "10101214181412", "l": "0c04040404040e", "m": "00001a15151515",
    "n": "00001619111111", "o": "00000e1111110e", "p": "00001e111e1010",
    "q": "00000f110f0101", "r": "00001619101010", "s": "00000f100e011e",
    "t": "08081c08080906", "u": "0000111111130d", "v": "00001111110a04",
    "w": "0000111115150a", "x": "0000110a040a11", "y": "000011110f010e",
    "z": "00001f0204081f", "{": "02040408040402", "|": "04040404040404",
    "}": "08040402040408", "~": "00000815020000"
  };
  const GLYPHS = Object.fromEntries(Object.entries(FONT).map(([char, rows]) =>
    [char, Array.from({length: 7}, (_, i) => parseInt(rows.slice(i * 2, i * 2 + 2), 16))]
  ));

  function integer(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) throw new TypeError("Drawing coordinates must be finite numbers");
    return Math.trunc(n);
  }

  function rgb(color) {
    const n = integer(color) >>> 0;
    return n > 0xffff ? [(n >>> 16) & 255, (n >>> 8) & 255, n & 255] :
      [Math.floor(((n >>> 11) & 31) * 255 / 31),
        Math.floor(((n >>> 5) & 63) * 255 / 63), Math.floor((n & 31) * 255 / 31)];
  }

  class PixelRenderer {
    constructor(context, width, height) {
      this.context = context;
      this.width = width;
      this.height = height;
      this.image = context.createImageData(width, height);
      this.dirty = false;
      this.fill(rgb(0));
      this.present();
    }

    present() {
      if (!this.dirty) return;
      this.context.putImageData(this.image, 0, 0);
      this.dirty = false;
    }

    pixel(x, y, color) {
      if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
      const offset = (y * this.width + x) * 4;
      this.image.data[offset] = color[0];
      this.image.data[offset + 1] = color[1];
      this.image.data[offset + 2] = color[2];
      this.image.data[offset + 3] = 255;
      this.dirty = true;
    }

    fill(color) {
      this.fillRect(0, 0, this.width, this.height, color);
    }

    fillRect(x, y, width, height, color) {
      for (let row = Math.max(0, y); row < Math.min(this.height, y + height); row++) {
        for (let col = Math.max(0, x); col < Math.min(this.width, x + width); col++) {
          this.pixel(col, row, color);
        }
      }
    }

    line(x0, y0, x1, y1, color) {
      // Clip before Bresenham so off-screen lines cannot cause unbounded loops.
      const vx = x1 - x0, vy = y1 - y0;
      let start = 0, end = 1;
      const bounds = [[-vx, x0], [vx, this.width - 1 - x0],
        [-vy, y0], [vy, this.height - 1 - y0]];
      for (const [p, q] of bounds) {
        if (p === 0) {
          if (q < 0) return;
        } else {
          const t = q / p;
          if (p < 0) start = Math.max(start, t);
          else end = Math.min(end, t);
          if (start > end) return;
        }
      }
      x1 = Math.round(x0 + end * vx);
      y1 = Math.round(y0 + end * vy);
      x0 = Math.round(x0 + start * vx);
      y0 = Math.round(y0 + start * vy);
      const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
      const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
      let error = dx + dy;
      while (true) {
        this.pixel(x0, y0, color);
        if (x0 === x1 && y0 === y1) break;
        const twiceError = error * 2;
        if (twiceError >= dy) { error += dy; x0 += sx; }
        if (twiceError <= dx) { error += dx; y0 += sy; }
      }
    }

    rect(x, y, width, height, color) {
      if (width <= 0 || height <= 0) return;
      this.fillRect(x, y, width, 1, color);
      this.fillRect(x, y + height - 1, width, 1, color);
      this.fillRect(x, y, 1, height, color);
      this.fillRect(x + width - 1, y, 1, height, color);
    }

    spans(y, height, spanAt, color, filled) {
      for (let row = Math.max(0, y); row < Math.min(this.height, y + height); row++) {
        const index = row - y;
        const [left, right] = spanAt(index);
        if (filled || index === 0 || index === height - 1) {
          this.fillRect(left, row, right - left + 1, 1, color);
        } else {
          const before = spanAt(index - 1), after = spanAt(index + 1);
          const leftEnd = Math.max(left, before[0] - 1, after[0] - 1);
          const rightStart = Math.min(right, before[1] + 1, after[1] + 1);
          this.fillRect(left, row, leftEnd - left + 1, 1, color);
          this.fillRect(rightStart, row, right - rightStart + 1, 1, color);
        }
      }
    }

    circle(x, y, radius, color, filled) {
      if (radius < 0) return;
      this.spans(y - radius, radius * 2 + 1, row => {
        const dy = row - radius;
        const dx = Math.floor(Math.sqrt(Math.max(0, radius * radius - dy * dy)));
        return [x - dx, x + dx];
      }, color, filled);
    }

    roundRect(x, y, width, height, radius, color, filled) {
      if (width <= 0 || height <= 0) return;
      radius = Math.max(0, Math.min(radius, Math.floor((Math.min(width, height) - 1) / 2)));
      this.spans(y, height, row => {
        const dy = Math.max(radius - row, row - (height - radius - 1), 0);
        const inset = radius - Math.floor(Math.sqrt(Math.max(0, radius * radius - dy * dy)));
        return [x + inset, x + width - inset - 1];
      }, color, filled);
    }

    text(message) {
      const [value, anchorX, anchorY] = message.args;
      const size = Math.max(1, integer(message.textSize === undefined ? 1 : message.textSize));
      const lines = String(value).replace(/\r/g, "").split("\n");
      const color = rgb(message.textColor);
      const height = lines.length * 8 * size;
      let y = integer(anchorY);
      if (message.alignY === "middle") y -= Math.floor(height / 2);
      else if (message.alignY === "bottom") y -= height;
      for (const line of lines) {
        const chars = Array.from(line);
        let x = integer(anchorX);
        const width = chars.length * 6 * size;
        if (message.alignX === "center") x -= Math.floor(width / 2);
        else if (message.alignX === "right") x -= width;
        for (const char of chars) {
          const glyph = GLYPHS[char] || GLYPHS["?"];
          for (let row = 0; row < 7; row++) {
            for (let col = 0; col < 5; col++) {
              if (glyph[row] & (1 << (4 - col))) {
                this.fillRect(x + col * size, y + row * size, size, size, color);
              }
            }
          }
          x += 6 * size;
        }
        y += 8 * size;
      }
    }

    bitmap(x, y, data, width, height, color, background) {
      const bytes = Array.from(data || []);
      const stride = Math.ceil(width / 8);
      for (let row = Math.max(0, -y); row < Math.min(height, this.height - y); row++) {
        for (let col = Math.max(0, -x); col < Math.min(width, this.width - x); col++) {
          const bit = (bytes[row * stride + Math.floor(col / 8)] >>> (col % 8)) & 1;
          if (bit) this.pixel(x + col, y + row, color);
          else if (background !== undefined) this.pixel(x + col, y + row, background);
        }
      }
    }

    blit(source, x, y, transparent) {
      const sourceData = source.image.data;
      const transparentColor = transparent === undefined ? null : rgb(transparent);
      for (let sy = Math.max(0, -y); sy < Math.min(source.height, this.height - y); sy++) {
        for (let sx = Math.max(0, -x); sx < Math.min(source.width, this.width - x); sx++) {
          const sourceOffset = (sy * source.width + sx) * 4;
          const red = sourceData[sourceOffset];
          const green = sourceData[sourceOffset + 1];
          const blue = sourceData[sourceOffset + 2];
          if (transparentColor &&
              red === transparentColor[0] &&
              green === transparentColor[1] &&
              blue === transparentColor[2]) continue;
          this.pixel(x + sx, y + sy, [red, green, blue]);
        }
      }
    }

    render(message) {
      const args = message.args || [];
      if (message.op === "text") { this.text(message); return; }
      if (message.op === "clear") { this.fill(rgb(0)); return; }
      if (message.op === "fill") { this.fill(rgb(args[0])); return; }
      if (message.op === "xbitmap") {
        this.bitmap(integer(args[0]), integer(args[1]), args[2], integer(args[3]),
          integer(args[4]), rgb(args[5]), args[6] === undefined ? undefined : rgb(args[6]));
        return;
      }
      const a = args.map(integer);
      switch (message.op) {
        case "pixel": this.pixel(a[0], a[1], rgb(a[2])); break;
        case "line": this.line(a[0], a[1], a[2], a[3], rgb(a[4])); break;
        case "rect": this.rect(a[0], a[1], a[2], a[3], rgb(a[4])); break;
        case "fillRect": this.fillRect(a[0], a[1], a[2], a[3], rgb(a[4])); break;
        case "roundRect":
        case "fillRoundRect":
          this.roundRect(a[0], a[1], a[2], a[3], a[4], rgb(a[5]), message.op === "fillRoundRect");
          break;
        case "circle":
        case "fillCircle":
          this.circle(a[0], a[1], a[2], rgb(a[3]), message.op === "fillCircle");
          break;
        default: throw new Error("Unsupported drawing operation: " + message.op);
      }
    }
  }

  if (typeof module !== "undefined" && module.exports) module.exports = PixelRenderer;
  else globalThis.PixelRenderer = PixelRenderer;
})();
