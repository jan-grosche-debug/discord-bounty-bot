// Ticket system. ONE ticket (private channel) per (member, deal). The channel is
// named `<nr>-<produkt>-<user>` with a global running number. Members register a
// quantity (atomic draw-down of the deal pool), see the shop link, deposit tracking
// (member OR owner), a serial number, and upload their invoice as a PDF
// (detected via REST scan — no privileged intent needed).

const calc = require('./calc');
const fmt = require('../lib/discord/format');
const dealEmbed = require('./deal');
const { CALLBACK, FLAG } = require('../lib/discord/rest');

// Permission bits
const P = {
  VIEW: 1 << 10, SEND: 1 << 11, MANAGE_MSG: 1 << 13,
  EMBED: 1 << 14, ATTACH: 1 << 15, HISTORY: 1 << 16,
};
const MEMBER_ALLOW = P.VIEW | P.SEND | P.EMBED | P.ATTACH | P.HISTORY;
const OWNER_ALLOW = MEMBER_ALLOW | P.MANAGE_MSG;
const BOT_ALLOW = MEMBER_ALLOW | P.MANAGE_MSG;

const isPlaceholder = (s) => !s || /^PASTE_/.test(s);
function parts(interaction) { return (interaction.data.custom_id || '').split(':'); }
function slug(s, max) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max || 90); }

// ── invoice PDF detection (pure, testable) ─────────────────────
function isPdf(att) {
  return (att && ((att.content_type && /pdf/i.test(att.content_type)) || /\.pdf$/i.test(att.filename || '')));
}
// messages are returned newest-first by Discord; prefer the member's own PDF.
function pickInvoiceAttachment(messages, memberId) {
  const found = [];
  for (const m of (messages || [])) {
    for (const att of (m.attachments || [])) {
      if (isPdf(att)) found.push({ messageId: m.id, url: att.url, filename: att.filename, contentType: att.content_type || null, by: m.author && m.author.id });
    }
  }
  if (!found.length) return null;
  const mine = found.filter((a) => a.by === String(memberId));
  return mine[0] || found[0];
}

// ── panel rendering ────────────────────────────────────────────
// The buyer's invoice address (entered once in config.billing), shown so the
// member knows where to address the invoice. Hidden until configured.
function billingBlock(config) {
  const b = config && config.billing;
  if (!b || !b.address || /^PASTE_/.test(String(b.address))) return null;
  const addr = String(b.address).split(',').map((x) => x.trim()).filter(Boolean).join('\n');
  return `**🧾 Rechnung ausstellen an:**\n${addr}`;
}

function buildPanel(deal, ticket, memberId, config) {
  const v = calc.computeDeal(deal);
  const t = ticket || { qty: 0, trackings: [], invoice: null, serial: null };
  const lines = [];
  lines.push(`🔗 **Shop-Link:** ${deal.shopLink}`);
  lines.push('');
  lines.push('**🏷️ Verkaufspreis (pro Einheit)**');
  for (const s of v.stufen) lines.push(`${s.tage != null ? s.label + ': ' : ''}${fmt.eur(s.vkBrutto)} (${fmt.eur(s.vkNetto)} Netto)`);
  lines.push('');
  lines.push('**📝 Deine Anmeldung**');
  lines.push(`Menge: **${t.qty || 0}**`);

  const tks = t.trackings || [];
  const tkText = tks.length ? tks.map((x) => `\`${x.code}\` (${x.qty})`).join(', ') : '—';
  lines.push(`Tracking: ${tkText}`);
  lines.push(`Rechnung: ${t.invoice ? `✅ ${t.invoice.filename}` : '—'}`);
  lines.push(`Seriennummer: ${t.serial ? `\`${t.serial}\`` : '— · 📷 Foto ins Ticket schicken **oder** Button „Seriennummer eintragen"'}`);
  lines.push('');
  lines.push(`📦 Pool: ${fmt.progressBar(v.availability.available, v.availability.total, deal.progressBarSegments || 10)}`);

  const bill = billingBlock(config);
  if (bill) { lines.push(''); lines.push(bill); }

  const embed = {
    title: `🧾 Teilnahme — Deal #${deal.id}: ${deal.product}`,
    description: lines.join('\n'),
    color: deal.status === 'open' ? fmt.COLOR.GREEN : fmt.COLOR.GREY,
  };
  // done → green (style 3), open → blue (style 1)
  const mk = (done, label, id) => ({ type: 2, style: done ? 3 : 1, label, custom_id: id });
  const row = {
    type: 1,
    components: [
      mk((t.qty || 0) > 0, 'Menge anmelden', `tkt_qty:${deal.id}:${memberId}`),
      mk(!!t.serial, 'Seriennummer eintragen', `tkt_serial:${deal.id}:${memberId}`),
      mk((t.trackings || []).length > 0, 'Tracking hinterlegen', `tkt_track:${deal.id}:${memberId}`),
      mk(!!t.invoice, 'Rechnung hochladen', `tkt_invoice:${deal.id}:${memberId}`),
    ],
  };
  return { embeds: [embed], components: [row] };
}

