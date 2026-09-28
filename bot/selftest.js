// Offline self-test — no Discord needed. Verifies pricing math, the atomic
// one-ticket-per-deal reservation model, tracking/invoice, and ticket naming.
//   node bot/selftest.js

const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const calc = require('./calc');
const deal = require('./deal');
const ticket = require('./ticket');
const store = require('./store');
const fmt = require('../lib/discord/format');

let failed = 0;
function check(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); }
  catch (e) { failed++; console.log(`  ❌ ${name}\n     ${e.message}`); }
}
async function acheck(name, fn) {
  try { await fn(); console.log(`  ✅ ${name}`); }
  catch (e) { failed++; console.log(`  ❌ ${name}\n     ${e.message}`); }
}
const near = (a, b, t = 0.011) => Math.abs(a - b) <= t;

console.log('Net price + margin (reference values):');
check('846,64 → 711,46 netto', () => assert(near(calc.netto(846.64, 0.19), 711.46)));
check('450,00 → 378,15 netto', () => assert(near(calc.netto(450, 0.19), 378.15)));
const d1 = calc.computeDeal({ id: 0, cartQty: 2, ekBrutto: 423.32, vkSofortBrutto: 450.0, zielStufen: [], totalQty: 20, reservedQty: 0, vatRate: 0.19 });
check('gross margin/unit 26,68 · 6,30 %', () => { assert(near(d1.stufen[0].bruttoStk, 26.68)); assert(near(d1.stufen[0].bruttoPct, 6.30)); });

console.log('\nPayment terms / number parsing:');
check('"15=454.50; 30=456,75" → 2 tiers', () => { const z = calc.parseZiele('15=454.50; 30=456,75'); assert.strictEqual(z.length, 2); assert(near(z[1].vkBrutto, 456.75)); });
check('DE "12=1.234,50" = 1234.5', () => assert.strictEqual(calc.parseZiele('12=1.234,50')[0].vkBrutto, 1234.5));
check('garbage throws', () => { let t = false; try { calc.parseZiele('12=4x'); } catch { t = true; } assert(t); });

console.log('\nProgress bar & deal embed:');
check('10/20 → 50 %', () => assert(fmt.progressBar(10, 20, 10).includes('50 %')));
const sample = { id: 0, product: 'Samsung 870 EVO 2TB', shopHint: 'Region ES', note: 'Label', cartQty: 2, ekBrutto: 423.32, vkSofortBrutto: 450.0, zielStufen: [{ tage: 30, vkBrutto: 456.75 }], totalQty: 20, reservedQty: 5, vatRate: 0.19, status: 'open', progressBarSegments: 10 };
check('buildMessage() + join button', () => { const m = deal.buildMessage(sample); assert(m.embeds[0].description); assert.strictEqual(m.components[0].components[0].custom_id, 'deal_join:0'); });

console.log('\nTicket naming:');
check('slug "Samsung 870 EVO 2TB" → samsung-870-evo-2tb', () => assert.strictEqual(ticket.slug('Samsung 870 EVO 2TB', 50), 'samsung-870-evo-2tb'));

