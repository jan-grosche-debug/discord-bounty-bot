// JSON persistence with atomic writes and a keyed async mutex.
// Single-instance only: the mutex prevents oversell within one process.
//
// Model: ONE ticket per (member, deal). Tickets are keyed by `${memberId}:${dealId}`,
// so the same user can never open a second ticket for the same deal.

const fs = require('fs');
const path = require('path');

const DEFAULT_STATE = { dealCounter: 0, ticketCounter: 0, deals: {}, tickets: {}, members: {} };

let FILE = null;
let state = null;

// ── keyed mutex ────────────────────────────────────────────────
const _locks = new Map();
async function withLock(key, fn) {
  const prev = _locks.get(key) || Promise.resolve();
  let release;
  const next = new Promise((r) => { release = r; });
  const chain = prev.then(() => next);
  _locks.set(key, chain);
  await prev;
  try { return await fn(); }
  finally {
    release();
    if (_locks.get(key) === chain) _locks.delete(key);
  }
}

// ── load / save ────────────────────────────────────────────────
function init(dataDir) {
  FILE = path.join(dataDir, 'state.json');
  fs.mkdirSync(dataDir, { recursive: true });
  if (fs.existsSync(FILE)) {
    try { state = JSON.parse(fs.readFileSync(FILE, 'utf8')); }
    catch { state = { ...DEFAULT_STATE }; }
  } else {
    state = { ...DEFAULT_STATE };
    save();
  }
  state.deals ||= {};
  state.tickets ||= {};
  state.members ||= {};
  if (typeof state.dealCounter !== 'number') state.dealCounter = 0;
  if (typeof state.ticketCounter !== 'number') state.ticketCounter = 0;
  return state;
}

function save() {
  if (!FILE) throw new Error('store not initialised');
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, FILE);
}

function getState() { return state; }

// ── deals ──────────────────────────────────────────────────────
function nextDealId() {
  const id = state.dealCounter;       // starts at 0, increments
  state.dealCounter = id + 1;
  save();
  return id;
}
function addDeal(deal) { state.deals[String(deal.id)] = deal; save(); return deal; }
function getDeal(id) { return state.deals[String(id)] || null; }
function getDealByChannel(channelId) { return Object.values(state.deals).find((d) => d && d.channelId === channelId) || null; }
function updateDeal(id, patch) {
  const d = getDeal(id);
  if (!d) return null;
  Object.assign(d, patch);
  save();
  return d;
}

// ── tickets (one per member+deal) ──────────────────────────────
function tkey(memberId, dealId) { return `${memberId}:${dealId}`; }

function nextTicketNo() {
  const n = state.ticketCounter + 1;   // sequential, starts at 1
  state.ticketCounter = n;
  save();
  return n;
}

function getTicket(memberId, dealId) { return state.tickets[tkey(memberId, dealId)] || null; }
function getTicketByChannel(channelId) {
  return Object.values(state.tickets).find((t) => t && t.channelId === channelId) || null;
}

function createTicket(memberId, dealId, channelId, ticketNo) {
  const k = tkey(memberId, dealId);
  if (!state.tickets[k]) {
    state.tickets[k] = {
      key: k, ticketNo, dealId: Number(dealId), memberId: String(memberId), channelId,
      status: 'open', qty: 0, zahlungsziel: null, trackings: [], invoice: null, serial: null,
      panelMessageId: null, log: [], createdAt: new Date().toISOString(),
    };
    save();
  }
  return state.tickets[k]; // existing ticket returned unchanged — one per (member, deal)
}

function setTicketPanel(memberId, dealId, panelMessageId) {
  const t = getTicket(memberId, dealId); if (!t) return null;
  t.panelMessageId = panelMessageId; save(); return t;
}
function setTicketZiel(memberId, dealId, ziel) {
  const t = getTicket(memberId, dealId); if (!t) return null;
  t.zahlungsziel = ziel; save(); return t;
}
function addTracking(memberId, dealId, tracking) {
  const t = getTicket(memberId, dealId); if (!t) return null;
  t.trackings ||= [];
  t.trackings.push({ ...tracking, at: new Date().toISOString() });
  save(); return t;
}
function setTicketInvoice(memberId, dealId, invoice) {
  const t = getTicket(memberId, dealId); if (!t) return null;
  t.invoice = invoice; save(); return t;
}
function setTicketSerial(memberId, dealId, serial) {
  const t = getTicket(memberId, dealId); if (!t) return null;
  t.serial = serial; save(); return t;
}
function listTicketsByDeal(dealId) {
  return Object.values(state.tickets).filter((t) => t && Number(t.dealId) === Number(dealId));
}
function removeTicket(memberId, dealId) {
  delete state.tickets[tkey(memberId, dealId)];
  save();
}

// ── member stats (completed deals → rank roles) ────────────────
function getCompleted(memberId) {
  const m = state.members[String(memberId)];
  return m ? (m.completed || 0) : 0;
}
function incrementCompleted(memberId) {
  const k = String(memberId);
  const m = state.members[k] || { completed: 0 };
  m.completed = (m.completed || 0) + 1;
  state.members[k] = m;
  save();
  return m.completed;
}

// Atomically set a member's registered quantity for a deal. Adjusts the deal pool
// (reservedQty) by the delta under the per-deal lock, so two members can't oversell.
function setTicketQty(dealId, memberId, newQty, byUserId) {
  return withLock(`deal:${dealId}`, async () => {
    const d = getDeal(dealId);
    if (!d) return { ok: false, reason: 'deal_not_found' };
    const t = getTicket(memberId, dealId);
    if (!t) return { ok: false, reason: 'ticket_not_found' };

    const old = t.qty || 0;
    const delta = newQty - old;
    if (delta > 0) {
      if (d.status !== 'open' && d.status !== 'exhausted') return { ok: false, reason: 'closed' };
      const available = (d.totalQty || 0) - (d.reservedQty || 0);
      if (delta > available) return { ok: false, reason: 'insufficient', available };
    }

    d.reservedQty = Math.max(0, (d.reservedQty || 0) + delta);
    t.qty = newQty;
    if (d.status === 'open' && d.reservedQty >= d.totalQty) d.status = 'exhausted';
    else if (d.status === 'exhausted' && d.reservedQty < d.totalQty) d.status = 'open';
    t.log.push(`Menge ${old}→${newQty} (by ${byUserId}) ${new Date().toISOString()}`);
    save();
    return { ok: true, deal: d, ticket: t, available: d.totalQty - d.reservedQty, old, newQty };
  });
}

module.exports = {
  init, save, getState, withLock,
  nextDealId, addDeal, getDeal, getDealByChannel, updateDeal,
  nextTicketNo, getTicket, getTicketByChannel, createTicket,
  setTicketPanel, setTicketZiel, addTracking, setTicketInvoice, setTicketSerial,
  listTicketsByDeal, removeTicket, setTicketQty,
  getCompleted, incrementCompleted,
};
