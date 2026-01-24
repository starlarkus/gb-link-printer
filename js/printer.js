/**
 * Game Boy Printer Protocol Implementation
 * Handles printer data from firmware (protocol is handled in firmware)
 * 
 * Works with gb-link-firmware-reconfigurable in PRINTER MODE
 */

// Printer mode magic sequence (must match firmware)
const PRINTER_MODE_MAGIC = new Uint8Array([
    0xCA, 0xFE, 0xCA, 0xFE, 0xCA, 0xFE, 0xCA, 0xFE,
    0xCA, 0xFE, 0xCA, 0xFE, 0xCA, 0xFE, 0xCA, 0xFE,
    0xDE, 0xAD, 0xBE, 0xEF, 0xDE, 0xAD, 0xBE, 0xEF,
    0xDE, 0xAD, 0xBE, 0xEF, 0xDE, 0xAD, 0xBE, 0xEF,
    0x50, 0x52, 0x4E, 0x54  // "PRNT"
]);

// Printer commands
const PrinterCommand = {
    INIT: 0x01,
    PRINT: 0x02,
    DATA: 0x04,
    BREAK: 0x08,
    INQUIRY: 0x0F
};

// Parser states for structured firmware data
const ParserState = {
    WAIT_START: 0,
    WAIT_COMMAND: 1,
    WAIT_COMPRESSION: 2,
    WAIT_LEN_LOW: 3,
    WAIT_LEN_HIGH: 4,
    READ_DATA: 5
};

// Palette for 2bpp tiles (GB Camera style)
const PALETTE = [
    [255, 255, 255], // White (lightest)
    [170, 170, 170], // Light gray
    [85, 85, 85],    // Dark gray
    [0, 0, 0]        // Black (darkest)
];

class GameBoyPrinter {
    constructor() {
        this.serial = null;
        this.running = false;
        this.printData = [];
        this.totalBytesReceived = 0;
        this.imageCount = 0;

        // Parser state for firmware data stream
        this.parserState = ParserState.WAIT_COMMAND;
        this.currentCommand = 0;
        this.currentCompression = 0;
        this.currentLength = 0;
        this.currentDataIndex = 0;
        this.currentPacketData = [];
        this.lastDataTime = 0;  // Timestamp of last data received
        this.recentBytes = [];  // Buffer for detecting "RESET" marker from firmware

        // UI elements
        this.statusText = document.getElementById('status-text');
        this.dataReceived = document.getElementById('data-received');
        this.canvasContainer = document.getElementById('canvas-container');
        this.downloadAllBtn = document.getElementById('btn-download-all');

        this.bindEvents();
    }

    bindEvents() {
        document.getElementById('btn-connect').addEventListener('click', () => this.connect());
        document.getElementById('btn-disconnect').addEventListener('click', () => this.disconnect());
        document.getElementById('btn-retry').addEventListener('click', () => this.showScreen('connect'));
        document.getElementById('btn-download-all').addEventListener('click', () => this.downloadAllImages());
    }

    showScreen(screenId) {
        document.querySelectorAll('.screen').forEach(s => s.style.display = 'none');
        const screen = document.getElementById('screen-' + screenId);
        if (screen) {
            screen.style.display = 'block';
        }
    }

    showError(message) {
        document.getElementById('error-message').textContent = message;
        this.showScreen('error');
    }

    updateStatus(text, className = 'status-idle') {
        this.statusText.textContent = 'Status: ' + text;
        this.statusText.className = className;
    }

    updateDataCount() {
        this.dataReceived.textContent = `Data received: ${this.totalBytesReceived} bytes | Print buffer: ${this.printData.length} bytes`;
    }

    async connect() {
        this.showScreen('connecting');

        try {
            this.serial = new Serial();
            await this.serial.getDevice();

            // Send printer mode magic sequence
            this.updateStatus('Activating printer mode...', 'status-receiving');
            await this.serial.send(PRINTER_MODE_MAGIC);

            // Wait for acknowledgment (0x50 = 'P')
            const ackResult = await this.serial.read(1);
            if (ackResult.data.byteLength > 0) {
                const ack = ackResult.data.getUint8(0);
                if (ack !== 0x50) {
                    console.warn("Unexpected printer mode ack:", ack);
                }
            }

            this.showScreen('ready');
            this.updateStatus('Waiting for Game Boy...', 'status-idle');
            this.running = true;

            // Start reading data from firmware
            this.printerLoop();

        } catch (err) {
            console.error('Connection error:', err);
            this.showError('Failed to connect: ' + err.message);
        }
    }

