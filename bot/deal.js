// Deal lifecycle: build the deal embed, handle /newdeal and the lifecycle
// commands (/deal-menge, /deal-close, /deal-expire, /mark-deal-as).

const calc = require('./calc');
const fmt = require('../lib/discord/format');

const PLACEHOLDER = /^PASTE_/;
const PERM = { VIEW: 1 << 10, SEND: 1 << 11, EMBED: 1 << 14, HISTORY: 1 << 16 };
function slug(s, max) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max || 90); }
// channel name with status marker: emoji at the FRONT, word as suffix
function markedName(base, status) {
  const emoji = status === 'green' ? '🟢' : '🔴';
  const word = status === 'green' ? '-verfügbar' : '-oos';
  return (emoji + base + word).slice(0, 95);
}

// create the per-deal channel under the deals category (falls back to no parent)
async function createDealChannel(ctx, interaction, name, category) {
  const { rest, config } = ctx;
  const guildId = interaction.guild_id || config.guildId;
  const overwrites = [{ id: guildId, type: 0, deny: String(PERM.SEND) }]; // read-only for everyone, button still usable
  if (ctx.botUserId) overwrites.push({ id: ctx.botUserId, type: 1, allow: String(PERM.VIEW | PERM.SEND | PERM.EMBED | PERM.HISTORY) });
  const data = { name, type: 0, parent_id: category, permission_overwrites: overwrites };
  try { return await rest.createChannel(guildId, data); }
  catch (e) {
    console.error('[deal] dealCategory ungültig? — erstelle Channel ohne Kategorie:', e.message);
    delete data.parent_id;
    return await rest.createChannel(guildId, data);
  }
}

// ── embed + components ─────────────────────────────────────────
function buildMessage(deal) {
  const v = calc.computeDeal(deal);
  const lines = [];

  if (deal.shopHint) lines.push(`> ${deal.shopHint}`);
  if (deal.note) lines.push(`> ${deal.note}`);
  lines.push('');

  lines.push('**🛒 Regulärer Warenkorb**');
  lines.push(`Einkaufspreis: ${fmt.eur(v.cart.ekBrutto)} / Stück`);
  lines.push(`Reguläre Menge: ${v.cart.cartQty} Stück`);
  lines.push(`Gesamt: ${fmt.eur(v.cart.gesamtBrutto)} (${fmt.eur(v.cart.gesamtNetto)} Netto)`);
  lines.push('');

  lines.push('**🏷️ Verkaufspreis**');
  for (const s of v.stufen) {
    if (s.tage != null) lines.push(`__${s.label}__`);
    lines.push(`pro Stück: ${fmt.eur(s.vkBrutto)} (${fmt.eur(s.vkNetto)} Netto)`);
    lines.push(`gesamt: ${fmt.eur(calc.round2(s.vkBrutto * v.cart.cartQty))} (${fmt.eur(calc.round2(s.vkNetto * v.cart.cartQty))} Netto)`);
  }
  lines.push('');

  lines.push('**💰 Gewinn**');
  for (const s of v.stufen) {
    if (s.tage != null) lines.push(`__${s.label}__`);
    lines.push(`pro Stück: brutto ${fmt.eur(s.bruttoStk)} · netto ${fmt.eur(s.nettoStk)} · ${fmt.pct(s.bruttoPct)}`);
    lines.push(`gesamt: brutto ${fmt.eur(s.bruttoGesamt)} · netto ${fmt.eur(s.nettoGesamt)}`);
  }
  lines.push('');

  lines.push('**📦 Verfügbar**');
  lines.push(fmt.progressBar(v.availability.available, v.availability.total, deal.progressBarSegments || 10));
  lines.push('');
  lines.push(`Deal-ID: \`${deal.id}\``);

  const open = deal.status === 'open';
  const exhausted = deal.status === 'exhausted';
  const color = open ? fmt.COLOR.GREEN : (exhausted ? fmt.COLOR.BLUE : fmt.COLOR.GREY);

  const embed = {
    title: `🛒 Bounty #${deal.id} — ${deal.product}`,
    description: lines.join('\n'),
    color,
    footer: { text: open ? '👇 Klicke zum Teilnehmen' : statusLabel(deal.status) },
  };

  let label = 'Beim Deal teilnehmen';
  let style = 3; // success/green
  let disabled = false;
  if (!open) {
    disabled = true; style = 2;
    label = exhausted ? 'Ausverkauft' : statusLabel(deal.status);
  }

  const components = [{
    type: 1,
    components: [{ type: 2, style, label, custom_id: `deal_join:${deal.id}`, disabled }],
  }];

  return { embeds: [embed], components };
}