// ── access control ─────────────────────────────────────────────
function actorAllowed(interaction, memberId, config) {
  const uid = interaction.member?.user?.id;
  if (uid === String(memberId)) return true;
  const ownerRole = config.roles?.owner;
  if (!isPlaceholder(ownerRole) && (interaction.member?.roles || []).includes(ownerRole)) return true;
  return false;
}
function deny(ctx, interaction) {
  return ctx.rest.respond(interaction, CALLBACK.CHANNEL_MESSAGE,
    { content: '⛔ Nur der Ticket-Inhaber oder die Owner-Rolle darf das.', flags: FLAG.EPHEMERAL });
}

// ── ticket channel ─────────────────────────────────────────────
async function createTicketChannel(ctx, interaction, member, ticketNo, product) {
  const { rest, config } = ctx;
  const guildId = interaction.guild_id || config.guildId;
  // <nr>-<produkt>-<user> (Discord channel names: lowercase, hyphenated, <=100 chars)
  const name = `${ticketNo}-${slug(product, 50)}-${slug(member.username || member.id, 25)}`.slice(0, 95);

  const overwrites = [
    { id: guildId, type: 0, deny: String(P.VIEW) },
    { id: member.id, type: 1, allow: String(MEMBER_ALLOW) },
  ];
  if (!isPlaceholder(config.roles?.owner)) overwrites.push({ id: config.roles.owner, type: 0, allow: String(OWNER_ALLOW) });
  if (ctx.botUserId) overwrites.push({ id: ctx.botUserId, type: 1, allow: String(BOT_ALLOW) });

  const data = { name, type: 0, permission_overwrites: overwrites };
  if (!isPlaceholder(config.channels?.ticketCategory)) data.parent_id = config.channels.ticketCategory;
  try {
    return await rest.createChannel(guildId, data);
  } catch (e) {
    // ticketCategory invalid? Create the ticket without a parent instead of failing.
    if (data.parent_id) {
      console.error('[ticket] ticketCategory ungültig — erstelle Ticket ohne Kategorie:', e.message);
      delete data.parent_id;
      return await rest.createChannel(guildId, data);
    }
    throw e;
  }
}