    async disconnect() {
        this.running = false;

        if (this.serial) {
            await this.serial.disconnect();
            this.serial = null;
        }

        this.showScreen('connect');
    }

    async printerLoop() {
        const PRINT_TIMEOUT_MS = 2000;  // Reset if no data for 2 seconds during a print

        while (this.running && this.serial && this.serial.ready) {
            try {
                // Read bytes from firmware (it handles the GB protocol)
                const result = await this.serial.read(64);

                if (result.data.byteLength > 0) {
                    const bytes = new Uint8Array(result.data.buffer);
                    this.lastDataTime = Date.now();

                    for (let i = 0; i < bytes.length; i++) {
                        this.processFirmwareByte(bytes[i]);
                        this.totalBytesReceived++;
                    }

                    this.updateDataCount();
                }

            } catch (err) {
                if (this.running) {
                    // Timeout is expected when waiting for GB to print
                    if (!err.toString().includes('timeout')) {
                        console.error('Read error:', err);
                    }

                    // Check if we have stale partial data (print was canceled)
                    if (this.printData.length > 0 && this.lastDataTime > 0) {
                        const timeSinceLastData = Date.now() - this.lastDataTime;
                        if (timeSinceLastData > PRINT_TIMEOUT_MS) {
                            console.log(`Print timeout: discarding ${this.printData.length} bytes of incomplete data`);
                            this.printData = [];
                            this.parserState = ParserState.WAIT_COMMAND;
                            this.currentPacketData = [];
                            this.updateStatus('Print canceled - ready', 'status-idle');
                        }
                    }

                    await new Promise(r => setTimeout(r, 50));
                }
            }
        }
    }