(async () => {
  console.log('\nOne ticket per (member, deal) + pool reservation (pool 5):');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-'));
  store.init(tmp);
  const id = store.nextDealId();
  store.addDeal({ id, product: 'Test-SSD', cartQty: 1, ekBrutto: 100, vkSofortBrutto: 120, zielStufen: [{ tage: 30, vkBrutto: 125 }], totalQty: 5, reservedQty: 0, vatRate: 0.19, status: 'open', progressBarSegments: 10, channelId: 'c', messageId: 'm' });
  const nA = store.nextTicketNo(); store.createTicket('A', id, 'chA', nA);
  const nB = store.nextTicketNo(); store.createTicket('B', id, 'chB', nB);

  check('ticket numbers sequential (1, 2)', () => { assert.strictEqual(nA, 1); assert.strictEqual(nB, 2); });
  check('exactly 2 tickets for the deal, 1 per member', () => {
    assert.strictEqual(store.listTicketsByDeal(id).length, 2);
    assert.strictEqual(store.getTicket('A', id).channelId, 'chA');
    store.createTicket('A', id, 'chA-DUP', 99); // no second ticket
    assert.strictEqual(store.listTicketsByDeal(id).length, 2);
  });

  await acheck('A reserves 3 → 2 left', async () => { const r = await store.setTicketQty(id, 'A', 3, 'A'); assert(r.ok && r.available === 2); });
  await acheck('B wants 3 → rejected (only 2 left)', async () => { const r = await store.setTicketQty(id, 'B', 3, 'B'); assert(!r.ok && r.reason === 'insufficient' && r.available === 2); });
  await acheck('B reserves 2 → pool empty, exhausted', async () => { const r = await store.setTicketQty(id, 'B', 2, 'B'); assert(r.ok && r.available === 0); assert.strictEqual(store.getDeal(id).status, 'exhausted'); });
  await acheck('A reduces 3→1 → open, 2 left', async () => { const r = await store.setTicketQty(id, 'A', 1, 'A'); assert(r.ok && r.available === 2); assert.strictEqual(store.getDeal(id).status, 'open'); });

  await acheck('payment term + tracking + invoice shown in panel', async () => {
    store.setTicketZiel('A', id, '30');
    store.addTracking('A', id, { code: '00123', qty: 1, by: 'A' });
    store.setTicketInvoice('A', id, { messageId: 'x', url: 'u', filename: 'rechnung.pdf', by: 'A' });
    const p = ticket.buildPanel(store.getDeal(id), store.getTicket('A', id), 'A');
    const desc = p.embeds[0].description;
    assert(desc.includes('30 Tage') && desc.includes('00123') && desc.includes('rechnung.pdf'));
    assert.strictEqual(p.components[0].components[0].custom_id, `tkt_qty:${id}:A`);
  });

  await acheck('oversell protection under load (10×1 parallel, pool 3)', async () => {
    const d2 = store.nextDealId();
    store.addDeal({ id: d2, product: 'Race', cartQty: 1, ekBrutto: 10, vkSofortBrutto: 12, zielStufen: [], totalQty: 3, reservedQty: 0, vatRate: 0.19, status: 'open', progressBarSegments: 10 });
    for (let i = 0; i < 10; i++) { const n = store.nextTicketNo(); store.createTicket('m' + i, d2, 'c' + i, n); }
    const results = await Promise.all([...Array(10)].map((_, i) => store.setTicketQty(d2, 'm' + i, 1, 'm' + i)));
    assert.strictEqual(results.filter((r) => r.ok).length, 3);
    assert.strictEqual(store.getDeal(d2).reservedQty, 3);
  });

  check('pickInvoiceAttachment: newest PDF of the member / else null', () => {
    const pick = ticket.pickInvoiceAttachment([
      { id: '2', author: { id: 'A' }, attachments: [{ filename: 'neu.pdf', content_type: 'application/pdf' }] },
      { id: '1', author: { id: 'A' }, attachments: [{ filename: 'bild.png' }] },
    ], 'A');
    assert(pick && pick.filename === 'neu.pdf');
    assert.strictEqual(ticket.pickInvoiceAttachment([{ id: '1', author: { id: 'A' }, attachments: [{ filename: 'x.png' }] }], 'A'), null);
  });

  check('closing a deal clears its tickets', () => {
    for (const t of store.listTicketsByDeal(id)) store.removeTicket(t.memberId, t.dealId);
    assert.strictEqual(store.listTicketsByDeal(id).length, 0);
  });

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failed === 0 ? '\n🎉 All tests passed.' : `\n💥 ${failed} test(s) failed.`);
  process.exit(failed === 0 ? 0 : 1);
})();