// ── join (from the deal button) ────────────────────────────────
async function handleJoin(ctx, interaction) {
  const { rest, store } = ctx;
  const dealId = Number(parts(interaction)[1]);
  const member = interaction.member?.user;
  const memberId = member?.id;

  await rest.respond(interaction, CALLBACK.DEFERRED_CHANNEL_MESSAGE, { flags: FLAG.EPHEMERAL });

  const deal = store.getDeal(dealId);
  if (!deal) return rest.editOriginal(interaction, { content: '⚠️ Deal nicht gefunden.' });
  if (deal.status !== 'open') return rest.editOriginal(interaction, { content: `⚠️ Dieser Deal ist nicht mehr aktiv (${deal.status}).` });

  try {
    // one ticket per (member, deal): reuse if the channel still exists
    const existing = store.getTicket(memberId, dealId);
    if (existing && existing.channelId) {
      let alive = true;
      try { await rest.getChannel(existing.channelId); } catch { alive = false; }
      if (alive) return rest.editOriginal(interaction, { content: `Du hast für diesen Deal bereits ein Ticket: <#${existing.channelId}>.` });
      store.removeTicket(memberId, dealId); // stale → recreate below
    }

    const ticketNo = store.nextTicketNo();
    const ch = await createTicketChannel(ctx, interaction, member, ticketNo, deal.product);
    const ticket = store.createTicket(memberId, dealId, ch.id, ticketNo);

    const msg = await rest.createMessage(ch.id, { content: `<@${memberId}>`, ...buildPanel(deal, ticket, memberId, ctx.config) });
    store.setTicketPanel(memberId, dealId, msg.id);

    return rest.editOriginal(interaction, { content: `✅ Dein Ticket für **Deal #${dealId}**: <#${ch.id}>` });
  } catch (e) {
    console.error('[ticket] join failed:', e.message);
    return rest.editOriginal(interaction, { content: `⚠️ Ticket konnte nicht erstellt werden: ${e.message}` }).catch(() => {});
  }
}

// ── update the panel after a change ────────────────────────────
async function updatePanel(ctx, deal, memberId) {
  const ticket = ctx.store.getTicket(memberId, deal.id);
  if (!ticket || !ticket.panelMessageId || !ticket.channelId) return;
  try { await ctx.rest.editMessage(ticket.channelId, ticket.panelMessageId, buildPanel(deal, ticket, memberId, ctx.config)); }
  catch (e) { console.error('[ticket] panel update failed:', e.message); }
}

// ── quantity: button → modal ───────────────────────────────────
async function handleQtyButton(ctx, interaction) {
  const [, dealId, memberId] = parts(interaction);
  if (!actorAllowed(interaction, memberId, ctx.config)) return deny(ctx, interaction);
  const ticket = ctx.store.getTicket(memberId, dealId);
  const current = ticket ? ticket.qty : 0;
  return ctx.rest.respond(interaction, CALLBACK.MODAL, {
    custom_id: `tkt_qtymodal:${dealId}:${memberId}`,
    title: `Menge anmelden — Deal #${dealId}`,
    components: [{
      type: 1,
      components: [{ type: 4, custom_id: 'menge', label: 'Menge (Stück)', style: 1, required: true, value: String(current), placeholder: 'z.B. 4', max_length: 6 }],
    }],
  });
}

// ── quantity: modal submit ─────────────────────────────────────
async function handleQtyModal(ctx, interaction) {
  const [, dealId, memberId] = parts(interaction);
  const actor = interaction.member?.user?.id;
  if (!actorAllowed(interaction, memberId, ctx.config)) return deny(ctx, interaction);

  await ctx.rest.respond(interaction, CALLBACK.DEFERRED_CHANNEL_MESSAGE, { flags: FLAG.EPHEMERAL });
  const comp = interaction.data.components?.[0]?.components?.[0];
  const qty = parseInt(String(comp?.value || '').trim(), 10);
  if (!Number.isFinite(qty) || qty < 0) {
    return ctx.rest.editOriginal(interaction, { content: '⚠️ Bitte eine gültige Menge (≥ 0) eingeben.' });
  }

  const res = await ctx.store.setTicketQty(Number(dealId), memberId, qty, actor);
  if (!res.ok) {
    const msg = res.reason === 'insufficient' ? `⚠️ Nicht genug verfügbar. Noch offen im Pool: **${res.available}**.`
      : res.reason === 'closed' ? '⚠️ Der Deal ist nicht mehr offen.'
      : `⚠️ Konnte Menge nicht setzen (${res.reason}).`;
    return ctx.rest.editOriginal(interaction, { content: msg });
  }

  await updatePanel(ctx, res.deal, memberId);
  await dealEmbed.refreshEmbed(ctx, res.deal);
  // pool just got fully used up → archive the deal automatically (once)
  if (res.deal.status === 'exhausted') await dealEmbed.archiveDeal(ctx, res.deal);
  return ctx.rest.editOriginal(interaction, {
    content: `✅ Menge für **Deal #${dealId}** auf **${qty}** gesetzt. Noch offen im Pool: ${res.available}.`,
  });
}

