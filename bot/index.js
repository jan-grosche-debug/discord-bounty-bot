// Discord Bounty Bot — bootstrap & interaction router.
// Run: node bot/index.js                  (start the bot)
//      node bot/index.js --register-only  (just (re)register slash commands)

const fs = require('fs');
const path = require('path');

const { Gateway } = require('../lib/discord/gateway');
const { Rest, CALLBACK, FLAG } = require('../lib/discord/rest');
const fmt = require('../lib/discord/format');
const store = require('./store');
const { COMMANDS } = require('./commands');
const deal = require('./deal');
const ticket = require('./ticket');

const ROOT = path.join(__dirname, '..');
const REGISTER_ONLY = process.argv.includes('--register-only');

// ── config ─────────────────────────────────────────────────────
function loadConfig() {
  const file = path.join(ROOT, 'config.json');
  if (!fs.existsSync(file)) {
    console.error('❌ config.json missing. Copy config.example.json → config.json and fill in the values.');
    process.exit(1);
  }
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!cfg.botToken || /^PASTE_/.test(cfg.botToken)) {
    console.error('❌ No valid botToken in config.json.');
    process.exit(1);
  }
  if (!cfg.guildId || /^PASTE_/.test(cfg.guildId)) {
    console.error('❌ No valid guildId in config.json.');
    process.exit(1);
  }
  return cfg;
}

const config = loadConfig();
fmt.configure({ locale: config.locale, currency: config.currency });
store.init(path.join(ROOT, 'data'));

const rest = new Rest(config.botToken);
const ctx = { rest, store, config, rootDir: ROOT };

// ── helpers ────────────────────────────────────────────────────
function getOpts(interaction) {
  const o = {};
  for (const x of (interaction.data?.options || [])) o[x.name] = x.value;
  return o;
}

function isOwner(interaction) {
  const ownerRole = config.roles && config.roles.owner;
  if (!ownerRole || /^PASTE_/.test(ownerRole)) return null; // not configured
  const roles = interaction.member?.roles || [];
  return roles.includes(ownerRole);
}

function ackEphemeralDeferred(interaction) {
  return rest.respond(interaction, CALLBACK.DEFERRED_CHANNEL_MESSAGE, { flags: FLAG.EPHEMERAL });
}
function replyEphemeral(interaction, content) {
  return rest.respond(interaction, CALLBACK.CHANNEL_MESSAGE, { content, flags: FLAG.EPHEMERAL });
}

// ── command router ─────────────────────────────────────────────
async function onCommand(interaction) {
  const name = interaction.data.name;
  const o = getOpts(interaction);

  const owner = isOwner(interaction);
  if (owner === null) return replyEphemeral(interaction, '⚠️ Owner-Rolle ist nicht in `config.json` gesetzt (roles.owner).');
  if (owner === false) return replyEphemeral(interaction, '⛔ Nur die Owner-Rolle darf diesen Befehl nutzen.');

  // owner-only commands: ack first, then work via editOriginal
  await ackEphemeralDeferred(interaction);
  try {
    switch (name) {
      case 'newdeal':      return await deal.handleNewDeal(ctx, interaction, o);
      case 'deal-menge':   return await deal.handleDealMenge(ctx, interaction, o);
      case 'deal-close':   return await deal.handleDealClose(ctx, interaction, o);
      case 'deal-expire':  return await deal.handleDealStatus(ctx, interaction, o, 'expired');
      case 'ticket-close': return await ticket.handleTicketClose(ctx, interaction);
      case 'mark-deal-as': return await deal.handleMarkDeal(ctx, interaction, o);
      default:             return rest.editOriginal(interaction, { content: `Unbekannter Befehl: ${name}` });
    }
  } catch (e) {
    console.error(`[cmd ${name}]`, e);
    return rest.editOriginal(interaction, { content: `⚠️ Fehler: ${e.message}` }).catch(() => {});
  }
}

// ── component router (buttons) ─────────────────────────────────
async function onComponent(interaction) {
  const id = interaction.data.custom_id || '';
  const [action] = id.split(':');
  switch (action) {
    case 'deal_join':   return ticket.handleJoin(ctx, interaction);
    case 'tkt_qty':     return ticket.handleQtyButton(ctx, interaction);
    case 'tkt_track':   return ticket.handleTrackButton(ctx, interaction);
    case 'tkt_invoice': return ticket.handleInvoice(ctx, interaction);
    case 'tkt_serial':  return ticket.handleSerialButton(ctx, interaction);
    default: return replyEphemeral(interaction, 'Unbekannte Aktion.');
  }
}

// ── modal router ───────────────────────────────────────────────
async function onModal(interaction) {
  const id = interaction.data.custom_id || '';
  const [action] = id.split(':');
  switch (action) {
    case 'tkt_qtymodal':    return ticket.handleQtyModal(ctx, interaction);
    case 'tkt_trackmodal':  return ticket.handleTrackModal(ctx, interaction);
    case 'tkt_serialmodal': return ticket.handleSerialModal(ctx, interaction);
    default: return replyEphemeral(interaction, 'Unbekanntes Formular.');
  }
}

// ── interaction entry ──────────────────────────────────────────
async function onInteraction(interaction) {
  try {
    switch (interaction.type) {
      case 1: return rest.respond(interaction, CALLBACK.PONG, {}); // PING
      case 2: return await onCommand(interaction);                  // APPLICATION_COMMAND
      case 3: return await onComponent(interaction);                // MESSAGE_COMPONENT
      case 5: return await onModal(interaction);                    // MODAL_SUBMIT
      default: return;
    }
  } catch (e) { console.error('[interaction]', e); }
}

// ── boot ───────────────────────────────────────────────────────
async function main() {
  await rest.registerCommands(COMMANDS, config.guildId);
  console.log(`✅ ${COMMANDS.length} slash commands registered (guild ${config.guildId}).`);
  if (REGISTER_ONLY) { console.log('--register-only: done.'); process.exit(0); }

  // application id == bot user id; needed for ticket permission overwrites even
  // before the gateway READY event arrives.
  try { ctx.botUserId = await rest.appId(); } catch {}

  const gw = new Gateway({ token: config.botToken, intents: 0 }); // interactions need no intents
  gw.on('ready', (user) => {
    ctx.botUserId = user.id;
    console.log(`🤖 Logged in as ${user.username}#${user.discriminator || '0'} (${user.id}).`);
  });
  gw.on('interaction', onInteraction);
  gw.on('fatal', (e) => { console.error('[gateway fatal]', e.message); process.exit(1); });
  gw.connect();

  process.on('SIGINT', () => { console.log('\nShutting down…'); gw.stop(); process.exit(0); });
}

main().catch((e) => { console.error('Startup failed:', e); process.exit(1); });
