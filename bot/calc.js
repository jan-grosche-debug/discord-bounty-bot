// Pricing math for a deal. Pure functions, no I/O, fully unit-testable.
//
// Verified against reference values:
//   netto  = brutto / (1 + vat)            846,64 → 711,46  ·  450 → 378,15
//   gewinn = VK - EK (brutto basis)        450 - 423,32 = 26,68 /Stk  → 6,30 %
// We additionally compute the netto-basis margin (VK_netto - EK_netto).

function round2(n) { return Math.round((Number(n) + Number.EPSILON) * 100) / 100; }

function netto(brutto, vat) { return round2(Number(brutto) / (1 + Number(vat))); }

// Robust money parse: accepts German ("1.234,50" / "454,50") and English
// ("1,234.50" / "454.50"). Strips thousands separators and rejects trailing
// garbage. Returns NaN if invalid (so the caller can throw a clear error).
function parseMoney(raw) {
  let s = String(raw).trim();
  const hasDot = s.includes('.');
  const hasComma = s.includes(',');
  if (hasDot && hasComma) {
    // the LAST separator is the decimal point; the other is a thousands sep
    if (s.lastIndexOf(',') > s.lastIndexOf('.')) s = s.replace(/\./g, '').replace(',', '.');
    else s = s.replace(/,/g, '');
  } else if (hasComma) {
    s = s.replace(',', '.'); // comma is the decimal separator (German)
  }
  if (!/^-?\d+(\.\d+)?$/.test(s)) return NaN;
  return Number(s);
}

// "15=454.50; 30=456,75" -> [{tage:15, vkBrutto:454.5}, {tage:30, vkBrutto:456.75}]
function parseZiele(str) {
  if (!str || !String(str).trim()) return [];
  return String(str)
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((pair) => {
      const [t, v] = pair.split('=').map((x) => (x || '').trim());
      const tage = /^\d+$/.test(t) ? parseInt(t, 10) : NaN;
      const vkBrutto = parseMoney(v);
      if (!Number.isFinite(tage) || !Number.isFinite(vkBrutto)) {
        throw new Error(`Ungültige Ziel-Stufe: "${pair}" (erwartet z.B. 15=454.50)`);
      }
      return { tage, vkBrutto };
    })
    .sort((a, b) => a.tage - b.tage);
}

function gewinn(vkBrutto, ekBrutto, vat, cartQty) {
  const vkN = netto(vkBrutto, vat);
  const ekN = netto(ekBrutto, vat);
  const bruttoStk = round2(vkBrutto - ekBrutto);
  const nettoStk = round2(vkN - ekN);
  return {
    vkBrutto: round2(vkBrutto),
    vkNetto: vkN,
    bruttoStk,
    bruttoGesamt: round2(bruttoStk * cartQty),
    bruttoPct: ekBrutto > 0 ? round2((bruttoStk / ekBrutto) * 100) : 0,
    nettoStk,
    nettoGesamt: round2(nettoStk * cartQty),
    nettoPct: ekN > 0 ? round2((nettoStk / ekN) * 100) : 0,
  };
}

// Full computed view for embed rendering.
function computeDeal(deal) {
  const vat = deal.vatRate ?? 0.19;
  const cartQty = deal.cartQty;
  const ekNetto = netto(deal.ekBrutto, vat);

  const stufen = [];
  // Sofort is always present
  stufen.push({
    label: 'Sofort', tage: null,
    ...gewinn(deal.vkSofortBrutto, deal.ekBrutto, vat, cartQty),
  });
  for (const z of (deal.zielStufen || [])) {
    stufen.push({
      label: `Auf Ziel (${z.tage} Tage)`, tage: z.tage,
      ...gewinn(z.vkBrutto, deal.ekBrutto, vat, cartQty),
    });
  }

  const reserved = deal.reservedQty || 0;
  const available = Math.max(0, (deal.totalQty || 0) - reserved);

  return {
    vat,
    cart: {
      ekBrutto: round2(deal.ekBrutto),
      ekNetto,
      cartQty,
      gesamtBrutto: round2(deal.ekBrutto * cartQty),
      gesamtNetto: round2(ekNetto * cartQty),
    },
    stufen,
    availability: {
      total: deal.totalQty || 0,
      reserved,
      available,
      percent: deal.totalQty > 0 ? Math.round((available / deal.totalQty) * 100) : 0,
    },
  };
}

module.exports = { round2, netto, parseZiele, gewinn, computeDeal };