// ── /ticket-close: owner closes the current ticket channel ─────
async function handleTicketClose(ctx, interaction) {
  const { rest, store, config } = ctx;
  const channelId = interaction.channel_id;
  const ticket = store.getTicketByChannel(channelId);
  if (!ticket) {
    return rest.editOriginal(interaction, { content: '⚠️ Diesen Befehl bitte **im Ticket-Channel** ausführen.' });
  }

  // count this as a completed deal for the member, then award any tier role just reached
  const completed = store.incrementCompleted(ticket.memberId);
  const guildId = interaction.guild_id || config.guildId;
  const awarded = [];
  for (const tier of (config.roleTiers || [])) {
    if (tier && tier.roleId && !/^PASTE_/.test(String(tier.roleId)) && completed === Number(tier.count)) {
      try { await rest.addGuildMemberRole(guildId, ticket.memberId, tier.roleId); awarded.push(tier); }
      catch (e) { console.error('[ticket] role award failed:', e.message); }
    }
  }

  await rest.editOriginal(interaction, {
    content: `✅ Ticket geschlossen — Deal #${ticket.dealId} · <@${ticket.memberId}> (insgesamt **${completed}** abgeschlossen).`
      + (awarded.length ? `\n🎉 Neue Rolle ab ${awarded[0].count} Deals: <@&${awarded[0].roleId}>` : ''),
  });
  store.removeTicket(ticket.memberId, ticket.dealId);
  try { await rest.deleteChannel(channelId); }
  catch (e) { console.error('[ticket] close failed:', e.message); }
}

// ── tracking: button → modal (member OR owner) ─────────────────
async function handleTrackButton(ctx, interaction) {
  const [, dealId, memberId] = parts(interaction);
  if (!actorAllowed(interaction, memberId, ctx.config)) return deny(ctx, interaction);
  return ctx.rest.respond(interaction, CALLBACK.MODAL, {
    custom_id: `tkt_trackmodal:${dealId}:${memberId}`,
    title: `Tracking — Deal #${dealId}`,
    components: [
      { type: 1, components: [{ type: 4, custom_id: 'code', label: 'Sendungsnummer', style: 1, required: true, max_length: 100, placeholder: 'z.B. 00340434...' }] },
      { type: 1, components: [{ type: 4, custom_id: 'menge', label: 'Menge mit dieser Sendung', style: 1, required: false, value: '1', max_length: 6 }] },
    ],
  });
}

// ── tracking: modal submit ─────────────────────────────────────
async function handleTrackModal(ctx, interaction) {
  const [, dealId, memberId] = parts(interaction);
  const actor = interaction.member?.user?.id;
  if (!actorAllowed(interaction, memberId, ctx.config)) return deny(ctx, interaction);

  await ctx.rest.respond(interaction, CALLBACK.DEFERRED_CHANNEL_MESSAGE, { flags: FLAG.EPHEMERAL });
  const rows = interaction.data.components || [];
  const getVal = (id) => {
    for (const r of rows) for (const c of (r.components || [])) if (c.custom_id === id) return c.value;
    return undefined;
  };
  const code = String(getVal('code') || '').trim();
  const qty = parseInt(String(getVal('menge') || '1').trim(), 10);
  if (!code) return ctx.rest.editOriginal(interaction, { content: '⚠️ Bitte eine Sendungsnummer eingeben.' });

  ctx.store.addTracking(memberId, Number(dealId), { code, qty: Number.isFinite(qty) ? qty : 1, by: actor });
  const d = ctx.store.getDeal(Number(dealId));
  if (d) await updatePanel(ctx, d, memberId);
  return ctx.rest.editOriginal(interaction, { content: `✅ Tracking \`${code}\` (Menge ${Number.isFinite(qty) ? qty : 1}) hinterlegt.` });
}

