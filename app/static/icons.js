"use strict";

// Ikony liniowe w jednym stylu (24×24, linia 1.6, kolor = currentColor).
// Własne rysunki – zastępują kolorowe emotki, żeby całość wyglądała spójnie.
const ICON_PATHS = {
  // nawigacja i interfejs
  dashboard: '<rect x="3.5" y="3.5" width="7" height="8" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="5" rx="1.5"/><rect x="13.5" y="11.5" width="7" height="9" rx="1.5"/><rect x="3.5" y="14.5" width="7" height="6" rx="1.5"/>',
  plus: '<circle cx="12" cy="12" r="8.5"/><path d="M12 8v8M8 12h8"/>',
  receipt: '<path d="M6 3.5h12v17l-2-1.3-2 1.3-2-1.3-2 1.3-2-1.3-2 1.3z"/><path d="M9 8h6M9 11.5h6M9 15h3.5"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="15.5" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
  list: '<path d="M9 6.5h11M9 12h11M9 17.5h11"/><circle cx="4.8" cy="6.5" r=".9"/><circle cx="4.8" cy="12" r=".9"/><circle cx="4.8" cy="17.5" r=".9"/>',
  target: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.8"/><circle cx="12" cy="12" r="1.2"/>',
  settings: '<path d="M4 7h9M17 7h3M4 12h3M11 12h9M4 17h11M19 17h1"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="17" r="2"/>',
  cloud: '<path d="M7.5 18.5h9.5a4 4 0 0 0 .6-7.95A5.8 5.8 0 0 0 6.4 9.4 4.5 4.5 0 0 0 7.5 18.5z"/>',
  cloudOff: '<path d="M7.5 18.5h9.5a4 4 0 0 0 1.6-.3M20.7 15.3a4 4 0 0 0-3.1-4.75A5.8 5.8 0 0 0 9 6.2M6.6 9.1a4.5 4.5 0 0 0 .9 9.4M3.5 3.5l17 17"/>',
  refresh: '<path d="M19.5 11A7.5 7.5 0 0 0 6 6.6L4.5 8M4.5 4.5V8H8M4.5 13A7.5 7.5 0 0 0 18 17.4l1.5-1.4M19.5 19.5V16H16"/>',
  alert: '<path d="M12 4 21 19.5H3z"/><path d="M12 10v4.5M12 17v.01"/>',
  sparkle: '<path d="M11 3.5 12.7 8.8 18 10.5 12.7 12.2 11 17.5 9.3 12.2 4 10.5 9.3 8.8z"/><path d="M18 15l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z"/>',
  camera: '<path d="M4.5 8h2.8l1.8-2.5h5.8L16.7 8h2.8a1 1 0 0 1 1 1v9.5a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z"/><circle cx="12" cy="13.3" r="3.4"/>',
  edit: '<path d="M4.5 19.5h3.8L18.6 9.2a2 2 0 0 0-2.8-2.8L5.5 16.7z"/><path d="M14.3 8l2.7 2.7"/>',
  close: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
  chevLeft: '<path d="M14.5 5.5 8 12l6.5 6.5"/>',
  chevRight: '<path d="M9.5 5.5 16 12l-6.5 6.5"/>',
  newChat: '<path d="M13.5 3.5H6.5a1 1 0 0 0-1 1v15a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1v-11z"/><path d="M13.5 3.5v5h5M12 11.5v6M9 14.5h6"/>',
  search: '<circle cx="10.8" cy="10.8" r="6.3"/><path d="m19.5 19.5-4.2-4.2"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  checkCircle: '<circle cx="12" cy="12" r="8.5"/><path d="m8.2 12.3 2.6 2.6 5-5.2"/>',
  circle: '<circle cx="12" cy="12" r="8.5"/>',
  bell: '<path d="M6.5 16v-5a5.5 5.5 0 0 1 11 0v5l1.8 2H4.7z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>',
  bulb: '<path d="M9.3 17.5h5.4M10.2 20.5h3.6M12 3.5a5.7 5.7 0 0 0-3.4 10.3c.6.5 1 1.3 1 2.2h4.8c0-.9.4-1.7 1-2.2A5.7 5.7 0 0 0 12 3.5z"/>',
  gem: '<path d="M7 4h10l3.5 5L12 20 3.5 9z"/><path d="M3.5 9h17M9.5 4 8 9l4 11 4-11-1.5-5"/>',
  shield: '<path d="M12 3.5 19.5 6v5.8c0 4.3-3.2 7.6-7.5 8.7-4.3-1.1-7.5-4.4-7.5-8.7V6z"/>',
  shieldCheck: '<path d="M12 3.5 19.5 6v5.8c0 4.3-3.2 7.6-7.5 8.7-4.3-1.1-7.5-4.4-7.5-8.7V6z"/><path d="m8.8 12.2 2.3 2.3 4.3-4.6"/>',
  users: '<circle cx="9" cy="8.5" r="3.3"/><path d="M3 19.5a6 6 0 0 1 12 0"/><circle cx="16.8" cy="9.3" r="2.4"/><path d="M16.3 14a4.7 4.7 0 0 1 4.7 5.5"/>',
  tag: '<path d="M3.5 12V4.5a1 1 0 0 1 1-1H12l8.5 8.5-8.5 8.5z"/><circle cx="7.8" cy="7.8" r="1.4"/>',
  download: '<path d="M12 4v11M7.5 10.5 12 15l4.5-4.5M5 19.5h14"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5M12 7.8v.01"/>',
  flag: '<path d="M5.5 20.5v-16M5.5 4.5h11l-2 4 2 4h-11"/>',
  trendUp: '<path d="m3.5 16.5 6-6 4 4 7-7M15 7.5h5.5V13"/>',
  wallet: '<path d="M4.5 7.5h14a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1h-14a1 1 0 0 1-1-1v-12a2 2 0 0 1 2-2h11"/><path d="M15.5 13.5h4v-3h-4a1.5 1.5 0 0 0 0 3z"/>',
  // kategorie
  cart: '<path d="M3 4.5h2.2l2.2 10.3a1 1 0 0 0 1 .8h8.9a1 1 0 0 0 1-.8L20 8H6"/><circle cx="9.2" cy="19.5" r="1.2"/><circle cx="16.8" cy="19.5" r="1.2"/>',
  zap: '<path d="M13 3 5 13.5h6.2L10.5 21l8-10.5h-6.2z"/>',
  flame: '<path d="M12 21a6.5 6.5 0 0 0 6.5-6.5c0-3.4-2.3-5.6-3.6-7.6-.4 1.9-1.4 3.2-2.8 3.7.3-2.9-.8-5.8-3.6-7.6.2 3.7-4.9 6-4.9 11.5A6.5 6.5 0 0 0 12 21z"/>',
  droplet: '<path d="M12 3.5s6 6.4 6 10.8a6 6 0 0 1-12 0C6 9.9 12 3.5 12 3.5z"/>',
  heater: '<rect x="3.5" y="5.5" width="17" height="12" rx="2"/><path d="M8 5.5v12M12 5.5v12M16 5.5v12M6 20.5v-3M18 20.5v-3"/>',
  home: '<path d="M3.5 11 12 4l8.5 7"/><path d="M5.5 9.5v11h13v-11M10 20.5v-6h4v6"/>',
  bank: '<path d="M3.5 9 12 4.5 20.5 9z"/><path d="M5.5 9v8.5M9.8 9v8.5M14.2 9v8.5M18.5 9v8.5M3.5 20.5h17M4 17.5h16"/>',
  wifi: '<path d="M2.5 9.5a14 14 0 0 1 19 0M5.5 13a9.5 9.5 0 0 1 13 0M8.8 16.4a5 5 0 0 1 6.4 0"/><circle cx="12" cy="19.5" r=".8"/>',
  phone: '<rect x="7" y="3" width="10" height="18" rx="2"/><path d="M11 18h2"/>',
  fuel: '<path d="M4.5 20.5v-15a2 2 0 0 1 2-2h5a2 2 0 0 1 2 2v15M3.5 20.5h11M4.5 10.5h9"/><path d="M13.5 8.5h1.8a1.7 1.7 0 0 1 1.7 1.7v5.6a1.5 1.5 0 0 0 3 0V8.2L17.5 5.7"/>',
  bus: '<rect x="4.5" y="3.5" width="15" height="14" rx="2"/><path d="M4.5 11h15M8 17.5v3M16 17.5v3"/><circle cx="8" cy="14.3" r=".8"/><circle cx="16" cy="14.3" r=".8"/>',
  car: '<path d="M3.5 13 5.4 7.6A2 2 0 0 1 7.3 6.3h9.4a2 2 0 0 1 1.9 1.3l1.9 5.4v5a1 1 0 0 1-1 1h-1.5a1 1 0 0 1-1-1v-1H7v1a1 1 0 0 1-1 1H4.5a1 1 0 0 1-1-1z"/><path d="M3.5 13h17"/><circle cx="7.5" cy="15.3" r=".8"/><circle cx="16.5" cy="15.3" r=".8"/>',
  pill: '<rect x="3" y="8.6" width="18" height="6.8" rx="3.4" transform="rotate(-45 12 12)"/><path d="m8.6 8.6 6.8 6.8"/>',
  heart: '<path d="M20.3 9a4.8 4.8 0 0 0-8.3-3.1A4.8 4.8 0 0 0 3.7 9c0 5.2 8.3 11 8.3 11s8.3-5.8 8.3-11z"/>',
  child: '<circle cx="12" cy="6.8" r="3.3"/><path d="M6.5 20.5v-3.5a5.5 5.5 0 0 1 11 0v3.5"/>',
  shirt: '<path d="M8.5 3.5 3.5 6.3l1.8 3.9 2-1v11.3h9.4V9.2l2 1 1.8-3.9-5-2.8a3.5 3.5 0 0 1-7 0z"/>',
  film: '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M7.5 4.5v15M16.5 4.5v15M3.5 9.5h4M3.5 14.5h4M16.5 9.5h4M16.5 14.5h4"/>',
  box: '<path d="M3.5 7.5 12 3.5l8.5 4v9L12 20.5l-8.5-4z"/><path d="m3.5 7.5 8.5 4 8.5-4M12 11.5v9"/>',
  briefcase: '<rect x="3.5" y="7" width="17" height="12.5" rx="2"/><path d="M8.5 7V5.5a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2V7M3.5 12.5h17"/>',
  gift: '<rect x="3.5" y="8" width="17" height="4" rx="1"/><path d="M5.5 12v8.5h13V12M12 8v12.5M12 8S10.5 3.5 8 4.5c-2 .8-.8 3.5 4 3.5zM12 8s1.5-4.5 4-3.5c2 .8.8 3.5-4 3.5z"/>',
  hourglass: '<path d="M6.5 3.5h11M6.5 20.5h11M7.5 3.5V6l4.5 6 4.5-6V3.5M7.5 20.5V18l4.5-6 4.5 6v2.5"/>',
  percent: '<path d="M18.5 5.5 5.5 18.5"/><circle cx="7.5" cy="7.5" r="2.3"/><circle cx="16.5" cy="16.5" r="2.3"/>',
  coins: '<ellipse cx="9.5" cy="7" rx="6" ry="2.8"/><path d="M3.5 7v3.8c0 1.5 2.7 2.8 6 2.8M15.5 7v2"/><ellipse cx="14.5" cy="13" rx="6" ry="2.8"/><path d="M8.5 13v4.2c0 1.5 2.7 2.8 6 2.8s6-1.3 6-2.8V13"/>',
  wrench: '<path d="M14.7 4a4.8 4.8 0 0 0-5.3 6.5L3.5 16.4v4.1h4.1l5.9-5.9A4.8 4.8 0 0 0 20 9.3l-2.8 2.8-3.2-.9-.9-3.2z"/>',
  cake: '<path d="M4 20.5h16M5.5 20.5v-8h13v8M5.5 15.5c2.2 1.4 4.3 1.4 6.5 0s4.3-1.4 6.5 0M12 12.5V9M12 6.2v.01"/>',
  doc: '<path d="M13.5 3.5h-7v17h11v-13z"/><path d="M13.5 3.5v4h4M9 12h6M9 15.5h6"/>',
  tire: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="3.3"/><path d="M12 3.5v5.2M12 15.3v5.2M3.5 12h5.2M15.3 12h5.2"/>',
  sun: '<circle cx="12" cy="12" r="3.8"/><path d="M12 2.5v2M12 19.5v2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M2.5 12h2M19.5 12h2M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/>',
  lifebuoy: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="3.8"/><path d="m6 6 3.3 3.3M14.7 14.7 18 18M18 6l-3.3 3.3M9.3 14.7 6 18"/>',
  cap: '<path d="m2.5 9.5 9.5-5 9.5 5-9.5 5z"/><path d="M6.5 11.7v4.6c3 2.3 8 2.3 11 0v-4.6M21.5 9.5v5.5"/>',
  hammer: '<path d="m13.5 9.5-9 9 2 2 9-9M12 6l2-2.5 6.5 6.5-2.5 2-2-2-2 2-2-2z"/>',
};

/** Ikona SVG po nazwie (pusty string, gdy nie ma takiej ikony). */
function svgIcon(name, cls = "") {
  const d = ICON_PATHS[name];
  return d ? `<svg class="i ${cls}" viewBox="0 0 24 24" aria-hidden="true">${d}</svg>` : "";
}

/** Wstawia ikony w elementy z atrybutem data-icon (statyczny HTML). */
function hydrateIcons(root = document) {
  root.querySelectorAll("[data-icon]").forEach((el) => {
    if (el.dataset.iconDone) return;
    el.insertAdjacentHTML("afterbegin", svgIcon(el.dataset.icon));
    el.dataset.iconDone = "1";
  });
}
