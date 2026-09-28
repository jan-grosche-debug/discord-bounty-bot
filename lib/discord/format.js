// Formatting helpers — money, percent, progress bar, colors. Zero-dependency.

let LOCALE = 'de-DE';
let CURRENCY = 'EUR';

function configure({ locale, currency } = {}) {
  if (locale) LOCALE = locale;
  if (currency) CURRENCY = currency;
}

// 1112.32 -> "1.112,32 €"
function eur(n) {
  const v = Number.isFinite(Number(n)) ? Number(n) : 0;
  try {
    return v.toLocaleString(LOCALE, {
      style: 'currency', currency: CURRENCY,
      minimumFractionDigits: 2, maximumFractionDigits: 2,
    });
  } catch {
    return `${v.toFixed(2).replace('.', ',')} €`;
  }
}

// 6.3 -> "6,30 %"
function pct(n) {
  const v = Number.isFinite(Number(n)) ? Number(n) : 0;
  return `${v.toFixed(2).replace('.', ',')} %`;
}

// progressBar(10, 20) -> "▰▰▰▰▰▱▱▱▱▱ 50 % (10 / 20 offen)"
function progressBar(available, total, segments = 10) {
  const a = Math.max(0, Number(available) || 0);
  const t = Math.max(0, Number(total) || 0);
  const ratio = t > 0 ? Math.min(1, a / t) : 0;
  const filled = Math.round(ratio * segments);
  const bar = '▰'.repeat(filled) + '▱'.repeat(Math.max(0, segments - filled));
  const percent = Math.round(ratio * 100);
  return `${bar} ${percent} % (${a} / ${t} offen)`;
}

const COLOR = {
  GREEN: 0x2ecc71,
  RED: 0xe74c3c,
  GREY: 0x95a5a6,
  BLUE: 0x3498db,
};

module.exports = { configure, eur, pct, progressBar, COLOR };
