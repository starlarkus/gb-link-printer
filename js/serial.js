/**
 * WebUSB Serial Communication for Game Boy Link Cable
 */

const fromHexString = hexString =>
    new Uint8Array(hexString.match(/.{1,2}/g).map(byte => parseInt(byte, 16)));

function buf2hex(buffer) {
    return [...new Uint8Array(buffer)].map(x => x.toString(16).padStart(2, '0')).join('');
}

const toHexString = bytes =>
    bytes.reduce((str, byte) => str + byte.toString(16).padStart(2, '0'), '');

function fwVersionAtLeast(version, minMajor, minMinor, minPatch) {
    if (!version) return false;
    const parts = version.split('.').map(Number);
    const [major = 0, minor = 0, patch = 0] = parts;
    if (major !== minMajor) return major > minMajor;
    if (minor !== minMinor) return minor > minMinor;
    return patch >= minPatch;
}

// Magic packet prefix (32 bytes shared by all magic packets)
const MAGIC_PREFIX = new Uint8Array([
    0xCA, 0xFE, 0xCA, 0xFE, 0xCA, 0xFE, 0xCA, 0xFE,
    0xCA, 0xFE, 0xCA, 0xFE, 0xCA, 0xFE, 0xCA, 0xFE,
    0xDE, 0xAD, 0xBE, 0xEF, 0xDE, 0xAD, 0xBE, 0xEF,
    0xDE, 0xAD, 0xBE, 0xEF, 0xDE, 0xAD, 0xBE, 0xEF
]);

function buildVswitchPacket(suffix) {
    const packet = new Uint8Array(36);
    packet.set(MAGIC_PREFIX);
    packet.set(new TextEncoder().encode(suffix), 32);
    return packet;
}

const VSWITCH_5V_PACKET = buildVswitchPacket('V5V0');

// LED magic packet: 32-byte prefix + "LEDS" + R, G, B, on/off = 40 bytes
const LED_PREFIX = new Uint8Array([
    ...MAGIC_PREFIX,
    0x4C, 0x45, 0x44, 0x53  // "LEDS"
]);

function buildLedPacket(r, g, b, on) {
    const packet = new Uint8Array(40);
    packet.set(LED_PREFIX);
    packet[36] = r;
    packet[37] = g;
    packet[38] = b;
    packet[39] = on ? 1 : 0;
    return packet;
}

class Serial {
    constructor() {
        this.buffer = [];
        this.send_active = false;
        this.firmwareVersion = null;
    }

