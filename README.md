# Discord Bounty Bot

A **zero-dependency** Discord bot for group-buy / bounty servers in the reselling space. The server owner posts buying deals ("bounties"). Members join through private tickets, reserve quantities from a shared pool, and submit tracking numbers, serial numbers and invoices. The whole purchase-to-payout flow runs inside Discord.

Built as a freelance project for a client's reselling community. It has been running 24/7 on a Linux VPS.

> Client-specific data (bot token, server/channel IDs, billing details, branding) has been removed. You configure everything yourself via `config.json`.

## Highlights

- **No npm packages at all.** Uses its own Discord layer: a minimal RFC 6455 WebSocket client (`lib/discord/ws.js`), a Gateway client with heartbeat, resume and backoff (`gateway.js`), and a REST client with rate-limit handling and multipart uploads (`rest.js`).
- **Automatic deal math.** The owner enters only raw prices. The bot calculates net prices, gross and net margin per unit and in total, percentages, and payment-term tiers (e.g. `15=454.50; 30=456.75`).
- **Atomic quantity reservation.** A keyed async mutex prevents overselling. The test suite covers this: 10 parallel requests against a pool of 3 give exactly 3 successes.
- **Private tickets.** There is one ticket channel per member and deal, with permission overwrites and a button panel for quantity, serial number, tracking and invoice.
- **Invoice detection without privileged intents.** The bot scans the ticket history via REST for the member's newest PDF.
- **Deal lifecycle.** Channels are marked available or out of stock, sold-out or closed deals are archived automatically, and members earn role tiers based on how many deals they have completed.
- **Survives restarts.** State lives in a JSON store with atomic writes, and button IDs are stable, so old messages keep working.

## Commands (owner role only)

| Command | Effect |
|---|---|
| `/newdeal` | Create a deal → its own channel with an embed and a join button |
| `/deal-menge` | Change the available pool (never below what members have already reserved) |
| `/deal-close` | Close the deal, post it to the archive, delete the channel |
| `/deal-expire` | Mark the deal as expired |
| `/mark-deal-as` | Rename the deal channel 🟢 available / 🔴 OOS |
| `/ticket-close` | Close the ticket, count the completed deal, award tier roles |

The bot's user interface is in German, because the target community is in Germany.

## Project structure

```
bot/
  index.js      bootstrap + interaction router
  commands.js   slash-command definitions
  calc.js       pricing math (pure functions)
  deal.js       deal embeds + lifecycle
  ticket.js     ticket channels, panels, modals, invoice detection
  store.js      JSON store, atomic writes, keyed mutex
  selftest.js   offline test suite
lib/discord/
  ws.js         RFC 6455 WebSocket client (tls + crypto only)
  gateway.js    Discord Gateway v10
  rest.js       Discord REST v10
  format.js     currency, percent, progress bar
```

## Setup

1. Create a bot in the [Discord Developer Portal](https://discord.com/developers/applications) and invite it with the scopes `bot` + `applications.commands`. It needs these permissions: Manage Channels, Manage Roles, Send Messages, Embed Links, Attach Files, Read Message History.
2. Copy `config.example.json` to `config.json` and fill in the token and IDs.
3. Run `node bot/index.js` (Node.js ≥ 18).

To run it 24/7 on a Linux server, use the included `bounty-bot.service` systemd unit.

## Tests

```bash
npm test   # node bot/selftest.js — runs offline, no Discord needed
```

## License

MIT
