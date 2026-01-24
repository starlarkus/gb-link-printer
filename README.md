# Game Boy Printer Web Client

A WebUSB-based Game Boy Printer emulator that runs entirely in your browser. Print photos from your Game Boy Camera directly to your computer.

## Features
- **WebUSB Support**: Connects directly to your Link Cable Adapter via the browser.
- **Printer Emulation**: Receives print data from the Game Boy Camera and other printer-enabled games.
- **Live Preview**: See images as they are printed.
- **Download**: Save your printed photos as PNGs.

## Requirements
- A USB Game Boy Link Cable adapter with the [reconfigurable firmware](https://github.com/starlarkus/gb-link-firmware-reconfigurable)
- A WebUSB-compatible browser (Chrome, Edge, Opera)

## How to Use
1.  **Flash Firmware**: Ensure your adapter is flashed with the reconfigurable firmware.
2.  **Open Client**: Open https://printer.gblink.io in a WebUSB-compatible browser. (or host locally)
    - You can serve this folder locally (e.g., `python3 -m http.server`) or host it on GitHub Pages.
3.  **Connect**: Click "Connect" and select your device.
4.  **Print**: Go to the "Print" menu on your Game Boy Camera and print a photo.
5.  **Download**: The image will appear on the screen! Download or View it in your browser.