function statusLabel(status) {
  return ({ open: 'Offen', exhausted: 'Ausverkauft', expired: 'Deal abgelaufen', closed: 'Deal geschlossen' })[status] || status;
}

// ── /newdeal ───────────────────────────────────────────────────
async function handleNewDeal(ctx, interaction, o) {
  const { rest, store, config } = ctx;
  const category = config.channels && config.channels.dealCategory;

  // validate config first (don't burn a deal-id on a misconfig)
  if (!category || PLACEHOLDER.test(category)) {
    return rest.editOriginal(interaction, {
      content: '⚠️ Keine gültige Deal-Kategorie in `config.json` (channels.dealCategory). Bitte eintragen.',
    });
  }

  const id = store.nextDealId();
  const baseName = `${id}-${slug(o.produkt, 80)}`;
  const deal = {
    id,
    product: o.produkt,
    shopHint: o.shop_hinweis,
    note: o.hinweis || '',
    cartQty: o.menge_warenkorb,
    ekBrutto: o.ek_brutto,
    vkSofortBrutto: o.vk_sofort,
    zielStufen: [],
    totalQty: o.verfuegbar,
    reservedQty: 0,
    shopLink: o.shop_link,
    vatRate: config.vatRate ?? 0.19,
    progressBarSegments: config.progressBarSegments || 10,
    channelId: null,
    channelName: baseName,
    messageId: null,
    markStatus: 'green',
    status: 'open',
    archived: false,
    createdBy: interaction.member?.user?.id || interaction.user?.id || null,
    createdAt: new Date().toISOString(),
  };

  // create the per-deal channel under the deals category and post the deal there
  let ch;
  try { ch = await createDealChannel(ctx, interaction, markedName(baseName, 'green'), category); }
  catch (e) { return rest.editOriginal(interaction, { content: `⚠️ Deal-Channel konnte nicht erstellt werden: ${e.message}` }); }
  deal.channelId = ch.id;

  const msg = await rest.createMessage(ch.id, buildMessage(deal));
  deal.messageId = msg.id;
  store.addDeal(deal);

  return rest.editOriginal(interaction, { content: `✅ **Deal #${id}** erstellt: <#${ch.id}>` });
}

// ── refresh the posted embed after a change ────────────────────
async function refreshEmbed(ctx, deal) {
  if (!deal.messageId || !deal.channelId) return;
  try { await ctx.rest.editMessage(deal.channelId, deal.messageId, buildMessage(deal)); }
  catch (e) { console.error('[deal] embed refresh failed:', e.message); }
}

