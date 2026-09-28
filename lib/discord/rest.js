// Discord REST v10 client. Zero-dependency — uses Node's global fetch/FormData/Blob
// (Node >= 18). Handles rate limits (429) and transient 5xx with retries.

const API = 'https://discord.com/api/v10';

// Interaction callback types
const CALLBACK = {
  PONG: 1,
  CHANNEL_MESSAGE: 4,          // reply with a new message
  DEFERRED_CHANNEL_MESSAGE: 5, // ack, "thinking…"
  DEFERRED_UPDATE: 6,          // ack a component without editing
  UPDATE_MESSAGE: 7,           // edit the component's message
  MODAL: 9,                    // open a modal
};

// Message flags
const FLAG = { EPHEMERAL: 1 << 6 };

class Rest {
  constructor(token) {
    this.token = token;
    this._appId = null;
  }

  async _req(method, path, body, { auth = true, files = null } = {}) {
    const url = `${API}${path}`;
    let rateLimited = 0;
    for (let attempt = 0; attempt < 5; attempt++) {
      const headers = {};
      if (auth) headers.Authorization = `Bot ${this.token}`;

      let payload;
      if (files && files.length) {
        const form = new FormData();
        form.append('payload_json', JSON.stringify(body || {}));
        files.forEach((f, i) => {
          const blob = new Blob([f.content], { type: f.contentType || 'application/octet-stream' });
          form.append(`files[${i}]`, blob, f.filename);
        });
        payload = form; // fetch sets multipart boundary
      } else if (body !== undefined) {
        headers['Content-Type'] = 'application/json';
        payload = JSON.stringify(body);
      }

      let res;
      try {
        res = await fetch(url, { method, headers, body: payload });
      } catch (e) {
        if (attempt === 4) throw e;
        await sleep(500 * (attempt + 1));
        continue;
      }

      if (res.status === 429) {
        // prefer the precise JSON body retry_after (seconds, float); fall back to the
        // Retry-After response header (needed for non-JSON global limits), then 1s.
        const hdr = parseFloat(res.headers.get('retry-after'));
        const data = await res.json().catch(() => ({}));
        const retryAfter = (data && Number.isFinite(data.retry_after)) ? data.retry_after
          : (Number.isFinite(hdr) ? hdr : 1);
        await sleep(retryAfter * 1000 + 100);
        if (++rateLimited < 8) attempt--; // a rate-limit wait shouldn't burn the retry budget
        continue;
      }
      if (res.status >= 500 && res.status < 600) {
        await sleep(500 * (attempt + 1));
        continue;
      }
      if (res.status === 204) return null;
      const text = await res.text();
      const json = text ? safeJson(text) : null;
      if (!res.ok) {
        const err = new Error(`Discord ${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
        err.status = res.status; err.body = json;
        throw err;
      }
      return json;
    }
    throw new Error(`Discord ${method} ${path} → exhausted retries`);
  }

  async appId() {
    if (this._appId) return this._appId;
    const app = await this._req('GET', '/applications/@me');
    this._appId = app.id;
    return this._appId;
  }

  // ── Slash commands ─────────────────────────────────────────────
  async registerCommands(commands, guildId) {
    const appId = await this.appId();
    const path = guildId
      ? `/applications/${appId}/guilds/${guildId}/commands`
      : `/applications/${appId}/commands`;
    return this._req('PUT', path, commands);
  }

  // ── Interaction responses ──────────────────────────────────────
  respond(interaction, type, data) {
    return this._req(
      'POST',
      `/interactions/${interaction.id}/${interaction.token}/callback`,
      { type, data },
      { auth: false },
    );
  }

  async editOriginal(interaction, data) {
    const appId = await this.appId();
    return this._req('PATCH', `/webhooks/${appId}/${interaction.token}/messages/@original`, data, { auth: false });
  }

  async followup(interaction, data) {
    const appId = await this.appId();
    return this._req('POST', `/webhooks/${appId}/${interaction.token}`, data, { auth: false });
  }

  // ── Messages ───────────────────────────────────────────────────
  createMessage(channelId, data, files) {
    return this._req('POST', `/channels/${channelId}/messages`, data, { files });
  }
  editMessage(channelId, messageId, data) {
    return this._req('PATCH', `/channels/${channelId}/messages/${messageId}`, data);
  }
  deleteMessage(channelId, messageId) {
    return this._req('DELETE', `/channels/${channelId}/messages/${messageId}`);
  }
  getMessages(channelId, { limit = 50, before, after } = {}) {
    const q = new URLSearchParams({ limit: String(limit) });
    if (before) q.set('before', before);
    if (after) q.set('after', after);
    return this._req('GET', `/channels/${channelId}/messages?${q}`);
  }

  // ── Channels & permissions ─────────────────────────────────────
  getChannel(channelId) {
    return this._req('GET', `/channels/${channelId}`);
  }
  createChannel(guildId, data) {
    return this._req('POST', `/guilds/${guildId}/channels`, data);
  }
  editChannel(channelId, data) {
    return this._req('PATCH', `/channels/${channelId}`, data);
  }
  deleteChannel(channelId) {
    return this._req('DELETE', `/channels/${channelId}`);
  }
  editChannelPermissions(channelId, overwriteId, data) {
    // type 0 = role, 1 = member
    return this._req('PUT', `/channels/${channelId}/permissions/${overwriteId}`, data);
  }

  // ── Member roles ───────────────────────────────────────────────
  addGuildMemberRole(guildId, userId, roleId) {
    return this._req('PUT', `/guilds/${guildId}/members/${userId}/roles/${roleId}`, undefined);
  }
  removeGuildMemberRole(guildId, userId, roleId) {
    return this._req('DELETE', `/guilds/${guildId}/members/${userId}/roles/${roleId}`);
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function safeJson(t) { try { return JSON.parse(t); } catch { return null; } }

module.exports = { Rest, CALLBACK, FLAG };
