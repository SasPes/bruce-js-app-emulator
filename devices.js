// Supported devices: screen size, chip, battery capacity (mAh, 0 = none), flash and PSRAM (MB, 0 = none).
// Drives the device dropdown and the simulated device, battery and memory readings.
window.DEVICES = [
  {name: "Bruce Reaper RF", screen: [320, 170], esp: "ESP32-S3 N16R8", battery: 1000, flash: 16, psram: 8},
  {name: "M5Stack Cardputer", screen: [240, 135], esp: "ESP32-S3FN8", battery: 1520, flash: 8, psram: 0},
  {name: "M5Stack Cardputer Adv", screen: [240, 135], esp: "ESP32-S3FN8", battery: 1750, flash: 8, psram: 0},
  {name: "M5Stack StickS3", screen: [240, 135], esp: "ESP32-S3-PICO-1-N8R8", battery: 250, flash: 8, psram: 8},
  {name: "M5Stack StickC-Plus 2", screen: [240, 135], esp: "ESP32-PICO-V3-02", battery: 200, flash: 8, psram: 2},
  {name: "M5Stack StickC-Plus 1.1", screen: [240, 135], esp: "ESP32-PICO-D4", battery: 120, flash: 4, psram: 0},
  {name: "Lilygo T-Watch-S3", screen: [240, 240], esp: "ESP32-S3FN16R8", battery: 1500, flash: 16, psram: 8},
  {name: "Lilygo T-Embed CC1101", screen: [320, 170], esp: "ESP32-S3-WROOM-1U", battery: 1300, flash: 16, psram: 8},
  {name: "Lilygo T-Embed CC1101 Plus", screen: [320, 170], esp: "ESP32-S3-WROOM-1U", battery: 1300, flash: 16, psram: 8},
  {name: "Lilygo T-Display-S3", screen: [320, 170], esp: "ESP32-S3FN16R8", battery: 0, flash: 16, psram: 8},
  {name: "Smoochiee V2", screen: [320, 170], esp: "ESP32-S3-WROOM-1 NR16R8", battery: 0, flash: 16, psram: 8},
  {name: "ESP32-C5", screen: [320, 170], esp: "ESP32-C5-WROOM-1 MCN8R4", battery: 0, flash: 16, psram: 8},
  {name: "M5Stack Core", screen: [320, 240], esp: "ESP32-D0WDQ6-V3", battery: 110, flash: 16, psram: 0},
  {name: "M5Stack Core2", screen: [320, 240], esp: "ESP32-D0WDQ6-V3", battery: 390, flash: 16, psram: 8},
  {name: "M5Stack CoreS3/SE", screen: [320, 240], esp: "ESP32-S3", battery: 0, flash: 16, psram: 8},
  {name: "CYD-2432S028", screen: [320, 240], esp: "ESP32-WROOM-32", battery: 0, flash: 4, psram: 0},
  {name: "Lilygo T-Deck (and Pro)", screen: [320, 240], esp: "ESP32-S3FN16R8", battery: 2000, flash: 16, psram: 8},
  {name: "Elecrow 24B", screen: [320, 240], esp: "ESP32-WROOM-32", battery: 0, flash: 16, psram: 8},
  {name: "Elecrow Advance-35-s3", screen: [320, 240], esp: "ESP32-S3", battery: 0, flash: 16, psram: 8},
  {name: "Lilygo T-LoRa Pager", screen: [480, 222], esp: "ESP32-S3", battery: 1500, flash: 16, psram: 8},
  {name: "CYD-3248S035", screen: [480, 320], esp: "ESP32-WROOM-32", battery: 0, flash: 4, psram: 0}
];
window.DEFAULT_DEVICE = "Lilygo T-Embed CC1101";
