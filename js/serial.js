/**
 * WebUSB Serial Communication for Game Boy Link Cable
 * Supports old (reconfigurable, TinyUSB, VID 0xCAFE) and new (GBLink, Zephyr, VID 0x2FE3) firmware.
 */

const fromHexString = hexString =>
    new Uint8Array(hexString.match(/.{1,2}/g).map(byte => parseInt(byte, 16)));

function buf2hex(buffer) {
    return [...new Uint8Array(buffer)].map(x => x.toString(16).padStart(2, '0')).join('');
}

const toHexString = bytes =>
    bytes.reduce((str, byte) => str + byte.toString(16).padStart(2, '0'), '');

// Check firmware version from USB device descriptor (bcdDevice)
// Available instantly on the device object — no USB transfers needed
function fwVersionAtLeast(device, minMajor, minMinor, minPatch) {
    if (!device) return false;
    const major = device.deviceVersionMajor || 0;
    const minor = device.deviceVersionMinor || 0;
    const patch = device.deviceVersionSubminor || 0;
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

// New firmware command constants (GBLink unified firmware, Zephyr)
const NEW_CMD = {
    SET_MODE:          0x00,
    CANCEL:            0x01,
    MODE_GB_LINK:      0x02,
    ENTER_GB_PRINTER:  0x03,  // Single-byte command — no second byte needed
    SET_VOLTAGE_5V:    0x41,
};

class Serial {
    constructor() {
        this.buffer = [];
        this.send_active = false;
        this.isNewFirmware = false;
        this.epCmdOut = null;  // Command OUT endpoint (new firmware only)
    }

    async setLed(r, g, b, on = true) {
        if (!this.ready || !fwVersionAtLeast(this.device, 1, 0, 6)) return false;
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
            { 'vendorId': 0xcafe }, // TinyUSB example (old reconfigurable firmware)
            { 'vendorId': 0x2FE3 }, // Zephyr default VID (new GBLink firmware)
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

                    // Sort endpoints by number so we reliably get EP1 before EP2
                    const inEps = elementalt.endpoints
                        .filter(ep => ep.direction === 'in')
                        .sort((a, b) => a.endpointNumber - b.endpointNumber);
                    const outEps = elementalt.endpoints
                        .filter(ep => ep.direction === 'out')
                        .sort((a, b) => a.endpointNumber - b.endpointNumber);

                    if (this.isNewFirmware && inEps.length >= 2 && outEps.length >= 2) {
                        // EP1 OUT = command endpoint (sends commands to firmware)
                        // EP2 OUT = data endpoint (sends SPI data)
                        // EP2 IN  = data endpoint (receives printer data / SPI results)
                        this.epCmdOut = outEps[0].endpointNumber;
                        this.epOut = outEps[1].endpointNumber;
                        this.epIn = inEps[1].endpointNumber;
                        console.log(`New firmware endpoints: cmd=EP${this.epCmdOut} data=EP${this.epOut}/EP${this.epIn}`);
                    } else {
                        // Old firmware: single in/out pair
                        elementalt.endpoints.forEach(elementendpoint => {
                            if (elementendpoint.direction === "out") {
                                this.epOut = elementendpoint.endpointNumber;
                            }
                            if (elementendpoint.direction === "in") {
                                this.epIn = elementendpoint.endpointNumber;
                            }
                        });
                    }
                }
            })
        })
    }

    // Send to command endpoint (new firmware) or data endpoint (old firmware)
    async sendCommand(data) {
        const buf = data instanceof Uint8Array ? data : new Uint8Array(data);
        if (this.isNewFirmware && this.epCmdOut != null) {
            await this.device.transferOut(this.epCmdOut, buf);
        } else {
            await this.device.transferOut(this.epOut, buf);
        }
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

                // Detect firmware type by Vendor ID
                this.isNewFirmware = (device.vendorId === 0x2FE3);
                console.log(this.isNewFirmware
                    ? 'New firmware (GBLink Unified, Zephyr) detected'
                    : `Old firmware (reconfigurable, TinyUSB) detected — VID 0x${device.vendorId.toString(16)}`);

                if (device.opened) {
                    try { await device.close(); } catch (e) { }
                }

                return dev.open();
            }).then(async () => {
                // Try to reset the device to clear stale OS state
                // (only for old firmware — the new firmware drops its
                //  USB connection on reset, breaking the session)
                if (!this.isNewFirmware && device.reset) {
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
                if (this.isNewFirmware) {
                    // New firmware: no CDC handshake needed — command endpoint is used directly
                    return;
                }

                // Old firmware: CDC stop/start handshake
                try {
                    await device.controlTransferOut({
                        'requestType': 'class',
                        'recipient': 'interface',
                        'request': 0x22,
                        'value': 0x00, // STOP — ensure firmware exits any previous mode
                        'index': this.ifNum
                    });
                    // Give firmware a moment to exit its loop and re-enter main loop
                    await new Promise(r => setTimeout(r, 100));
                } catch (e) {
                    console.warn("Force stop failed:", e);
                }

                return device.controlTransferOut({
                    'requestType': 'class',
                    'recipient': 'interface',
                    'request': 0x22,
                    'value': 0x01, // START
                    'index': this.ifNum
                });
            }).then(async () => {
                if (this.isNewFirmware) {
                    // Switch to 5V mode for Game Boy via command endpoint
                    console.log("Switching to 5V mode for Game Boy (new firmware)");
                    await this.sendCommand(new Uint8Array([NEW_CMD.SET_VOLTAGE_5V]));
                } else {
                    // Old firmware: check version then switch via magic packet
                    const fwVer = `${device.deviceVersionMajor}.${device.deviceVersionMinor}.${device.deviceVersionSubminor}`;
                    console.log("Firmware version (bcdDevice):", fwVer);

                    if (fwVersionAtLeast(device, 1, 0, 6)) {
                        console.log("Switching to 5V mode for Game Boy");
                        await device.transferOut(this.epOut, VSWITCH_5V_PACKET);
                        try {
                            await device.transferIn(this.epIn, 64);
                        } catch (e) { /* ack read is non-fatal */ }
                    }
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
                if (this.isNewFirmware) {
                    // New firmware: send cancel via command endpoint
                    await this.sendCommand(new Uint8Array([NEW_CMD.CANCEL]));
                } else {
                    // Old firmware: CDC stop control transfer
                    await this.device.controlTransferOut({
                        'requestType': 'class',
                        'recipient': 'interface',
                        'request': 0x22,
                        'value': 0x00,
                        'index': this.ifNum
                    });
                }
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
