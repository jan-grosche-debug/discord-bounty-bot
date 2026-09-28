// Slash-command definitions. Option types: 3=STRING, 4=INTEGER, 10=NUMBER, 6=USER.
// Owner-only enforcement happens in code (role check), not via Discord permissions,
// so the server owner can grant the owner role to whomever they like.

const STRING = 3, INTEGER = 4, USER = 6, NUMBER = 10;

const COMMANDS = [
  {
    name: 'newdeal',
    description: 'Neuen Bounty-Deal anlegen und in #bounty posten',
    dm_permission: false,
    options: [
      { name: 'produkt', description: 'Produktname', type: STRING, required: true },
      { name: 'shop_hinweis', description: 'Grober Einkaufs-Hinweis (KEIN Link)', type: STRING, required: true },
      { name: 'menge_warenkorb', description: 'Menge im Warenkorb (für Gesamt-Anzeige)', type: INTEGER, required: true, min_value: 1 },
      { name: 'ek_brutto', description: 'Einkaufspreis pro Einheit, brutto (€)', type: NUMBER, required: true, min_value: 0 },
      { name: 'vk_sofort', description: 'Verkaufspreis sofort pro Einheit, brutto (€)', type: NUMBER, required: true, min_value: 0 },
      { name: 'shop_link', description: 'Shop-Link (erst im Ticket sichtbar)', type: STRING, required: true },
      { name: 'verfuegbar', description: 'Verfügbare Gesamtmenge (Pool)', type: INTEGER, required: true, min_value: 1 },
      { name: 'hinweis', description: 'Optionaler Zusatz-Hinweis', type: STRING, required: false },
    ],
  },
  {
    name: 'deal-menge',
    description: 'Verfügbare Gesamtmenge (Pool) eines Deals anpassen',
    dm_permission: false,
    options: [
      { name: 'deal_id', description: 'Deal-ID', type: INTEGER, required: true, min_value: 0 },
      { name: 'neue_menge', description: 'Neue verfügbare Gesamtmenge', type: INTEGER, required: true, min_value: 0 },
    ],
  },
  {
    name: 'deal-close',
    description: 'Deal sperren (Teilnahme-Button deaktivieren)',
    dm_permission: false,
    options: [{ name: 'deal_id', description: 'Deal-ID', type: INTEGER, required: true, min_value: 0 }],
  },
  {
    name: 'deal-expire',
    description: 'Deal als „abgelaufen" markieren',
    dm_permission: false,
    options: [{ name: 'deal_id', description: 'Deal-ID', type: INTEGER, required: true, min_value: 0 }],
  },
  {
    name: 'ticket-close',
    description: 'Aktuelles Ticket schließen — im Ticket-Channel ausführen (Kauf abgeschlossen)',
    dm_permission: false,
  },
  {
    name: 'mark-deal-as',
    description: 'Deal-Channel markieren: verfügbar (grün) oder OOS (rot) — im Deal-Channel ausführen',
    dm_permission: false,
    options: [{
      name: 'status', description: 'Status des Deals', type: STRING, required: true,
      choices: [
        { name: 'grün — verfügbar', value: 'green' },
        { name: 'rot — OOS', value: 'red' },
      ],
    }],
  },
];

module.exports = { COMMANDS };
