/**
 * WebSerial backend with the same public API as Serial (js/serial.js).
 *
 * Frame format (matches GBLink firmware SerialLayer):
 *   | 0x47 0x42 | channel:1 | len:2 LE | payload[len] |
 *     sync 'GB'   0=cmd,1=data,2=status
 */

const SWS_SYNC0 = 0x47;
const SWS_SYNC1 = 0x42;
const SWS_CH_CMD = 0x00;
const SWS_CH_DATA = 0x01;
const SWS_MAX_PAYLOAD = 64;

const SWS_NEW_CMD = {
    SET_MODE:         0x00,
    CANCEL:           0x01,
    MODE_GB_LINK:     0x02,
    ENTER_GB_PRINTER: 0x03,
    SET_VOLTAGE_5V:   0x41,
};

class SerialWS {
    constructor() {
        this.buffer = [];
        this.send_active = false;
        this.isNewFirmware = true;
        this.ready = false;

        this.port = null;
        this.reader = null;
        this.writer = null;

        this._dataQueue = [];
        this._dataWaiters = [];

        this._rxState = 'sync1';
        this._rxChannel = 0;
        this._rxLen = 0;
        this._rxBuf = null;
        this._rxPos = 0;
    }

    static requestPort() {
        return navigator.serial.requestPort({
            filters: [{ usbVendorId: 0x2FE3 }]
        });
    }

    async getDevice() {
        this.ready = false;
        this.port = await SerialWS.requestPort();
        await this.port.open({ baudRate: 115200 });
        this.writer = this.port.writable.getWriter();
        this.reader = this.port.readable.getReader();
        this._runReadLoop();

        // Game Boy hardware needs 5V on the link cable
        await this.sendCommand(new Uint8Array([SWS_NEW_CMD.SET_VOLTAGE_5V]));
        this.ready = true;
    }

    async disconnect() {
        this.ready = false;
        try {
            if (this.writer) {
                try { await this.sendCommand(new Uint8Array([SWS_NEW_CMD.CANCEL])); } catch (_) {}
            }
        } catch (_) {}
        try {
            if (this.reader) {
                try { await this.reader.cancel(); } catch (_) {}
                try { this.reader.releaseLock(); } catch (_) {}
                this.reader = null;
            }
            if (this.writer) {
                try { this.writer.releaseLock(); } catch (_) {}
                this.writer = null;
            }
            if (this.port) {
                try { await this.port.close(); } catch (_) {}
                this.port = null;
            }
        } catch (e) {
            console.log('Disconnect error:', e);
        }
        for (const w of this._dataWaiters) w.reject('Disconnected');
        this._dataWaiters = [];
        this._dataQueue = [];
    }

    async _runReadLoop() {
        try {
            while (this.reader) {
                const { value, done } = await this.reader.read();
                if (done) break;
                if (!value || value.length === 0) continue;
                for (let i = 0; i < value.length; i++) this._feedByte(value[i]);
            }
        } catch (e) {
            if (this.ready) console.warn('Read loop error:', e);
        }
    }

    _feedByte(b) {
        switch (this._rxState) {
            case 'sync1':
                if (b === SWS_SYNC0) this._rxState = 'sync2';
                break;
            case 'sync2':
                if (b === SWS_SYNC1) this._rxState = 'channel';
                else if (b === SWS_SYNC0) this._rxState = 'sync2';
                else this._rxState = 'sync1';
                break;
            case 'channel':
                this._rxChannel = b;
                this._rxState = 'lenLo';
                break;
            case 'lenLo':
                this._rxLen = b;
                this._rxState = 'lenHi';
                break;
            case 'lenHi':
                this._rxLen |= b << 8;
                if (this._rxLen > SWS_MAX_PAYLOAD) { this._rxState = 'sync1'; break; }
                this._rxPos = 0;
                this._rxBuf = new Uint8Array(this._rxLen);
                if (this._rxLen === 0) {
                    this._dispatchFrame();
                    this._rxState = 'sync1';
                } else {
                    this._rxState = 'payload';
                }
                break;
            case 'payload':
                this._rxBuf[this._rxPos++] = b;
                if (this._rxPos >= this._rxLen) {
                    this._dispatchFrame();
                    this._rxState = 'sync1';
                }
                break;
        }
    }

    _dispatchFrame() {
        if (this._rxChannel !== SWS_CH_DATA) return;
        const frame = this._rxBuf;
        const waiter = this._dataWaiters.shift();
        if (waiter) waiter.resolve(frame);
        else this._dataQueue.push(frame);
    }

    async _writeFrame(channel, payload) {
        if (!this.writer) throw new Error('Not connected');
        if (payload.length > SWS_MAX_PAYLOAD) throw new Error('Payload too large');
        const frame = new Uint8Array(5 + payload.length);
        frame[0] = SWS_SYNC0;
        frame[1] = SWS_SYNC1;
        frame[2] = channel;
        frame[3] = payload.length & 0xFF;
        frame[4] = (payload.length >> 8) & 0xFF;
        frame.set(payload, 5);
        await this.writer.write(frame);
    }

    async sendCommand(data) {
        const buf = data instanceof Uint8Array ? data : new Uint8Array(data);
        await this._writeFrame(SWS_CH_CMD, buf);
    }

    send(data) {
        return this._writeFrame(SWS_CH_DATA, data);
    }

    sendByte(byte) {
        return this.send(new Uint8Array([byte]));
    }

    // Returns WebUSB-shaped {data: DataView} so callers using result.data.buffer
    // and result.data.byteLength keep working.
    async read(num) {
        const frame = await new Promise((resolve, reject) => {
            if (this._dataQueue.length > 0) { resolve(this._dataQueue.shift()); return; }
            const waiter = { resolve, reject };
            this._dataWaiters.push(waiter);
            setTimeout(() => {
                const idx = this._dataWaiters.indexOf(waiter);
                if (idx !== -1) {
                    this._dataWaiters.splice(idx, 1);
                    reject('Read timeout');
                }
            }, 5000);
        });
        return { data: new DataView(frame.buffer, frame.byteOffset, frame.byteLength) };
    }

    async exchangeByte(byteToSend) {
        await this.send(new Uint8Array([byteToSend]));
        const result = await this.read(1);
        if (result.data.byteLength > 0) {
            return result.data.getUint8(0);
        }
        return null;
    }
}