// ── invoice: scan ticket for the newest PDF ────────────────────
async function handleInvoice(ctx, interaction) {
  const [, dealId, memberId] = parts(interaction);
  if (!actorAllowed(interaction, memberId, ctx.config)) return deny(ctx, interaction);

  await ctx.rest.respond(interaction, CALLBACK.DEFERRED_CHANNEL_MESSAGE, { flags: FLAG.EPHEMERAL });
  const ticket = ctx.store.getTicket(memberId, Number(dealId));
  if (!ticket?.channelId) return ctx.rest.editOriginal(interaction, { content: '⚠️ Kein Ticket gefunden.' });

  let messages = [];
  try { messages = await ctx.rest.getMessages(ticket.channelId, { limit: 50 }); }
  catch (e) { return ctx.rest.editOriginal(interaction, { content: `⚠️ Konnte Nachrichten nicht lesen: ${e.message}` }); }

  const bill = billingBlock(ctx.config);
  const pick = pickInvoiceAttachment(messages, memberId);
  if (!pick) {
    return ctx.rest.editOriginal(interaction, {
      content: '📄 Keine PDF gefunden. Hänge deine Rechnung als **PDF** in dieses Ticket und klick dann erneut auf „Rechnung hochladen".'
        + (bill ? `\n\n${bill}` : ''),
    });
  }
  ctx.store.setTicketInvoice(memberId, Number(dealId), { messageId: pick.messageId, url: pick.url, filename: pick.filename, by: pick.by, at: new Date().toISOString() });
  const d = ctx.store.getDeal(Number(dealId));
  if (d) await updatePanel(ctx, d, memberId);
  return ctx.rest.editOriginal(interaction, {
    content: `✅ Rechnung **${pick.filename}** erfasst und mit Deal #${dealId} verknüpft.` + (bill ? `\n\n${bill}` : ''),
  });
}

// ── serial number: button → modal (member OR owner) ────────────
async function handleSerialButton(ctx, interaction) {
  const [, dealId, memberId] = parts(interaction);
  if (!actorAllowed(interaction, memberId, ctx.config)) return deny(ctx, interaction);
  const ticket = ctx.store.getTicket(memberId, Number(dealId));
  return ctx.rest.respond(interaction, CALLBACK.MODAL, {
    custom_id: `tkt_serialmodal:${dealId}:${memberId}`,
    title: `Seriennummer — Deal #${dealId}`,
    components: [{
      type: 1,
      components: [{ type: 4, custom_id: 'serial', label: 'Seriennummer', style: 1, required: true, value: ticket?.serial || '', max_length: 100, placeholder: 'z.B. S/N R9XA0J123...' }],
    }],
  });
}

async function handleSerialModal(ctx, interaction) {
  const [, dealId, memberId] = parts(interaction);
  if (!actorAllowed(interaction, memberId, ctx.config)) return deny(ctx, interaction);
  await ctx.rest.respond(interaction, CALLBACK.DEFERRED_CHANNEL_MESSAGE, { flags: FLAG.EPHEMERAL });
  const rows = interaction.data.components || [];
  const getVal = (id) => { for (const r of rows) for (const c of (r.components || [])) if (c.custom_id === id) return c.value; return undefined; };
  const serial = String(getVal('serial') || '').trim();
  if (!serial) return ctx.rest.editOriginal(interaction, { content: '⚠️ Bitte eine Seriennummer eingeben.' });
  ctx.store.setTicketSerial(memberId, Number(dealId), serial);
  const d = ctx.store.getDeal(Number(dealId));
  if (d) await updatePanel(ctx, d, memberId);
  return ctx.rest.editOriginal(interaction, { content: `✅ Seriennummer \`${serial}\` gespeichert.` });
}

module.exports = {
  buildPanel, billingBlock, pickInvoiceAttachment, isPdf, slug,
  handleJoin, handleQtyButton, handleQtyModal,
  handleTrackButton, handleTrackModal, handleInvoice, handleSerialButton, handleSerialModal,
  handleTicketClose,
};
