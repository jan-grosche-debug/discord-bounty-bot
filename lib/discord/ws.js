// Minimal RFC 6455 WebSocket client (text frames, TLS/wss only).
// Zero-dependency — uses Node's built-in `tls` and `crypto`.
// Enough to talk to the Discord gateway: handshake, fragmentation, ping/pong,
// close. Emits: 'open', 'message' (string), 'close' (code), 'error'.

const tls = require('tls');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const OP = { CONT: 0x0, TEXT: 0x1, BIN: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa };

class WebSocketClient extends EventEmitter {
  constructor(url) {
    super();
    const u = new URL(url);
    if (u.protocol !== 'wss:') throw new Error('only wss:// supported');
    this.host = u.hostname;
    this.port = u.port ? Number(u.port) : 443;
    this.path = (u.pathname || '/') + (u.search || '');
    this.socket = null;
    this._buf = Buffer.alloc(0);
    this._handshakeDone = false;
    this._closed = false;
    this._frag = [];          // assembling a fragmented message
    this._fragOpcode = null;
    this._connect();
  }

  _connect() {
    const key = crypto.randomBytes(16).toString('base64');
    this._expectedAccept = crypto
      .createHash('sha1')
      .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
      .digest('base64');

    this.socket = tls.connect({ host: this.host, port: this.port, servername: this.host }, () => {
      const req =
        `GET ${this.path} HTTP/1.1\r\n` +
        `Host: ${this.host}\r\n` +
        `Upgrade: websocket\r\n` +
        `Connection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${key}\r\n` +
        `Sec-WebSocket-Version: 13\r\n\r\n`;
      this.socket.write(req);
    });

    this.socket.on('data', (d) => this._onData(d));
    this.socket.on('error', (e) => this.emit('error', e));
    this.socket.on('close', () => {
      if (!this._closed) { this._closed = true; this.emit('close', 1006); }
    });
  }

  _onData(chunk) {
    this._buf = Buffer.concat([this._buf, chunk]);
    if (!this._handshakeDone) {
      const idx = this._buf.indexOf('\r\n\r\n');
      if (idx === -1) return;
      const header = this._buf.slice(0, idx).toString('utf8');
      this._buf = this._buf.slice(idx + 4);
      const ok = /HTTP\/1\.1 101/i.test(header);
      const acceptMatch = header.match(/sec-websocket-accept:\s*(.+)\r?\n/i);
      if (!ok) { this.emit('error', new Error('handshake failed: ' + header.split('\r\n')[0])); this._destroy(); return; }
      if (!acceptMatch || acceptMatch[1].trim() !== this._expectedAccept) {
        this.emit('error', new Error('bad or missing Sec-WebSocket-Accept')); this._destroy(); return;
      }
      this._handshakeDone = true;
      this.emit('open');
    }
    this._parseFrames();
  }

  _parseFrames() {
    while (true) {
      if (this._buf.length < 2) return;
      const b0 = this._buf[0];
      const b1 = this._buf[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let offset = 2;

      if (len === 126) {
        if (this._buf.length < offset + 2) return;
        len = this._buf.readUInt16BE(offset); offset += 2;
      } else if (len === 127) {
        if (this._buf.length < offset + 8) return;
        const big = this._buf.readBigUInt64BE(offset); offset += 8;
        len = Number(big);
      }
      let maskKey = null;
      if (masked) {
        if (this._buf.length < offset + 4) return;
        maskKey = this._buf.slice(offset, offset + 4); offset += 4;
      }
      if (this._buf.length < offset + len) return; // wait for full payload

      let payload = this._buf.slice(offset, offset + len);
      this._buf = this._buf.slice(offset + len);
      if (masked && maskKey) {
        const out = Buffer.allocUnsafe(payload.length);
        for (let i = 0; i < payload.length; i++) out[i] = payload[i] ^ maskKey[i & 3];
        payload = out;
      }

      this._handleFrame(fin, opcode, payload);
    }
  }

  _handleFrame(fin, opcode, payload) {
    if (opcode === OP.PING) { this._sendFrame(OP.PONG, payload); return; }
    if (opcode === OP.PONG) { return; }
    if (opcode === OP.CLOSE) {
      const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
      if (!this._closed) { this._closed = true; this.emit('close', code); }
      this._destroy();
      return;
    }
    // data frames (TEXT/BIN/CONT)
    if (opcode === OP.TEXT || opcode === OP.BIN) {
      if (fin) { this._emitMessage(payload); }
      else { this._frag = [payload]; this._fragOpcode = opcode; }
    } else if (opcode === OP.CONT) {
      if (this._frag.length === 0) return; // stray continuation (protocol error) — ignore
      this._frag.push(payload);
      if (fin) {
        const full = Buffer.concat(this._frag);
        this._frag = []; this._fragOpcode = null;
        this._emitMessage(full);
      }
    }
  }

  _emitMessage(buf) {
    this.emit('message', buf.toString('utf8'));
  }

  _sendFrame(opcode, payload) {
    if (!this.socket || this._closed) return;
    const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
    const len = data.length;
    let header;
    if (len <= 125) {
      header = Buffer.alloc(2);
      header[1] = 0x80 | len;
    } else if (len <= 0xffff) {
      header = Buffer.alloc(4);
      header[1] = 0x80 | 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    header[0] = 0x80 | opcode; // FIN + opcode
    const mask = crypto.randomBytes(4);
    const masked = Buffer.allocUnsafe(len);
    for (let i = 0; i < len; i++) masked[i] = data[i] ^ mask[i & 3];
    try { this.socket.write(Buffer.concat([header, mask, masked])); }
    catch (e) { this.emit('error', e); }
  }

  send(str) { this._sendFrame(OP.TEXT, Buffer.from(str, 'utf8')); }

  close(code = 1000) {
    if (this._closed) return;
    const body = Buffer.alloc(2); body.writeUInt16BE(code, 0);
    this._sendFrame(OP.CLOSE, body);
    this._closed = true;
    setTimeout(() => this._destroy(), 200);
  }

  _destroy() {
    try { this.socket && this.socket.destroy(); } catch {}
  }
}

module.exports = { WebSocketClient };