    processFirmwareByte(byte) {
        // Check for "ABORTPRINT" abort marker from firmware (10 ASCII bytes)
        // Keep a sliding window of recent bytes to detect the sequence
        this.recentBytes.push(byte);
        if (this.recentBytes.length > 10) {
            this.recentBytes.shift();
        }

        // Check if recent bytes spell "ABORTPRINT"
        const abortMarker = [0x41, 0x42, 0x4F, 0x52, 0x54, 0x50, 0x52, 0x49, 0x4E, 0x54];
        // A=0x41, B=0x42, O=0x4F, R=0x52, T=0x54, P=0x50, R=0x52, I=0x49, N=0x4E, T=0x54
        if (this.recentBytes.length === 10 &&
            this.recentBytes.every((b, i) => b === abortMarker[i])) {
            console.log(`ABORTPRINT marker received: discarding ${this.printData.length} bytes, resetting parser`);
            this.printData = [];
            this.currentPacketData = [];
            this.recentBytes = [];
            this.parserState = ParserState.WAIT_COMMAND;
            this.updateStatus('Print aborted - ready', 'status-idle');
            return;
        }

        // Parse structured data from firmware
        // IMPORTANT: Only check for 0xFF/0xFE markers in WAIT_COMMAND state!
        // These bytes can appear as normal bytes in image data
        switch (this.parserState) {
            case ParserState.WAIT_START:
                // Waiting for 0xFF start marker
                break;

            case ParserState.WAIT_COMMAND:
                // Check for protocol markers ONLY in this state
                // (these bytes can appear as data in other states)
                if (byte === 0xFF) {
                    // Start/reset marker from firmware
                    // Clear all buffers (handles both initial connect and print abort)
                    if (this.printData.length > 0) {
                        console.log(`Reset marker: discarding ${this.printData.length} bytes`);
                    }
                    this.printData = [];
                    this.currentPacketData = [];
                    this.updateStatus('Ready for print', 'status-idle');
                    return;
                }

                if (byte === 0xFE) {
                    // Print marker - render accumulated image data
                    if (this.printData.length > 0) {
                        this.renderImage(this.printData);
                        this.printData = [];
                    }
                    return;
                }

                // Skip sync bytes
                if (byte === 0x88 || byte === 0x33) {
                    return;
                }

                // Only accept valid printer commands - reject everything else
                // This prevents image data from being misinterpreted as commands
                const validCommands = [
                    PrinterCommand.INIT,      // 0x01
                    PrinterCommand.PRINT,     // 0x02
                    PrinterCommand.DATA,      // 0x04
                    PrinterCommand.BREAK,     // 0x08
                    PrinterCommand.INQUIRY    // 0x0F
                ];

                if (!validCommands.includes(byte)) {
                    // Unknown byte - skip it and stay in WAIT_COMMAND
                    return;
                }


                this.currentCommand = byte;
                this.parserState = ParserState.WAIT_COMPRESSION;

                if (this.currentCommand === PrinterCommand.DATA) {
                    this.updateStatus('Receiving print data...', 'status-receiving');
                } else if (this.currentCommand === PrinterCommand.PRINT) {
                    this.updateStatus('Print command!', 'status-printing');
                } else if (this.currentCommand === PrinterCommand.INIT) {
                    this.printData = [];
                    this.updateStatus('Init - buffer cleared', 'status-receiving');
                } else if (this.currentCommand === PrinterCommand.INQUIRY) {
                    this.updateStatus('Status inquiry', 'status-idle');
                }
                break;

            case ParserState.WAIT_COMPRESSION:
                // Compression byte should only be 0x00 (uncompressed) or 0x01 (RLE)
                if (byte !== 0x00 && byte !== 0x01) {
                    // Invalid compression byte - parser is desynchronized
                    this.parserState = ParserState.WAIT_COMMAND;
                    return;
                }
                this.currentCompression = byte;
                this.parserState = ParserState.WAIT_LEN_LOW;
                break;

            case ParserState.WAIT_LEN_LOW:
                this.currentLength = byte;
                this.parserState = ParserState.WAIT_LEN_HIGH;
                break;

            case ParserState.WAIT_LEN_HIGH:
                this.currentLength |= (byte << 8);
                this.currentDataIndex = 0;
                this.currentPacketData = [];

                // Sanity check: max valid GB Printer data packet is 640 bytes
                // If we get a much larger value, the parser is desynchronized
                if (this.currentLength > 1000) {
                    console.warn(`Invalid packet length ${this.currentLength} - resetting parser`);
                    this.parserState = ParserState.WAIT_COMMAND;
                    return;
                }

                if (this.currentLength > 0) {
                    this.parserState = ParserState.READ_DATA;
                } else {
                    // No data in this packet (e.g., INQUIRY, INIT with no payload)
                    this.processPacket();
                    this.parserState = ParserState.WAIT_COMMAND;
                }
                break;

            case ParserState.READ_DATA:
                this.currentPacketData.push(byte);
                this.currentDataIndex++;

                if (this.currentDataIndex >= this.currentLength) {
                    this.processPacket();
                    this.parserState = ParserState.WAIT_COMMAND;
                }
                break;
        }
    }

    processPacket() {
        switch (this.currentCommand) {
            case PrinterCommand.INIT:
                // INIT signals the start of a new print session
                // Clear any stale data from a canceled print
                if (this.printData.length > 0) {
                    console.log(`INIT: clearing ${this.printData.length} bytes from previous incomplete print`);
                }
                this.printData = [];
                this.currentPacketData = [];
                this.updateStatus('Ready for print data', 'status-idle');
                break;

            case PrinterCommand.DATA:
                // Accumulate print data
                if (this.currentCompression === 0) {
                    // Uncompressed
                    this.printData.push(...this.currentPacketData);
                } else {
                    // RLE compressed
                    const decompressed = this.decompressRLE(this.currentPacketData);
                    this.printData.push(...decompressed);
                }
                console.log(`Print data accumulated: ${this.printData.length} bytes total`);
                this.updateStatus(`Receiving: ${this.printData.length} bytes`, 'status-receiving');
                break;

            case PrinterCommand.PRINT:
                this.updateStatus('Waiting for image...', 'status-printing');
                break;

            case PrinterCommand.INQUIRY:
                // Nothing to do for inquiry - just a status check
                break;
        }
    }