// Post the deal (embed only, no buttons) into #deal-archive — exactly once per deal.
// Triggered when the pool is fully exhausted OR when the owner runs /deal-close.
async function archiveDeal(ctx, deal) {
  if (deal.archived) return false;
  const archive = ctx.config && ctx.config.channels && ctx.config.channels.dealArchive;
  if (!archive || PLACEHOLDER.test(archive)) return false;
  try {
    const embed = buildMessage(deal).embeds[0];
    const created = deal.createdAt ? new Date(deal.createdAt) : new Date();
    const dateStr = created.toLocaleString(ctx.config?.locale || 'de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    embed.description = `📅 **Deal-Datum:** ${dateStr}\n\n${embed.description}`;
    await ctx.rest.createMessage(archive, { embeds: [embed] });
    ctx.store.updateDeal(deal.id, { archived: true });
    deal.archived = true;
    return true;
  } catch (e) { console.error('[deal] archive post failed:', e.message); return false; }
}

// ── /deal-menge ────────────────────────────────────────────────
async function handleDealMenge(ctx, interaction, o) {
  const { rest, store } = ctx;
  const deal = store.getDeal(o.deal_id);
  if (!deal) return rest.editOriginal(interaction, { content: `⚠️ Deal #${o.deal_id} nicht gefunden.` });

  // never shrink the pool below what members have already reserved (would oversell)
  const reserved = deal.reservedQty || 0;
  if (o.neue_menge < reserved) {
    return rest.editOriginal(interaction, {
      content: `⚠️ Es sind bereits **${reserved}** Stück angemeldet — der Pool kann nicht kleiner sein. Setze mindestens ${reserved}.`,
    });
  }

  deal.totalQty = o.neue_menge;
  if (deal.status === 'exhausted' && deal.reservedQty < deal.totalQty) deal.status = 'open';
  if (deal.status === 'open' && deal.reservedQty >= deal.totalQty) deal.status = 'exhausted';
  store.updateDeal(deal.id, {});
  await refreshEmbed(ctx, deal);

  const avail = Math.max(0, deal.totalQty - deal.reservedQty);
  return rest.editOriginal(interaction, {
    content: `✅ Deal #${deal.id}: Pool auf **${deal.totalQty}** gesetzt (offen: ${avail}).`,
  });
}

// ── /deal-expire ───────────────────────────────────────────────
async function handleDealStatus(ctx, interaction, o, status) {
  const { rest, store } = ctx;
  const deal = store.getDeal(o.deal_id);
  if (!deal) return rest.editOriginal(interaction, { content: `⚠️ Deal #${o.deal_id} nicht gefunden.` });
  store.updateDeal(deal.id, { status });
  await refreshEmbed(ctx, deal);
  return rest.editOriginal(interaction, {
    content: `✅ Deal #${deal.id} → **${statusLabel(status)}**.`,
  });
}

// ── /deal-close: archive the deal, delete its channel ──────────
async function handleDealClose(ctx, interaction, o) {
  const { rest, store, config } = ctx;
  const deal = store.getDeal(o.deal_id);
  if (!deal) return rest.editOriginal(interaction, { content: `⚠️ Deal #${o.deal_id} nicht gefunden.` });

  store.updateDeal(deal.id, { status: 'closed' });

  const posted = await archiveDeal(ctx, deal);
  const archive = config.channels && config.channels.dealArchive;
  const inArchive = (posted || deal.archived) && archive && !PLACEHOLDER.test(archive);

  // confirm BEFORE deleting the channel (response is tied to the interaction token)
  await rest.editOriginal(interaction, {
    content: `✅ Deal #${deal.id} geschlossen`
      + (inArchive ? ` → <#${archive}>` : ' (kein gültiges #deal-archive konfiguriert)') + '.',
  });

  if (deal.channelId) {
    try { await rest.deleteChannel(deal.channelId); }
    catch (e) { console.error('[deal] channel delete failed:', e.message); }
  }
  // NOTE: tickets are NOT deleted here — the owner closes each with /ticket-close.
}

// ── /mark-deal-as: rename the deal channel (🟢 verfügbar / 🔴 oos) ──
async function handleMarkDeal(ctx, interaction, o) {
  const { rest, store } = ctx;
  const deal = store.getDealByChannel(interaction.channel_id);
  if (!deal) return rest.editOriginal(interaction, { content: '⚠️ Diesen Befehl bitte **im Deal-Channel** ausführen.' });

  const base = deal.channelName || `${deal.id}-${slug(deal.product, 80)}`;
  const newName = markedName(base, o.status);
  try { await rest.editChannel(interaction.channel_id, { name: newName }); }
  catch (e) { return rest.editOriginal(interaction, { content: `⚠️ Channel umbenennen fehlgeschlagen: ${e.message}` }); }

  store.updateDeal(deal.id, { markStatus: o.status });
  return rest.editOriginal(interaction, {
    content: o.status === 'green' ? '✅ Deal als **verfügbar** 🟢 markiert.' : '✅ Deal als **OOS** 🔴 markiert.',
  });
}

module.exports = {
  buildMessage, refreshEmbed, archiveDeal,
  handleNewDeal, handleDealMenge, handleDealStatus, handleDealClose, handleMarkDeal,
};