    async setLed(r, g, b, on = true) {
        if (!this.ready || !fwVersionAtLeast(this.firmwareVersion, 1, 0, 6)) return false;
        const packet = buildLedPacket(r, g, b, on);
        await this.device.transferOut(this.epOut, packet);
        try {
            await Promise.race([
                this.device.transferIn(this.epIn, 64),
                new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 500))
            ]);
        } catch (e) { /* ack timeout is non-fatal */ }
        return true;
    }

    static getPorts() {
        return navigator.usb.getDevices().then(devices => {
            return devices;
        });
    }

    static requestPort() {
        const filters = [
            { 'vendorId': 0x239A }, // Adafruit boards
            { 'vendorId': 0xcafe }, // TinyUSB example
        ];
        return navigator.usb.requestDevice({ 'filters': filters }).then(
            device => {
                return device;
            }
        );
    }

    getEndpoints(interfaces) {
        interfaces.forEach(element => {
            var alternates = element.alternates;
            alternates.forEach(elementalt => {
                if (elementalt.interfaceClass === 0xFF) {
                    this.ifNum = element.interfaceNumber;
                    elementalt.endpoints.forEach(elementendpoint => {
                        if (elementendpoint.direction === "out") {
                            this.epOut = elementendpoint.endpointNumber;
                        }
                        if (elementendpoint.direction === "in") {
                            this.epIn = elementendpoint.endpointNumber;
                        }
                    });
                }
            })
        })
    }

    async getDevice() {
        let device = null;
        this.ready = false;

        // Clean up any previously paired devices
        try {
            const existingDevices = await navigator.usb.getDevices();
            for (const dev of existingDevices) {
                if (dev.opened) {
                    try { await dev.close(); } catch (e) { }
                }
            }
        } catch (e) { }

        return new Promise((resolve, reject) => {
            Serial.requestPort().then(async (dev) => {
                device = dev;
                this.device = device;

                if (device.opened) {
                    try { await device.close(); } catch (e) { }
                }

                return dev.open();
            }).then(async () => {
                // Try to reset the device to clear stale OS state
                if (device.reset) {
                    await device.reset().catch(e => {
                        console.warn("Device reset failed (non-fatal):", e);
                    });
                }
                return device.selectConfiguration(1);
            }).then(() => {
                if (!device.configuration) throw new Error("No configuration selected");
                this.getEndpoints(device.configuration.interfaces);
                if (this.ifNum === undefined) throw new Error("No Vendor Interface (Class 0xFF) found");
                return device.claimInterface(this.ifNum);
            }).then(() => {
                return device.selectAlternateInterface(this.ifNum, 0);
            }).then(async () => {
                // FORCE FIRMWARE RESET:
                // Send "Stop" (0x00) first to ensure firmware cleanly exits any previous mode loop.
                // We do this AFTER claiming the interface so controlTransferOut works without error.
                try {
                    await device.controlTransferOut({
                        'requestType': 'class',
                        'recipient': 'interface',
                        'request': 0x22,
                        'value': 0x00, // STOP
                        'index': this.ifNum
                    });
                    // Give firmware a moment to exit its loop and re-enter main loop
                    await new Promise(r => setTimeout(r, 100));
                } catch (e) {
                    console.warn("Force stop failed:", e);
                }

                // Send "Start" (0x01) to begin communication
                return device.controlTransferOut({
                    'requestType': 'class',
                    'recipient': 'interface',
                    'request': 0x22,
                    'value': 0x01, // START
                    'index': this.ifNum
                })
            }).then(async () => {
                // Read firmware version string (new firmware sends "GBLINK:x.x.x\n" on connect)
                try {
                    const result = await Promise.race([
                        device.transferIn(this.epIn, 64),
                        new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 500))
                    ]);
                    if (result.status === 'ok' && result.data && result.data.byteLength > 0) {
                        const str = new TextDecoder().decode(result.data);
                        if (str.startsWith('GBLINK:')) {
                            this.firmwareVersion = str.trim().substring(7);
                            console.log("Firmware version:", this.firmwareVersion);
                        }
                    }
                } catch (e) {
                    console.log("No firmware version (old firmware)");
                }

                // Switch to 5V mode for Game Boy (printer is always GB)
                if (fwVersionAtLeast(this.firmwareVersion, 1, 0, 6)) {
                    await device.transferOut(this.epOut, VSWITCH_5V_PACKET);
                    try {
                        await Promise.race([
                            device.transferIn(this.epIn, 64),
                            new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 500))
                        ]);
                    } catch (e) { /* ack timeout is non-fatal */ }
                }

                this.ready = true;
                this.device = device;
                resolve();
            }).catch(err => {
                console.error("Device connection error:", err);
                reject(err);
            });
        });
    }

    async disconnect() {
        if (this.device && this.device.opened) {
            try {
                await this.device.controlTransferOut({
                    'requestType': 'class',
                    'recipient': 'interface',
                    'request': 0x22,
                    'value': 0x00,
                    'index': this.ifNum
                });
                await this.device.releaseInterface(this.ifNum);
                await this.device.close();
            } catch (e) {
                console.log("Disconnect error:", e);
            }
        }
        this.ready = false;
    }

    read(num) {
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(function () {
                reject('Read timeout');
            }, 5000);
            this.device.transferIn(this.epIn, num).then(result => {
                clearTimeout(timeout);
                resolve(result);
            },
                error => {
                    clearTimeout(timeout);
                    console.error(error)
                    reject(error);
                });
        });
    }

    send(data) {
        return this.device.transferOut(this.epOut, data);
    }

    sendByte(byte) {
        return this.send(new Uint8Array([byte]));
    }

    // Exchange a single byte - send and receive simultaneously
    async exchangeByte(byteToSend) {
        await this.send(new Uint8Array([byteToSend]));
        const result = await this.read(1);
        if (result.data.byteLength > 0) {
            return result.data.getUint8(0);
        }
        return null;
    }
}