    decompressRLE(data) {
        const result = [];
        let i = 0;

        while (i < data.length) {
            const control = data[i++];

            if (control & 0x80) {
                const count = (control & 0x7F) + 2;
                const value = data[i++] || 0;
                for (let j = 0; j < count; j++) {
                    result.push(value);
                }
            } else {
                const count = control + 1;
                for (let j = 0; j < count && i < data.length; j++) {
                    result.push(data[i++]);
                }
            }
        }

        return result;
    }

    renderImage(data) {
        const tilesPerRow = 20;
        const bytesPerTile = 16;
        const totalTiles = Math.floor(data.length / bytesPerTile);
        const tileRows = Math.ceil(totalTiles / tilesPerRow);

        const width = tilesPerRow * 8;
        const height = tileRows * 8;

        console.log(`Rendering image: ${width}x${height} pixels, ${totalTiles} tiles`);

        const wrapper = document.createElement('div');
        wrapper.className = 'print-canvas-wrapper';

        const canvas = document.createElement('canvas');
        canvas.className = 'print-canvas';
        canvas.width = width;
        canvas.height = height;
        canvas.id = `print-${this.imageCount}`;

        const ctx = canvas.getContext('2d');
        const imageData = ctx.createImageData(width, height);
        const pixels = imageData.data;

        let tileIndex = 0;
        for (let tileY = 0; tileY < tileRows; tileY++) {
            for (let tileX = 0; tileX < tilesPerRow; tileX++) {
                if (tileIndex >= totalTiles) break;

                const tileOffset = tileIndex * bytesPerTile;
                this.decodeTile(data, tileOffset, pixels, width, tileX * 8, tileY * 8);
                tileIndex++;
            }
        }

        ctx.putImageData(imageData, 0, 0);

        wrapper.appendChild(canvas);

        const downloadBtn = document.createElement('button');
        downloadBtn.className = 'btn btn-sm btn-secondary';
        downloadBtn.textContent = 'Download';
        downloadBtn.style.marginTop = '0.5rem';
        downloadBtn.addEventListener('click', () => this.downloadImage(canvas, this.imageCount));
        wrapper.appendChild(downloadBtn);

        this.canvasContainer.appendChild(wrapper);
        this.imageCount++;

        this.downloadAllBtn.style.display = 'inline-block';
        this.updateStatus('Image received! Waiting for more...', 'status-idle');
    }

    decodeTile(data, offset, pixels, imageWidth, startX, startY) {
        for (let row = 0; row < 8; row++) {
            const byte1 = data[offset + row * 2] || 0;
            const byte2 = data[offset + row * 2 + 1] || 0;

            for (let col = 0; col < 8; col++) {
                const bit = 7 - col;
                const colorIndex = ((byte1 >> bit) & 1) | (((byte2 >> bit) & 1) << 1);
                const color = PALETTE[colorIndex];

                const x = startX + col;
                const y = startY + row;
                const pixelOffset = (y * imageWidth + x) * 4;

                pixels[pixelOffset] = color[0];
                pixels[pixelOffset + 1] = color[1];
                pixels[pixelOffset + 2] = color[2];
                pixels[pixelOffset + 3] = 255;
            }
        }
    }

    downloadImage(canvas, index) {
        const link = document.createElement('a');
        link.download = `gameboy-print-${index + 1}.png`;
        link.href = canvas.toDataURL('image/png');
        link.click();
    }

    downloadAllImages() {
        const canvases = this.canvasContainer.querySelectorAll('canvas');
        canvases.forEach((canvas, index) => {
            setTimeout(() => this.downloadImage(canvas, index), index * 100);
        });
    }
}

// Initialize when page loads
document.addEventListener('DOMContentLoaded', () => {
    if (!navigator.usb) {
        document.getElementById('screen-no-webusb').style.display = 'block';
        return;
    }

    document.getElementById('screen-connect').style.display = 'block';
    window.printer = new GameBoyPrinter();
});
