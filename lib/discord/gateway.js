// Discord Gateway v10 client (JSON encoding) on top of the zero-dep ws.js.
// Handles HELLO/heartbeat, IDENTIFY, RESUME, reconnect with backoff.
// Emits: 'ready' (user), 'interaction' (d), 'message' (d), 'guild' (d),
//        'dispatch' ({t,d}), 'fatal' (err).

const { WebSocketClient } = require('./ws');
const { EventEmitter } = require('events');

const GATEWAY_URL = 'wss://gateway.discord.gg/?v=10&encoding=json';

const OP = {
  DISPATCH: 0, HEARTBEAT: 1, IDENTIFY: 2, RESUME: 6, RECONNECT: 7,
  INVALID_SESSION: 9, HELLO: 10, HEARTBEAT_ACK: 11,
};

class Gateway extends EventEmitter {
  constructor(opts) {
    super();
    this.token = opts.token;
    this.intents = opts.intents ?? 0;
    this.ws = null;
    this.seq = null;
    this.sessionId = null;
    this.resumeUrl = null;
    this.hbTimer = null;
    this.hbInitTimer = null;
    this.hbAcked = true;
    this.reconnectDelay = 1000;
    this._stopped = false;
  }

  connect() {
    this._stopped = false;
    const url = this.resumeUrl || GATEWAY_URL;
    try {
      this.ws = new WebSocketClient(url);
    } catch (e) { this.emit('fatal', e); return; }

    this.ws.on('open', () => { /* wait for HELLO */ });
    this.ws.on('message', (raw) => this._onMessage(raw));
    this.ws.on('error', () => { /* surfaced via close */ });
    this.ws.on('close', (code) => this._onClose(code));
  }

  _onMessage(raw) {
    let p;
    try { p = JSON.parse(raw); } catch { return; }
    if (p.s != null) this.seq = p.s;

    switch (p.op) {
      case OP.HELLO:
        this._startHeartbeat(p.d.heartbeat_interval);
        if (this.sessionId && this.resumeUrl) this._resume();
        else this._identify();
        break;
      case OP.HEARTBEAT:
        this._sendHeartbeat();
        break;
      case OP.HEARTBEAT_ACK:
        this.hbAcked = true;
        this.reconnectDelay = 1000; // healthy connection resets backoff
        break;
      case OP.RECONNECT:
        this._reconnect(true);
        break;
      case OP.INVALID_SESSION:
        // p.d === true -> resumable; otherwise start fresh
        if (!p.d) { this.sessionId = null; this.resumeUrl = null; this.seq = null; }
        setTimeout(() => this._reconnect(Boolean(p.d)), 1500 + Math.random() * 3500);
        break;
      case OP.DISPATCH:
        this._onDispatch(p.t, p.d);
        break;
      default:
        break;
    }
  }

  _onDispatch(t, d) {
    if (t === 'READY') {
      this.sessionId = d.session_id;
      if (d.resume_gateway_url) this.resumeUrl = d.resume_gateway_url + '?v=10&encoding=json';
      this.emit('ready', d.user);
    } else if (t === 'INTERACTION_CREATE') {
      this.emit('interaction', d);
    } else if (t === 'MESSAGE_CREATE') {
      this.emit('message', d);
    } else if (t === 'GUILD_CREATE') {
      this.emit('guild', d);
    }
    this.emit('dispatch', { t, d });
  }

  _identify() {
    this._send({
      op: OP.IDENTIFY,
      d: {
        token: this.token,
        intents: this.intents,
        properties: { os: process.platform, browser: 'bounty-bot', device: 'bounty-bot' },
      },
    });
  }

  _resume() {
    this._send({ op: OP.RESUME, d: { token: this.token, session_id: this.sessionId, seq: this.seq } });
  }

  _startHeartbeat(interval) {
    clearInterval(this.hbTimer);
    clearTimeout(this.hbInitTimer);
    this.hbAcked = true;
    // initial jitter (tracked so it can be cleared on reconnect/close)
    this.hbInitTimer = setTimeout(() => this._sendHeartbeat(), Math.random() * interval);
    this.hbTimer = setInterval(() => {
      if (!this.hbAcked) { this._reconnect(true); return; } // zombie connection
      this._sendHeartbeat();
    }, interval);
  }

  _sendHeartbeat() {
    this.hbAcked = false;
    this._send({ op: OP.HEARTBEAT, d: this.seq });
  }

  _send(obj) {
    try { this.ws && this.ws.send(JSON.stringify(obj)); } catch {}
  }

  _onClose(code) {
    clearInterval(this.hbTimer);
    clearTimeout(this.hbInitTimer);
    if (this._stopped) return;
    // 4004 auth failed / 4013-4014 bad intents are fatal
    if ([4004, 4010, 4011, 4012, 4013, 4014].includes(code)) {
      this.emit('fatal', new Error('gateway closed with fatal code ' + code));
      return;
    }
    const resumable = ![4007, 4009].includes(code); // try resume unless session invalid
    if (!resumable) { this.sessionId = null; this.resumeUrl = null; this.seq = null; }
    setTimeout(() => this._reconnect(resumable), this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000);
  }

  _reconnect(resume) {
    clearInterval(this.hbTimer);
    clearTimeout(this.hbInitTimer);
    try { this.ws && this.ws.close(resume ? 4000 : 1000); } catch {}
    if (!resume) { this.sessionId = null; this.seq = null; this.resumeUrl = null; }
    this.connect();
  }

  stop() {
    this._stopped = true;
    clearInterval(this.hbTimer);
    clearTimeout(this.hbInitTimer);
    try { this.ws && this.ws.close(1000); } catch {}
  }
}

module.exports = { Gateway, OP };
