/* ============================================================
   WL Livraison — Application (PWA autonome)
   Écrans : Accueil (journées) · Itinéraire · Détail d'un arrêt
   Adresses : Photon (gratuit, sans clé), limité au Québec.
   Trajets : OSRM (gratuit, sans clé) + optimisation par secteur.
   Données : voir data.js — enregistrement automatique immédiat.
   ============================================================ */
(function () {
  "use strict";

  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const CFG = window.WL_CONFIG || {};
  const WH = CFG.WAREHOUSE || { label: "540 Rue de l'Argon, Québec, G2N 2E1", lat: 46.858, lng: -71.272 };
  const PROFILES = CFG.PROFILES || ["William", "Loucas", "Zach", "Mahmoud"];
  const JOURS = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];
  const MOIS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
  const MOIS_C = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."];

  const DB = () => window.Store.data;
  const uid = () => window.Store.uid();

  let currentView = "home";
  let currentDayId = null;
  let currentStopId = null;
  let pendingDuplicateFrom = null;

  /* ---------------- Utilitaires ---------------- */
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function toast(msg, ms) {
    const t = $("#toast");
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(t._h);
    t._h = setTimeout(() => { t.hidden = true; }, ms || 2600);
  }
  window.WL_toast = toast;

  function isoToDate(iso) { const p = iso.split("-"); return new Date(+p[0], +p[1] - 1, +p[2]); }
  function dateToISO(d) {
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }
  function todayISO() { return dateToISO(new Date()); }
  function addDaysISO(iso, n) { const d = isoToDate(iso); d.setDate(d.getDate() + n); return dateToISO(d); }
  function fmtDayLong(iso) {
    const d = isoToDate(iso);
    return JOURS[d.getDay()] + " " + d.getDate() + " " + MOIS[d.getMonth()] + " " + d.getFullYear();
  }
  function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
  function fmtDayShort(iso) { const d = isoToDate(iso); return d.getDate() + " " + MOIS_C[d.getMonth()]; }
  function fmtClock(min) { // 531 -> "08:51"
    if (min == null) return "—";
    return String(Math.floor(min / 60)).padStart(2, "0") + ":" + String(Math.round(min % 60)).padStart(2, "0");
  }
  function fmtH(min) { // 600 -> "10 h", 630 -> "10 h 30"
    if (min == null) return "";
    const h = Math.floor(min / 60), m = Math.round(min % 60);
    return m ? h + " h " + String(m).padStart(2, "0") : h + " h";
  }
  function fmtDur(min) { // 169 -> "2h 49m"
    if (min == null) return "—";
    min = Math.round(min);
    return Math.floor(min / 60) + "h " + String(min % 60).padStart(2, "0") + "m";
  }
  function timeToMin(v) { if (!v) return null; const p = v.split(":"); return (+p[0]) * 60 + (+p[1]); }
  function minToTime(m) {
    if (m == null) return "";
    return String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0");
  }
  function normalizeKey(addr) {
    return String(addr || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, " ").trim();
  }
  function debounce(fn, ms) { let h; return (...a) => { clearTimeout(h); h = setTimeout(() => fn(...a), ms); }; }

  function getDay(id) { return DB().days.find((d) => d.id === id) || null; }
  function getStop(id) { return DB().stops.find((s) => s.id === id) || null; }
  function getDayStops(dayId) {
    return DB().stops.filter((s) => s.dayId === dayId && !s.deletedAt).sort((a, b) => (a.position || 0) - (b.position || 0));
  }
  function dayStartMin(day) { return timeToMin(day.startTime || CFG.START_TIME || "08:00") || 480; }

  /* ---------------- Feuilles génériques ---------------- */
  function openSheet(id) { $("#" + id).hidden = false; }
  function closeSheet(id) { $("#" + id).hidden = true; }
  $$("[data-close]").forEach((b) => b.addEventListener("click", () => closeSheet(b.dataset.close)));
  $$(".sheet-backdrop").forEach((bd) => bd.addEventListener("click", (e) => { if (e.target === bd) bd.hidden = true; }));

  function actionSheet(title, items) {
    const old = $("#dynSheet"); if (old) old.remove();
    const bd = document.createElement("div");
    bd.className = "sheet-backdrop"; bd.id = "dynSheet";
    bd.innerHTML = `<div class="sheet"><h2>${esc(title)}</h2><div class="dyn-items"></div>
      <button class="btn-sheet-cancel" id="dynCancel">Annuler</button></div>`;
    const box = $(".dyn-items", bd);
    items.forEach((it) => {
      const b = document.createElement("button");
      b.className = "picker-item" + (it.danger ? " danger" : "");
      b.textContent = it.label;
      b.addEventListener("click", () => { bd.remove(); it.fn && it.fn(); });
      box.appendChild(b);
    });
    $("#dynCancel", bd).addEventListener("click", () => bd.remove());
    bd.addEventListener("click", (e) => { if (e.target === bd) bd.remove(); });
    document.body.appendChild(bd);
  }

  /* ================================================================
     RECHERCHE D'ADRESSES — Google Places d'abord (précis, au numéro
     civique), repli automatique sur Photon (OpenStreetMap) si la
     clé Google est absente ou si Google ne répond pas.
     ================================================================ */
  const GKEY = (window.WL_CONFIG && window.WL_CONFIG.GOOGLE_MAPS_KEY) || "";
  let gSession = null;
  function googleSession() {
    if (!gSession) gSession = (window.crypto && crypto.randomUUID) ? crypto.randomUUID()
      : Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
    return gSession;
  }

  async function googleSearch(q) {
    const r = await fetch("https://places.googleapis.com/v1/places:autocomplete", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Goog-Api-Key": GKEY },
      body: JSON.stringify({
        input: q, languageCode: "fr", regionCode: "CA",
        locationBias: { circle: { center: { latitude: 46.858, longitude: -71.272 }, radius: 50000 } },
        sessionToken: googleSession()
      })
    });
    if (!r.ok) throw new Error("Google Places " + r.status);
    const j = await r.json();
    const out = [];
    (j.suggestions || []).forEach((s) => {
      const p = s.placePrediction || {};
      const main = (p.structuredFormat && p.structuredFormat.mainText && p.structuredFormat.mainText.text) || (p.text && p.text.text) || "";
      const sub = (p.structuredFormat && p.structuredFormat.secondaryText && p.structuredFormat.secondaryText.text) || "";
      if (!p.placeId || !main) return;
      out.push({ _placeId: p.placeId, street: main, sector: sub, city: "", postal: "", address: [main, sub].filter(Boolean).join(", "), lat: null, lng: null });
    });
    return out;
  }

  async function googleDetails(item) {
    const r = await fetch("https://places.googleapis.com/v1/places/" + encodeURIComponent(item._placeId) +
      "?sessionToken=" + encodeURIComponent(googleSession()), {
      headers: { "X-Goog-Api-Key": GKEY, "X-Goog-FieldMask": "formattedAddress,addressComponents,location" }
    });
    if (!r.ok) throw new Error("Google Details " + r.status);
    const j = await r.json();
    gSession = null; // la session se termine au choix (facturation par session)
    const comp = {};
    (j.addressComponents || []).forEach((c) => { (c.types || []).forEach((t) => { if (!comp[t]) comp[t] = c.longText || ""; }); });
    const streetLine = [comp.street_number, comp.route].filter(Boolean).join(" ") || item.street;
    const city = comp.locality || comp.administrative_area_level_2 || "";
    const sector = comp.sublocality_level_1 || comp.sublocality || city;
    return {
      address: j.formattedAddress || item.address, street: streetLine, city, sector,
      postal: comp.postal_code || "",
      lat: j.location ? j.location.latitude : null, lng: j.location ? j.location.longitude : null
    };
  }

  async function photonSearch(q) {
    const url = "https://photon.komoot.io/api/?q=" + encodeURIComponent(q) +
      "&limit=8&lat=46.85&lon=-71.28&lang=fr";
    const r = await fetch(url);
    const j = await r.json();
    const out = [];
    (j.features || []).forEach((f) => {
      const p = f.properties || {};
      const cc = (p.countrycode || "").toUpperCase();
      const isQC = /qu[ée]bec/i.test(p.state || "") || /^G/i.test(p.postcode || "");
      if (!(cc === "CA" || /canada/i.test(p.country || "")) || !isQC) return;
      const streetLine = [p.housenumber, p.street].filter(Boolean).join(" ") || p.name || "";
      if (!streetLine) return;
      const city = p.city || p.town || p.village || "";
      const sector = p.district || city || "";
      const full = [streetLine, sector, "Québec", p.postcode].filter(Boolean).join(", ");
      out.push({
        address: full, street: streetLine, city, sector,
        postal: p.postcode || "",
        lat: f.geometry.coordinates[1], lng: f.geometry.coordinates[0]
      });
    });
    return out;
  }

  function attachAutocomplete(input, box, onPick) {
    const run = debounce(async () => {
      const q = input.value.trim();
      if (q.length < 3) { box.hidden = true; box.innerHTML = ""; return; }
      try {
        let res = null;
        if (GKEY) { try { res = await googleSearch(q); } catch (e) { res = null; } }
        if (!res) res = await photonSearch(q);
        box.innerHTML = "";
        res.forEach((r) => {
          const b = document.createElement("button");
          b.type = "button"; b.className = "suggest-item";
          b.innerHTML = esc(r.street) + "<small>" + esc([r.sector, r.city, r.postal].filter(Boolean).join(", ")) + "</small>";
          b.addEventListener("click", async () => {
            box.hidden = true;
            if (r._placeId) {
              try { onPick(await googleDetails(r)); return; }
              catch (e) { onPick(r); return; }
            }
            onPick(r);
          });
          box.appendChild(b);
        });
        const man = document.createElement("button");
        man.type = "button"; man.className = "suggest-item manual";
        man.textContent = "Ajouter sans suggestion : « " + q + " »";
        man.addEventListener("click", () => {
          box.hidden = true;
          onPick({ address: q, street: q, city: "", sector: "", postal: "", lat: null, lng: null });
        });
        box.appendChild(man);
        box.hidden = false;
      } catch (e) {
        box.innerHTML = "";
        const man = document.createElement("button");
        man.type = "button"; man.className = "suggest-item manual";
        man.textContent = "Service d'adresses injoignable — ajouter « " + q + " » tel quel";
        man.addEventListener("click", () => {
          box.hidden = true;
          onPick({ address: q, street: q, city: "", sector: "", postal: "", lat: null, lng: null });
        });
        box.appendChild(man);
        box.hidden = false;
      }
    }, 280);
    input.addEventListener("input", run);
    input.addEventListener("focus", run);
  }

  /* ================================================================
     OSRM — matrices temps/distances + optimisation par secteur
     ================================================================ */
  function haversineKm(a, b) {
    const R = 6371, dLa = (b.lat - a.lat) * Math.PI / 180, dLo = (b.lng - a.lng) * Math.PI / 180;
    const h = Math.sin(dLa / 2) ** 2 + Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * Math.sin(dLo / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  function fallbackMatrix(pts) {
    const dur = [], dist = [];
    pts.forEach((a, i) => {
      dur.push([]); dist.push([]);
      pts.forEach((b, j) => {
        const km = a === b ? 0 : haversineKm(a, b);
        dist[i].push(km * 1000);
        dur[i].push(km / 32 * 3600); // ~32 km/h en ville
      });
    });
    return { dur, dist };
  }
  async function osrmMatrix(pts) {
    try {
      const coords = pts.map((p) => p.lng + "," + p.lat).join(";");
      const r = await fetch("https://router.project-osrm.org/table/v1/driving/" + coords + "?annotations=duration,distance");
      const j = await r.json();
      if (j.code !== "Ok" || !j.durations) throw new Error("OSRM");
      return { dur: j.durations, dist: j.distances || j.durations.map((row) => row.map(() => 0)) };
    } catch (e) {
      return fallbackMatrix(pts); // jamais de plantage : estimation locale
    }
  }

  function winStart(s) {
    const v = [s.win1s, s.win2s].filter((x) => x != null);
    return v.length ? Math.min(...v) : null;
  }
  function winEnd(s) {
    const v = [s.win1e, s.win2e].filter((x) => x != null);
    return v.length ? Math.min(...v) : null;
  }
  /* v9 : « en retard » se CALCULE à l'affichage (ETA vs fin du
     créneau) au lieu d'être stocké — la valeur stockée ne survit pas
     à une resynchronisation (aucune colonne serveur), donc le
     avertissement disparaissait après chaque synchro. */
  function isLate(s) { return s.eta != null && winEnd(s) != null && s.eta > winEnd(s); }
  function windowLabel(s) {
    const parts = [];
    [[s.win1s, s.win1e], [s.win2s, s.win2e]].forEach(([a, b]) => {
      if (a == null && b == null) return;
      if (a != null && b != null) parts.push(fmtH(a) + " – " + fmtH(b));
      else if (a != null) parts.push("Après " + fmtH(a));
      else parts.push("Avant " + fmtH(b));
    });
    return parts.length ? parts.join(" ou ") : "Toute la journée";
  }
  function sectorOf(s) {
    return (s.sector || s.city || (s.postal || "").slice(0, 3) || "Québec").trim();
  }

  /* ================================================================
     RIVE-SUD (règle de William, 20 nov. 2026) : les livraisons sur la
     Rive-Sud se font SEULEMENT le mercredi matin. Si un arrêt Rive-Sud
     est placé un autre jour, ou le mercredi avec un créneau qui
     commence à midi ou après, un GROS pop-up rouge avertit sur-le-champ
     pour éviter les erreurs. Le bouton « exception » vaut pour la
     configuration exacte (adresse + journée + créneau) : si l'un des
     trois change, l'avertissement revient.
     ================================================================ */
  const RS_VILLES = ["levis", "saint-romuald", "charny", "saint-jean-chrysostome",
    "saint-etienne-de-lauzon", "sainte-helene-de-breakeyville", "breakeyville",
    "saint-redempteur", "pintendre", "saint-joseph-de-la-pointe-de-levy", "saint-nicolas",
    "beaumont", "saint-charles-de-bellechasse", "saint-anselme", "saint-michel-de-bellechasse",
    "saint-henri", "sainte-claire", "saint-gervais", "berthier-sur-mer",
    "saint-francois-de-la-riviere-du-sud", "buckland", "notre-dame-auxiliatrice-de-buckland",
    "saint-damien-de-buckland", "saint-lazare-de-bellechasse", "honfleur", "saint-raphael",
    "saint-vallier", "montmagny", "cap-saint-ignace", "saint-pierre-de-la-riviere-du-sud",
    "l-islet", "saint-lambert-de-lauzon", "sainte-marie", "saint-bernard", "saint-isidore",
    "vallee-jonction", "saint-joseph-de-beauce", "beauceville"];
  const RS_POSTAL = /^(G6V|G6W|G6X|G6Y|G6Z|G7A|G0R)/i;
  function normTxt(t) {
    return (t || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
      .replace(/['’]/g, "-").replace(/[^a-z0-9]+/g, " ").trim();
  }
  function isRiveSud(s) {
    if (!s) return false;
    if (s.postal && RS_POSTAL.test((s.postal || "").trim())) return true;
    const hay = " " + normTxt([s.city, s.sector, s.address].filter(Boolean).join(" ")) + " ";
    return RS_VILLES.some((v) => hay.indexOf(" " + normTxt(v) + " ") !== -1);
  }
  function rsViolation(s) {
    if (!isRiveSud(s)) return null;
    const day = getDay(s.dayId);
    if (!day) return null;
    const dow = isoToDate(day.date).getDay(); // 3 = mercredi
    const ws = winStart(s);
    if (dow !== 3) return { day: day, raison: "jour" };
    if (ws != null && ws >= 720) return { day: day, raison: "pm" };
    return null; // mercredi matin, ou créneau pas encore choisi
  }
  function rsSig(s) {
    const day = getDay(s.dayId);
    const ws = winStart(s);
    return [s.addressKey || "", day ? day.date : "", ws == null ? "" : ws].join("|");
  }
  function checkRiveSud(s) {
    if (!s) return;
    const v = rsViolation(s);
    if (!v) return;
    if (s.rsAck && s.rsAck === rsSig(s)) return;
    showRsPopup(s, v);
  }
  function showRsPopup(s, v) {
    const old = $("#rsPopup"); if (old) old.remove();
    const ov = document.createElement("div");
    ov.id = "rsPopup";
    ov.className = "rs-overlay";
    const quand = cap(fmtDayLong(v.day.date)) + (winStart(s) != null ? " · arrivée " + windowLabel(s) : "");
    ov.innerHTML =
      '<div class="rs-box" role="alertdialog" aria-modal="true">' +
      '<div class="rs-icon">⚠</div>' +
      '<div class="rs-title">ATTENTION — RIVE-SUD</div>' +
      '<p class="rs-text">On livre sur la Rive-Sud <strong>seulement le mercredi matin</strong>.</p>' +
      '<p class="rs-detail">' + esc(s.address || "") + "<br>" + esc(quand) + "</p>" +
      '<button type="button" class="rs-btn-main" id="rsFix">← Corriger l\'arrêt</button>' +
      '<button type="button" class="rs-btn-ghost" id="rsOk">C\'est une exception, continuer quand même</button>' +
      "</div>";
    document.body.appendChild(ov);
    $("#rsFix", ov).addEventListener("click", () => ov.remove());
    $("#rsOk", ov).addEventListener("click", () => { s.rsAck = rsSig(s); window.Store.save(); ov.remove(); });
  }

  /* Ordre optimisé : Premier d'abord, Dernier à la fin ; les « Auto »
     sont regroupés par secteur — on vide un secteur avant de passer
     au secteur voisin le plus proche (aucun zigzag), avec priorité
     aux créneaux qui se terminent bientôt. */
  function optimizeOrder(day, stops, M) {
    const idx = (s) => stops.indexOf(s) + 1; // 0 = entrepôt dans la matrice
    const premiers = stops.filter((s) => s.orderPref === "premier");
    const derniers = stops.filter((s) => s.orderPref === "dernier");
    const autos = stops.filter((s) => s.orderPref !== "premier" && s.orderPref !== "dernier");
    const groups = new Map();
    autos.forEach((s) => {
      const k = sectorOf(s).toLowerCase();
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(s);
    });
    const ordered = [...premiers];
    let cur = ordered.length ? idx(ordered[ordered.length - 1]) : 0;
    let elapsed = 0;
    ordered.forEach((s) => { elapsed += (s.duration || 15); });
    const startMin = dayStartMin(day);
    while (groups.size) {
      let bestKey = null, bestScore = Infinity;
      for (const [k, list] of groups) {
        let minD = Infinity;
        list.forEach((s) => { minD = Math.min(minD, M.dur[cur][idx(s)] / 60); });
        let urgency = 0;
        const nowEst = startMin + elapsed + minD;
        list.forEach((s) => {
          const we = winEnd(s);
          if (we != null && we - nowEst < 45) urgency = Math.max(urgency, (45 - (we - nowEst)) * 4);
        });
        const score = minD - urgency;
        if (score < bestScore) { bestScore = score; bestKey = k; }
      }
      const list = groups.get(bestKey); groups.delete(bestKey);
      // Plus proche voisin à l'intérieur du secteur
      const rest = [...list];
      while (rest.length) {
        let bi = 0, bd = Infinity;
        rest.forEach((s, i) => { const d = M.dur[cur][idx(s)]; if (d < bd) { bd = d; bi = i; } });
        const nx = rest.splice(bi, 1)[0];
        elapsed += M.dur[cur][idx(nx)] / 60 + (nx.duration || 15);
        cur = idx(nx);
        ordered.push(nx);
      }
    }
    return [...ordered, ...derniers];
  }

  async function computeRoute(day, doOptimize) {
    const stops = getDayStops(day.id);
    if (!stops.length) {
      day.routeMin = null; day.routeKm = null; day.returnMin = null;
      window.Store.save();
      return;
    }
    const pts = [{ lat: WH.lat, lng: WH.lng }].concat(
      stops.map((s) => ({ lat: s.lat != null ? s.lat : WH.lat, lng: s.lng != null ? s.lng : WH.lng }))
    );
    const M = await osrmMatrix(pts);
    let ordered = stops;
    if (doOptimize) {
      ordered = optimizeOrder(day, stops, M);
      ordered.forEach((s, i) => { s.position = i; });
      day.optimized = true;
      day.status = "draft";
    }
    let clock = dayStartMin(day), prev = 0, km = 0;
    ordered.forEach((s) => {
      const i = stops.indexOf(s) + 1;
      const legMin = M.dur[prev][i] / 60;
      km += (M.dist[prev][i] || 0) / 1000;
      let arr = clock + legMin;
      const ws = winStart(s);
      if (ws != null && arr < ws) arr = ws; // on attend le début du créneau
      s.eta = Math.round(arr);
      s.late = winEnd(s) != null && arr > winEnd(s);
      clock = arr + (s.duration || 15);
      prev = i;
    });
    km += (M.dist[prev][0] || 0) / 1000;
    day.returnMin = Math.round(clock + M.dur[prev][0] / 60);
    day.routeKm = Math.round(km * 10) / 10;
    day.routeMin = day.returnMin - dayStartMin(day);
    window.Store.save();
  }

  /* Badges par secteur : A1, A2... B1, B2... selon l'ordre du trajet */
  function computeBadges(stops) {
    const letters = new Map(); const counts = new Map(); const out = new Map();
    stops.forEach((s) => {
      const k = sectorOf(s).toLowerCase();
      if (!letters.has(k)) letters.set(k, String.fromCharCode(65 + letters.size));
      const n = (counts.get(k) || 0) + 1; counts.set(k, n);
      out.set(s.id, letters.get(k) + n);
    });
    return out;
  }

  /* ================================================================
     VUES
     ================================================================ */
  function showView(name) {
    currentView = name;
    $("#view-home").hidden = name !== "home";
    $("#view-day").hidden = name !== "day";
    $("#view-stop").hidden = name !== "stop";
    $("#routeSheet").hidden = true;
    window.scrollTo(0, 0);
  }

  /* ---------------- Accueil : liste des journées ---------------- */
  function renderHome() {
    const today = todayISO();
    const list = $("#dayList");
    const days = [...DB().days].filter((d) => !d.deletedAt).sort((a, b) => (a.date < b.date ? -1 : 1));
    const lo = addDaysISO(today, -93), hi = addDaysISO(today, 93);
    const vis = days.filter((d) => d.date >= lo && d.date <= hi);
    const monday = addDaysISO(today, -((isoToDate(today).getDay() + 6) % 7));
    const sections = [];
    const upcoming = vis.filter((d) => d.date >= today);
    const week = vis.filter((d) => d.date < today && d.date >= monday);
    const month = vis.filter((d) => d.date < today && d.date < monday && d.date.slice(0, 7) === today.slice(0, 7));
    const older = vis.filter((d) => d.date < today && d.date < monday && d.date.slice(0, 7) !== today.slice(0, 7));
    if (upcoming.length) sections.push({ title: "Trajets à venir", days: upcoming });
    if (week.length) sections.push({ title: "Plus tôt cette semaine", days: [...week].reverse() });
    if (month.length) sections.push({ title: "Plus tôt ce mois", days: [...month].reverse() });
    const byMonth = new Map();
    [...older].reverse().forEach((d) => {
      const k = d.date.slice(0, 7);
      if (!byMonth.has(k)) byMonth.set(k, []);
      byMonth.get(k).push(d);
    });
    byMonth.forEach((ds, k) => {
      const dt = isoToDate(k + "-01");
      sections.push({ title: MOIS[dt.getMonth()] + " " + dt.getFullYear(), days: ds });
    });

    list.innerHTML = "";
    if (!sections.length) {
      list.innerHTML = '<div class="empty-note">Aucune journée. Crée ton premier trajet avec le bouton ci-dessous.</div>';
      return;
    }
    sections.forEach((sec) => {
      const h = document.createElement("div");
      h.className = "day-section"; h.textContent = sec.title;
      list.appendChild(h);
      sec.days.forEach((d) => {
        const n = getDayStops(d.id).length;
        const row = document.createElement("button");
        row.type = "button";
        row.className = "day-row" + (d.date === today ? " today" : "");
        row.innerHTML =
          '<span class="d-date">' + esc(fmtDayShort(d.date)) + '</span>' +
          '<span class="d-name">' + esc(cap(JOURS[isoToDate(d.date).getDay()])) + '</span>' +
          (n ? '<span class="d-count">' + n + " arrêt" + (n > 1 ? "s" : "") + "</span>" : "") +
          (d.status === "confirmed" ? '<span class="d-count">✓</span>' : "") +
          '<span class="d-menu">⋮</span>';
        row.addEventListener("click", (e) => {
          if (e.target.classList.contains("d-menu")) { dayMenu(d); return; }
          openDay(d.id);
        });
        list.appendChild(row);
      });
    });
  }

  /* Recherche d'adresses depuis l'accueil (demandée par William) :
     fouille TOUTES les journées en mémoire — passées (3 mois et plus)
     et futures — par adresse, client, ville, code postal ou appareil.
     Les infos et les photos de chaque arrêt restent en mémoire :
     un résultat ouvre l'arrêt complet, photos comprises. */
  function renderSearch() {
    const inp = $("#homeSearch");
    const box = $("#searchResults");
    const list = $("#dayList");
    const q = inp.value.trim();
    const words = normTxt(q).split(/\s+/).filter(Boolean);
    if (q.length < 2 || !words.length) {
      box.hidden = true; box.innerHTML = ""; list.hidden = false;
      return;
    }
    const today = todayISO();
    const dayById = {};
    DB().days.forEach((d) => { if (!d.deletedAt) dayById[d.id] = d; });
    const hits = DB().stops.filter((s) => {
      if (s.deletedAt || !dayById[s.dayId]) return false;
      const hay = normTxt([s.address, s.client, s.city, s.postal, s.appliance, s.phone].join(" "));
      const phoneDigits = String(s.phone || "").replace(/\D/g, "");
      return words.every((w) => {
        if (hay.includes(w)) return true;
        const wd = w.replace(/\D/g, ""); // recherche par téléphone : chiffres seulement (418 680-3750 = 4186803750)
        return wd.length >= 3 && phoneDigits.includes(wd);
      });
    }).map((s) => ({ s, day: dayById[s.dayId] }));
    hits.sort((a, b) => {
      const af = a.day.date >= today, bf = b.day.date >= today;
      if (af !== bf) return af ? -1 : 1;
      if (a.day.date !== b.day.date) return af ? (a.day.date < b.day.date ? -1 : 1) : (a.day.date > b.day.date ? -1 : 1);
      return (a.s.position || 0) - (b.s.position || 0);
    });
    list.hidden = true;
    box.hidden = false;
    box.innerHTML = "";
    if (!hits.length) {
      box.innerHTML = '<div class="empty-note">Aucun arrêt trouvé pour « ' + esc(q) + " ».</div>";
      return;
    }
    const head = document.createElement("div");
    head.className = "day-section";
    head.textContent = hits.length + " arrêt" + (hits.length > 1 ? "s" : "") + " trouvé" + (hits.length > 1 ? "s" : "");
    box.appendChild(head);
    hits.slice(0, 60).forEach(({ s, day }) => {
      const nPhotos = (DB().photos[s.id] || []).length;
      const row = document.createElement("button");
      row.type = "button";
      row.className = "sr-row";
      row.innerHTML =
        '<div class="sr-date">' + esc(cap(fmtDayLong(day.date))) + (day.date === today ? " · aujourd'hui" : "") + "</div>" +
        '<div class="sr-addr">' + esc(s.address || "Arrêt sans adresse") + "</div>" +
        '<div class="sr-sub">' + esc([s.client, s.appliance, s.type === "collecte" ? "Collecte" : "Livraison", nPhotos ? "📷 " + nPhotos + " photo" + (nPhotos > 1 ? "s" : "") : ""].filter(Boolean).join(" · ")) + "</div>";
      row.addEventListener("click", () => { openDay(day.id); openStop(s.id); });
      box.appendChild(row);
    });
  }

  function dayMenu(day) {
    actionSheet(cap(fmtDayLong(day.date)), [
      { label: "Ouvrir", fn: () => openDay(day.id) },
      { label: "Dupliquer", fn: () => { pendingDuplicateFrom = day.id; openCreateDay(addDaysISO(day.date, 1)); } },
      {
        // v8 : confirmation DANS l'app (une deuxième feuille), plus de
        // confirm() natif — il ne s'affichait pas toujours dans l'app
        // installée et la suppression semblait ne rien faire du tout.
        label: "Supprimer", danger: true, fn: () => {
          actionSheet("Mettre cette journée et ses arrêts à la corbeille ? (récupérable pendant 30 jours dans Réglages)", [
            { label: "Oui, mettre à la corbeille", danger: true, fn: () => trashDay(day) }
          ]);
        }
      }
    ]);
  }

  function trashDay(day) {
    // v13 : re-résoudre la journée dans la base COURANTE — l'objet
    // capturé par le menu peut être périmé si un rechargement a
    // reconstruit la base entre l'affichage et la confirmation
    // (rodage v12 : toast « mise à la corbeille » mais la journée
    // restait listée, la suppression avait visé un objet orphelin).
    const d = getDay(day.id); if (!d) return;
    const now = Date.now();
    DB().stops.filter((s) => s.dayId === d.id).forEach((s) => { if (!s.deletedAt) s.deletedAt = now; });
    d.deletedAt = now;
    window.Store.saveNow();
    if (currentView === "day") { showView("home"); }
    renderHome();
    toast("Journée mise à la corbeille (récupérable 30 jours)");
  }

  function openCreateDay(prefill) {
    const inp = $("#newDayDate");
    const today = todayISO();
    inp.min = addDaysISO(today, -93);
    inp.max = addDaysISO(today, 93);
    inp.value = prefill || nextDeliveryISO();
    openSheet("createDaySheet");
  }
  function nextDeliveryISO() {
    for (let i = 0; i < 8; i++) {
      const iso = addDaysISO(todayISO(), i);
      const dow = isoToDate(iso).getDay();
      if (dow === 1 || dow === 3 || dow === 5) return iso; // lun / mer / ven
    }
    return todayISO();
  }

  /* ---------------- Itinéraire d'une journée ---------------- */
  function openDay(id) {
    currentDayId = id;
    showView("day");
    renderDay();
  }

  function renderDay() {
    const day = getDay(currentDayId);
    if (!day) { showView("home"); renderHome(); return; }
    const stops = getDayStops(day.id);
    const badges = computeBadges(stops);
    $("#dayTitle").textContent = cap(fmtDayLong(day.date));
    $("#btnStartTime").textContent = day.startTime || "08:00";
    $("#dayStopsCount").textContent = stops.length + " arrêt" + (stops.length > 1 ? "s" : "");
    // v14 (décision de William, 21 nov.) : plus de suivi « livré » —
    // l'app sert à PLANIFIER les runs ; les chauffeurs travaillent
    // avec la feuille de route papier (PDF). Boutons retirés.
    $("#dayRouteState").textContent =
      day.status === "confirmed" ? "✓ Trajet confirmé" :
      day.optimized ? "Trajet optimisé" : "Route non calculée";

    const tl = $("#timeline");
    tl.innerHTML = "";
    // Départ entrepôt
    tl.appendChild(tlRow(
      fmtClock(dayStartMin(day)),
      '<div class="tl-dot home"></div><div class="tl-line"></div>',
      '<div class="tl-wh">' + esc(WH.label.split(",")[0]) + '</div><div class="tl-sub">' +
        esc(WH.label.split(",").slice(1).join(",").trim()) + " · Départ</div>"
    ));
    stops.forEach((s, i) => {
      tl.appendChild(tlRow(
        s.eta != null ? fmtClock(s.eta) : "--:--",
        '<div class="tl-num">' + String(i + 1).padStart(2, "0") + '</div><div class="tl-line"></div>',
        stopCardHTML(s, badges.get(s.id), day)
      ));
      bindStopCard(tl.lastElementChild, s, day);
    });
    // Retour entrepôt
    tl.appendChild(tlRow(
      day.returnMin != null ? fmtClock(day.returnMin) : "--:--",
      '<div class="tl-dot home"></div>',
      '<div class="tl-wh">' + esc(WH.label.split(",")[0]) + '</div><div class="tl-sub">Aller-retour</div>'
    ));

    $("#routeTotalTime").textContent = day.routeMin != null ? fmtDur(day.routeMin) : "—";
    $("#routeTotalSub").textContent = day.routeMin != null
      ? "Arrivée " + fmtClock(day.returnMin) + " · " + stops.length + " arrêts · " + (day.routeKm != null ? day.routeKm + " km" : "")
      : "Ajoute des arrêts pour calculer le trajet";
    const btnOpt = $("#btnOptimize");
    btnOpt.textContent = day.optimized ? "Affiner" : "Optimiser";
    $("#btnConfirm").hidden = !(day.optimized && day.status !== "confirmed");
  }

  function tlRow(time, rail, bodyHTML) {
    const row = document.createElement("div");
    row.className = "tl-row";
    row.innerHTML = '<div class="tl-time">' + esc(time) + '</div><div class="tl-rail">' + rail + '</div><div class="tl-body">' + bodyHTML + "</div>";
    return row;
  }

  function stopCardHTML(s, badge, day) {
    const sub = [s.sector, s.city, s.postal].filter(Boolean).join(", ");
    let info = "";
    if (s.client) info += '<div><span class="lbl">Client : </span>' + esc(s.client) +
      (s.apartment ? ' · <span class="lbl">App.</span> ' + esc(s.apartment) : "") + "</div>";
    if (s.phone) info += '<div><span class="lbl">Tél. : </span>' + esc(s.phone) + "</div>";
    if (s.appliance) info += '<div>' + esc(s.appliance) + " (" + (s.pieces || 1) + " morceau" + ((s.pieces || 1) > 1 ? "x" : "") + ")</div>";
    if (s.details) info += '<div class="tl-sub" style="font-size:13px">' + esc(s.details) + "</div>";
    info += '<div><span class="lbl">Vendeur : </span>' + esc(s.vendor || "—") + "</div>";
    let tags = "";
    if (s.type === "collecte") tags += '<span class="tag collecte">↑ Collecte</span>';
    if (s.installation) tags += '<span class="tag install">Installation</span>';
    if (s.pickup) tags += '<span class="tag pickup">Appareil à reprendre</span>';
    if (s.orderPref === "premier") tags += '<span class="tag premier">Premier</span>';
    if (s.orderPref === "dernier") tags += '<span class="tag premier">Dernier</span>';
    tags += '<span class="tag window">◷ ' + esc(windowLabel(s)) + (isLate(s) ? " ⚠ en retard" : "") + "</span>";

    const arrows = !day.optimized
      ? '<button class="mini-btn arrow" data-act="up" aria-label="Monter">↑</button><button class="mini-btn arrow" data-act="down" aria-label="Descendre">↓</button>'
      : "";
    return '<div class="stop-card" data-stop="' + s.id + '">' +
      '<div class="stop-card-head"><div class="stop-card-addr">' + esc(s.address || "Arrêt sans adresse") + "</div>" +
      (badge ? '<span class="badge">' + esc(badge) + "</span>" : "") + "</div>" +
      (sub ? '<div class="stop-card-sub">' + esc(sub) + "</div>" : "") +
      '<div class="stop-card-info">' + info + "</div>" + tags +
      '<div class="stop-card-actions">' +
      '<button class="mini-btn" data-act="nav">Itinéraire</button>' + arrows +
      "</div></div>";
  }

  function bindStopCard(row, s, day) {
    const card = $(".stop-card", row);
    if (!card) return;
    card.addEventListener("click", (e) => {
      const act = e.target.dataset && e.target.dataset.act;
      if (act === "nav") {
        const dest = (s.lat != null && s.lng != null) ? s.lat + "," + s.lng : encodeURIComponent(s.address || "");
        window.open("https://www.google.com/maps/dir/?api=1&destination=" + dest, "_blank");
        return;
      }
      if (act === "up" || act === "down") { moveStop(day, s, act === "up" ? -1 : 1); return; }
      if (e.target.closest(".stop-card-actions")) return;
      openStop(s.id);
    });
  }

  async function moveStop(day, s, dir) {
    const stops = getDayStops(day.id);
    const i = stops.indexOf(s);
    const j = i + dir;
    if (j < 0 || j >= stops.length) return;
    const a = stops[i], b = stops[j];
    const tmp = a.position; a.position = b.position; b.position = tmp;
    window.Store.save();
    await computeRoute(day, false);
    renderDay();
  }

  function newStop(day, fields) {
    const stops = getDayStops(day.id);
    const s = Object.assign({
      id: uid(), dayId: day.id, position: stops.length,
      address: "", street: "", city: "", sector: "", postal: "", lat: null, lng: null, addressKey: "",
      client: "", apartment: "", apartmentNone: false, phone: "",
      vendor: DB().profile || "William",
      appliance: "", pieces: 1, installation: false, pickup: false,
      orderPref: "auto", type: "livraison",
      win1s: null, win1e: null, win2s: null, win2e: null,
      duration: 15, details: "", delivered: false, failed: false, eta: null, late: false, rsAck: ""
    }, fields || {});
    s.addressKey = normalizeKey(s.address);
    DB().stops.push(s);
    window.Store.save();
    return s;
  }

  /* ================================================================
     DÉTAIL D'UN ARRÊT — enregistrement automatique à chaque champ
     ================================================================ */
  function openStop(id) {
    currentStopId = id;
    const s = getStop(id);
    if (!s) return;
    const day = getDay(s.dayId);
    const stops = getDayStops(s.dayId);
    $("#stopDayDate").textContent = (day ? cap(fmtDayLong(day.date)) : "") +
      " · Arrêt " + (stops.indexOf(s) + 1) + " sur " + stops.length;
    $("#fAddress").value = s.address || "";
    $("#fClient").value = s.client || "";
    $("#fApartment").value = s.apartment || "";
    $("#fPhone").value = s.phone || "";
    $("#fAppliance").value = s.appliance || "";
    $("#fDetails").value = s.details || "";
    $("#vendorValue").textContent = (s.vendor || "William") + " ›";
    $("#windowValue").textContent = windowLabel(s);
    syncSegs(s);
    syncAptNone(s);
    renderPhotos(s);
    markSaved(true);
    refreshValidation(s);
    // v9 : pendant la saisie, les rechargements serveur sont reportés
    // (sinon ils écrasent les champs en cours de frappe).
    if (window.Store.setRemoteDefer) window.Store.setRemoteDefer(true);
    showView("stop");
  }

  function curStop() { return getStop(currentStopId); }

  function markSaved(silent) {
    const el = $("#saveNote");
    const now = new Date();
    el.textContent = "✓ Enregistré à " + now.getHours() + " h " + String(now.getMinutes()).padStart(2, "0");
    if (!silent) { /* l'indicateur suffit, pas de toast à chaque frappe */ }
  }
  /* CHAQUE modification est écrite immédiatement (aucun bouton Enregistrer) */
  function touch() {
    window.Store.save();
    markSaved();
    const s = curStop();
    if (s) refreshValidation(s);
  }

  /* ================================================================
     CHAMPS OBLIGATOIRES (règle de William, 20 nov. 2026) : impossible
     de quitter l'écran d'un arrêt tant qu'il est incomplet — ça évite
     les erreurs et les oublis. Vendeur, morceaux, Installation,
     À reprendre, Ordre, Type et Durée ont toujours une valeur par
     construction ; les champs réellement vérifiés sont ci-dessous.
     Les Détails restent optionnels, et depuis la v8 (règle de
     William, 21 nov. 2026) le CRÉNEAU D'ARRIVÉE EST OPTIONNEL :
     aucun créneau = le client est disponible toute la journée.
     ================================================================ */
  function missingFields(s) {
    const m = [];
    if (!s) return m;
    if (!(s.address || "").trim()) m.push({ k: "address", label: "Adresse" });
    if (!(s.client || "").trim()) m.push({ k: "client", label: "Nom du client" });
    if (!(s.apartment || "").trim() && !s.apartmentNone) m.push({ k: "apartment", label: "Appartement (ou « Aucun »)" });
    if (!(s.phone || "").trim()) m.push({ k: "phone", label: "Téléphone" });
    if (!(s.appliance || "").trim()) m.push({ k: "appliance", label: "Appareil" });
    if ((DB().photos[s.id] || []).length < 1) m.push({ k: "photos", label: "Photo (au moins 1)" });
    return m;
  }
  function refreshValidation(s) {
    const banner = $("#missingBanner");
    if (!banner || !s) return;
    const m = missingFields(s);
    const has = (k) => m.some((x) => x.k === k);
    banner.hidden = m.length === 0;
    banner.textContent = m.length ? "⚠ Arrêt incomplet — il manque : " + m.map((x) => x.label).join(", ") + ". Impossible de quitter tant que tout n'est pas rempli." : "";
    $("#fAddress").classList.toggle("missing", has("address"));
    $("#fClient").classList.toggle("missing", has("client"));
    $("#fApartment").classList.toggle("missing", has("apartment"));
    $("#fPhone").classList.toggle("missing", has("phone"));
    $("#fAppliance").classList.toggle("missing", has("appliance"));
    $("#rowWindow").classList.toggle("missing", has("window"));
    $("#photoCount").classList.toggle("photo-missing", has("photos"));
  }
  function guardLeave() {
    const s = curStop();
    if (!s) return true;
    const m = missingFields(s);
    if (!m.length) return true;
    refreshValidation(s);
    toast("Il manque : " + m.map((x) => x.label).join(", "));
    window.scrollTo({ top: 0, behavior: "smooth" });
    return false;
  }
  function syncAptNone(s) {
    const onState = !!s.apartmentNone;
    const btn = $("#aptNone"), inp = $("#fApartment");
    if (btn) btn.classList.toggle("on", onState);
    if (inp) {
      inp.disabled = onState;
      inp.placeholder = onState ? "Aucun appartement" : "Ex. : 110";
    }
  }

  function syncSegs(s) {
    setSeg("#segInstall", s.installation ? "yes" : "no");
    setSeg("#segPickup", s.pickup ? "yes" : "no");
    setSeg("#segOrder", s.orderPref || "auto");
    setSeg("#segType", s.type || "livraison");
    $("#piecesValue").textContent = s.pieces || 1;
  }
  function setSeg(sel, v) {
    $$("button", $(sel)).forEach((b) => b.classList.toggle("on", b.dataset.v === v));
  }
  function bindSeg(sel, fn) {
    $$("button", $(sel)).forEach((b) => b.addEventListener("click", () => {
      const s = curStop(); if (!s) return;
      setSeg(sel, b.dataset.v);
      fn(s, b.dataset.v);
      touch();
    }));
  }

  function bindStopForm() {
    const on = (id, ev, fn) => { const el = $(id); if (el) el.addEventListener(ev, fn); };
    on("#fAddress", "input", () => {
      const s = curStop(); if (!s) return;
      s.address = $("#fAddress").value; s.addressKey = normalizeKey(s.address);
      // Saisie manuelle : le secteur et la position viennent UNIQUEMENT de la
      // suggestion choisie — on efface les anciennes données plutôt que de
      // regrouper avec un secteur périmé. (Aucun champ « Secteur » manuel.)
      s.lat = null; s.lng = null; s.sector = ""; s.city = ""; s.postal = "";
      touch();
    });
    on("#fAddress", "change", () => { const s = curStop(); if (s) checkRiveSud(s); });
    on("#fClient", "input", () => { const s = curStop(); if (s) { s.client = $("#fClient").value; touch(); } });
    on("#fApartment", "input", () => { const s = curStop(); if (s) { s.apartment = $("#fApartment").value; if (s.apartmentNone) { s.apartmentNone = false; syncAptNone(s); } touch(); } });
    on("#aptNone", "click", () => {
      const s = curStop(); if (!s) return;
      s.apartmentNone = !s.apartmentNone;
      if (s.apartmentNone) { s.apartment = ""; $("#fApartment").value = ""; }
      syncAptNone(s);
      touch();
    });
    on("#fPhone", "input", () => { const s = curStop(); if (s) { s.phone = $("#fPhone").value; touch(); } });
    on("#fAppliance", "input", () => { const s = curStop(); if (s) { s.appliance = $("#fAppliance").value; touch(); } });
    on("#fDetails", "input", () => { const s = curStop(); if (s) { s.details = $("#fDetails").value; touch(); } });

    attachAutocomplete($("#fAddress"), $("#stopSuggestBox"), (r) => {
      const s = curStop(); if (!s) return;
      s.address = r.address; s.street = r.street; s.city = r.city; s.sector = r.sector;
      s.postal = r.postal; s.lat = r.lat; s.lng = r.lng; s.addressKey = normalizeKey(r.address);
      $("#fAddress").value = r.address;
      touch();
      renderPhotos(s); // les photos suivent l'adresse
      toast("Adresse localisée");
      checkRiveSud(s);
    });

    bindSeg("#segInstall", (s, v) => { s.installation = v === "yes"; });
    bindSeg("#segPickup", (s, v) => { s.pickup = v === "yes"; });
    bindSeg("#segOrder", (s, v) => { s.orderPref = v; });
    bindSeg("#segType", (s, v) => { s.type = v; });

    on("#piecesMinus", "click", () => { const s = curStop(); if (s) { s.pieces = Math.max(1, (s.pieces || 1) - 1); $("#piecesValue").textContent = s.pieces; touch(); } });
    on("#piecesPlus", "click", () => { const s = curStop(); if (s) { s.pieces = Math.min(30, (s.pieces || 1) + 1); $("#piecesValue").textContent = s.pieces; touch(); } });

    on("#rowVendor", "click", openVendorSheet);
    on("#rowWindow", "click", openWindowSheet);

    on("#btnNavigate", "click", () => {
      const s = curStop(); if (!s) return;
      const dest = (s.lat != null && s.lng != null) ? s.lat + "," + s.lng : encodeURIComponent(s.address || "");
      window.open("https://www.google.com/maps/dir/?api=1&destination=" + dest, "_blank");
    });
    on("#btnDuplicateStop", "click", () => {
      const s = curStop(); if (!s) return;
      if (!guardLeave()) return;
      const day = getDay(s.dayId);
      const fields = Object.assign({}, s, { delivered: false, failed: false, eta: null, deletedAt: null, duration: 15 });
      delete fields.id;
      const copy = newStop(day, fields);
      const srcPhotos = DB().photos[s.id] || [];
      if (srcPhotos.length) DB().photos[copy.id] = srcPhotos.map((p) => ({ id: uid(), dataUrl: p.dataUrl, ts: p.ts || Date.now() }));
      touch();
      toast("Arrêt dupliqué");
      openStop(copy.id);
    });
    on("#btnDeleteStop", "click", () => {
      const s = curStop(); if (!s) return;
      // v9 : confirmation DANS l'app, comme pour les journées — le
      // confirm() natif rendait ce bouton inopérant.
      actionSheet("Mettre cet arrêt à la corbeille ? (récupérable pendant 30 jours dans Réglages)", [
        { label: "Oui, mettre à la corbeille", danger: true, fn: () => {
          s.deletedAt = Date.now();
          getDayStops(s.dayId).forEach((x, i) => { x.position = i; });
          touch();
          toast("Arrêt mis à la corbeille (récupérable 30 jours)");
          backToDay();
        } }
      ]);
    });
    on("#btnBackDay", "click", () => { if (guardLeave()) backToDay(); });

    // Photos
    on("#photoInput", "change", async (e) => {
      const s = curStop(); if (!s) return;
      const files = Array.from(e.target.files || []);
      e.target.value = "";
      for (const f of files) {
        const list = DB().photos[s.id] || (DB().photos[s.id] = []);
        if (list.length >= 10) { toast("Maximum 10 photos par arrêt"); break; }
        try { list.push({ id: uid(), dataUrl: await fileToDataUrl(f), ts: Date.now() }); }
        catch (err) { toast("Photo non ajoutée"); }
      }
      touch();
      renderPhotos(s);
    });
  }

  function backToDay() {
    if (window.Store.setRemoteDefer) window.Store.setRemoteDefer(false);
    window.Store.saveNow();
    const s = curStop();
    if (s) currentDayId = s.dayId;
    showView("day");
    renderDay();
  }

  function renderPhotos(s) {
    const list = DB().photos[s.id] || [];
    $("#photoCount").textContent = list.length + " / 10";
    const grid = $("#photoGrid");
    grid.innerHTML = "";
    list.forEach((p) => {
      const d = document.createElement("div");
      d.className = "photo-thumb";
      d.innerHTML = '<img alt="Photo de l\'adresse"><button type="button" class="rm" aria-label="Retirer">×</button>';
      $("img", d).src = p.dataUrl;
      $(".rm", d).addEventListener("click", () => {
        DB().photos[s.id] = (DB().photos[s.id] || []).filter((x) => x.id !== p.id);
        touch();
        renderPhotos(s);
      });
      grid.appendChild(d);
    });
    if (list.length < 10) {
      const add = document.createElement("button");
      add.type = "button"; add.className = "photo-add";
      add.innerHTML = '<span class="plus">+</span>Photo';
      add.addEventListener("click", () => $("#photoInput").click());
      grid.appendChild(add);
    }
  }

  function fileToDataUrl(file) {
    return new Promise((res, rej) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const max = 1100;
        const sc = Math.min(1, max / Math.max(img.width, img.height));
        const c = document.createElement("canvas");
        c.width = Math.round(img.width * sc); c.height = Math.round(img.height * sc);
        c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        res(c.toDataURL("image/jpeg", 0.78));
      };
      img.onerror = rej;
      img.src = url;
    });
  }

  /* ---------------- Choix du vendeur ---------------- */
  function openVendorSheet() {
    const s = curStop(); if (!s) return;
    const box = $("#vendorList");
    box.innerHTML = "";
    PROFILES.forEach((name) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "picker-item" + (s.vendor === name ? " sel" : "");
      b.innerHTML = esc(name) + (s.vendor === name ? '<span class="check">✓</span>' : "");
      b.addEventListener("click", () => {
        s.vendor = name;
        $("#vendorValue").textContent = name + " ›";
        touch();
        closeSheet("vendorSheet");
      });
      box.appendChild(b);
    });
    openSheet("vendorSheet");
  }

  /* ---------------- Créneaux d'arrivée (façon Spoke) ---------------- */
  let winDraft = null;
  function openWindowSheet() {
    const s = curStop(); if (!s) return;
    winDraft = [
      { s: s.win1s, e: s.win1e },
      { s: s.win2s, e: s.win2e }
    ];
    renderWindowSlots();
    openSheet("windowSheet");
  }
  function renderWindowSlots() {
    const box = $("#windowSlots");
    box.innerHTML = "";
    winDraft.forEach((slot, i) => {
      if (i === 1 && slot.s == null && slot.e == null && !slot._open) return;
      const row = document.createElement("div");
      row.innerHTML =
        '<div class="window-slot">' +
        '<div class="wcol"><label>Arriver entre</label><input type="time" data-f="s" value="' + minToTime(slot.s) + '"></div>' +
        '<div class="wcol"><label>Et</label><input type="time" data-f="e" value="' + minToTime(slot.e) + '"></div>' +
        (i === 1 ? '<button type="button" class="rm-slot" aria-label="Retirer ce créneau">×</button>' : "") +
        "</div>" +
        '<div class="w-quick">' +
        '<button type="button" data-q="now">Maintenant</button>' +
        '<button type="button" data-q="any">N\'importe quand</button>' +
        "</div>";
      $$("input", row).forEach((inp) => inp.addEventListener("change", () => {
        slot[inp.dataset.f] = timeToMin(inp.value);
        slot._open = true;
      }));
      $$("[data-q]", row).forEach((b) => b.addEventListener("click", () => {
        if (b.dataset.q === "now") { slot.s = null; slot._open = true; }
        if (b.dataset.q === "any") { slot.s = null; slot.e = null; slot._open = true; }
        renderWindowSlots();
      }));
      const rm = $(".rm-slot", row);
      if (rm) rm.addEventListener("click", () => { slot.s = null; slot.e = null; slot._open = false; renderWindowSlots(); });
      box.appendChild(row);
    });
  }
  function bindWindowSheet() {
    $("#btnAddSlot").addEventListener("click", () => {
      if (winDraft[1]) { winDraft[1]._open = true; renderWindowSlots(); }
    });
    $("#btnWindowDone").addEventListener("click", () => {
      const s = curStop(); if (!s) return;
      s.win1s = winDraft[0].s; s.win1e = winDraft[0].e;
      s.win2s = winDraft[1].s; s.win2e = winDraft[1].e;
      $("#windowValue").textContent = windowLabel(s);
      touch();
      closeSheet("windowSheet");
      checkRiveSud(s);
    });
  }

  /* ================================================================
     FEUILLE DE ROUTE PDF (vue imprimable, photos incluses)
     ================================================================ */
  function openRouteSheet() {
    const day = getDay(currentDayId);
    if (!day) return;
    const stops = getDayStops(day.id);
    const badges = computeBadges(stops);
    let h = '<div class="rs-actions"><button id="rsPrint">Imprimer / Enregistrer en PDF</button>' +
      '<button class="ghost" id="rsClose">Fermer</button></div>';
    h += '<div class="rs-head"><h1>WL Ameublement — Feuille de route</h1>' +
      '<div class="rs-meta">' + esc(cap(fmtDayLong(day.date))) +
      " · Départ " + (day.startTime || "08:00") + " de l'entrepôt (" + esc(WH.label) + ")" +
      (day.returnMin != null ? " · Arrivée prévue " + fmtClock(day.returnMin) : "") +
      (day.routeKm != null ? " · " + day.routeKm + " km" : "") +
      " · " + stops.length + " arrêt" + (stops.length > 1 ? "s" : "") + "</div></div>";
    if (!stops.length) h += "<p>Aucun arrêt dans cette journée.</p>";
    stops.forEach((s, i) => {
      const photos = DB().photos[s.id] || [];
      h += '<div class="rs-stop"><div class="rs-stop-head"><div class="rs-addr">' +
        (i + 1) + ". " + esc(s.address || "Arrêt sans adresse") + " " +
        (badges.get(s.id) ? "(" + esc(badges.get(s.id)) + ")" : "") + "</div>" +
        '<div class="rs-eta">' + (s.eta != null ? fmtClock(s.eta) : "") + "</div></div>";
      h += '<div class="rs-line"><span class="lbl">Client : </span>' + esc(s.client || "—") +
        (s.apartment ? ' · <span class="lbl">App.</span> ' + esc(s.apartment) : "") +
        (s.phone ? ' · <span class="lbl">Tél. :</span> ' + esc(s.phone) : "") + "</div>";
      if (s.appliance) h += '<div class="rs-line"><span class="lbl">Appareil : </span>' + esc(s.appliance) +
        " (" + (s.pieces || 1) + " morceau" + ((s.pieces || 1) > 1 ? "x" : "") + ")</div>";
      h += '<div class="rs-line"><span class="lbl">Vendeur : </span>' + esc(s.vendor || "—") +
        ' · <span class="lbl">Créneau :</span> ' + esc(windowLabel(s)) + "</div>";
      h += "<div>" +
        (s.type === "collecte" ? '<span class="rs-tag collecte">COLLECTE</span>' : '<span class="rs-tag">LIVRAISON</span>') +
        (s.installation ? '<span class="rs-tag install">INSTALLATION</span>' : "") +
        (s.pickup ? '<span class="rs-tag pickup">APPAREIL À REPRENDRE</span>' : "") +
        "</div>";
      if (s.details) h += '<div class="rs-line"><span class="lbl">Détails : </span>' + esc(s.details) + "</div>";
      if (photos.length) {
        h += '<div class="rs-photos">' + photos.map((p) => '<img src="' + p.dataUrl + '" alt="Photo de l\'appareil">').join("") + "</div>";
      }
      h += "</div>";
    });
    h += '<div class="rs-line" style="margin-top:10px"><span class="lbl">Retour : </span>' + esc(WH.label) +
      (day.returnMin != null ? " — arrivée " + fmtClock(day.returnMin) : "") + "</div>";
    const sheet = $("#routeSheet");
    sheet.innerHTML = h;
    sheet.hidden = false;
    $("#view-day").hidden = true;
    $("#rsClose").addEventListener("click", () => { sheet.hidden = true; $("#view-day").hidden = false; });
    $("#rsPrint").addEventListener("click", () => window.print());
    window.scrollTo(0, 0);
  }

  /* ================================================================
     RÉGLAGES — profil, export, restauration
     ================================================================ */
  function openSettings() {
    $("#settingsProfile").textContent = DB().profile || "Non choisi";
    const mode = window.Store.mode;
    $("#settingsMode").textContent = mode === "supabase" ? "Supabase (synchronisé)" : "Démo local";
    $("#settingsHint").textContent = mode === "supabase"
      ? "Données synchronisées entre les 4 utilisateurs via Supabase (Postgres hébergé, sauvegardes du fournisseur), avec copie locale de secours sur l'appareil."
      : "Les données sont gardées sur ce téléphone. Pour synchroniser les 4 utilisateurs, remplis config.js avec les clés Supabase (voir README).";
    renderTrash();
    const snaps = window.Store.snapshotsInfo();
    $("#snapInfo").textContent = snaps.length
      ? "Snapshots quotidiens automatiques sur l'appareil : " + snaps[snaps.length - 1] + " (dernier), " + snaps.length + " jour(s) conservé(s)."
      : "Snapshots quotidiens automatiques : aucun pour le moment (créé à la première modification du jour).";
    openSheet("settingsSheet");
  }

  function renderTrash() {
    const box = $("#trashList");
    if (!box) return;
    const trashed = DB().stops.filter((s) => s.deletedAt).sort((a, b) => b.deletedAt - a.deletedAt);
    $("#trashInfo").textContent = trashed.length
      ? trashed.length + " arrêt(s) à la corbeille — récupérables pendant 30 jours, puis effacés pour de bon."
      : "La corbeille est vide. Les arrêts et journées supprimés restent récupérables ici pendant 30 jours.";
    box.innerHTML = "";
    trashed.forEach((s) => {
      const day = getDay(s.dayId);
      const row = document.createElement("div");
      row.className = "row-between";
      const left = document.createElement("span");
      left.className = "row-label";
      left.textContent = (s.client || "Client") + " — " + (s.address || "") + (day ? " · " + day.date : "");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "btn-mini";
      btn.textContent = "Restaurer";
      btn.addEventListener("click", () => {
        // v13 : re-résoudre dans la base courante (même raison qu'à trashDay)
        const cs = getStop(s.id); if (!cs) { renderTrash(); return; }
        cs.deletedAt = null;
        const cd = getDay(cs.dayId);
        if (cd && cd.deletedAt) cd.deletedAt = null;
        window.Store.saveNow();
        renderTrash();
        renderHome();
        toast("Arrêt restauré");
      });
      row.appendChild(left);
      row.appendChild(btn);
      box.appendChild(row);
    });
  }

  function bindSettings() {
    $("#btnSettings").addEventListener("click", openSettings);
    $("#btnChangeProfile").addEventListener("click", () => { closeSheet("settingsSheet"); openProfileSheet(); });
    $("#btnExport").addEventListener("click", () => {
      const blob = new Blob([window.Store.exportJSON()], { type: "application/json" });
      const a = document.createElement("a");
      const d = new Date();
      a.href = URL.createObjectURL(blob);
      a.download = "sauvegarde-wl-livraison-" + dateToISO(d) + "-" +
        String(d.getHours()).padStart(2, "0") + String(d.getMinutes()).padStart(2, "0") + ".json";
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      toast("Sauvegarde exportée");
    });
    $("#btnImport").addEventListener("click", () => $("#importInput").click());
    $("#importInput").addEventListener("change", async (e) => {
      const f = e.target.files && e.target.files[0];
      e.target.value = "";
      if (!f) return;
      try {
        const obj = JSON.parse(await f.text());
        if (!confirm("Restaurer cette sauvegarde ? Les données actuelles seront remplacées (une copie de l'état actuel est gardée sur l'appareil).")) return;
        window.Store.importJSON(obj);
        closeSheet("settingsSheet");
        renderHome(); showView("home");
        toast("Sauvegarde restaurée");
      } catch (err) {
        toast("Restauration impossible : " + err.message);
      }
    });
  }

  function openProfileSheet() {
    const box = $("#profileList");
    box.innerHTML = "";
    PROFILES.forEach((name) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "picker-item" + (DB().profile === name ? " sel" : "");
      b.innerHTML = esc(name) + (DB().profile === name ? '<span class="check">✓</span>' : "");
      b.addEventListener("click", () => {
        window.Store.setProfile(name);
        $("#brandSub").textContent = name + " · wlameublement@gmail.com";
        closeSheet("profileSheet");
        toast("Bonjour " + name + " — tes arrêts porteront ton nom comme vendeur");
      });
      box.appendChild(b);
    });
    openSheet("profileSheet");
  }

  /* ================================================================
     INITIALISATION
     ================================================================ */
  function seedIfNeeded() {
    const db = DB();
    if (db.seeded) return;
    // v8 : JAMAIS de journée démo en mode synchronisé. Le marqueur
    // « seeded » se perdait à chaque rechargement serveur, donc la
    // journée d'exemple revenait à chaque ouverture et ses arrêts
    // s'accumulaient dans les vraies journées (38, puis 54, puis 101
    // arrêts « Exemple » — bug vu par William les 20-21 nov. 2026).
    if (window.Store.mode === "supabase") { db.seeded = true; return; }
    db.seeded = true;
    const date = nextDeliveryISO();
    const day = { id: uid(), date, startTime: "08:00", status: "draft", optimized: false, routeMin: null, routeKm: null, returnMin: null };
    db.days.push(day);
    const base = {
      dayId: day.id, client: "", apartment: "", phone: "", appliance: "", pieces: 1,
      installation: false, pickup: false, orderPref: "auto", type: "livraison",
      win1s: null, win1e: null, win2s: null, win2e: null, duration: 15, details: "",
      delivered: false, failed: false, eta: null, late: false
    };
    const mk = (o, pos) => Object.assign({}, base, o, { id: uid(), position: pos, addressKey: normalizeKey(o.address) });
    db.stops.push(mk({
      address: "1897 Boulevard Bastien, Les Rivières, Québec, G2B 1Y2", street: "1897 Boulevard Bastien",
      city: "Québec", sector: "Les Rivières", postal: "G2B 1Y2", lat: 46.8389, lng: -71.2897,
      client: "Exemple — Will", apartment: "110", phone: "418 680-3750", vendor: "William",
      appliance: "Laveuse Whirlpool", installation: true,
      details: "Sonner à l'arrivée. Entrée sur le côté."
    }, 0));
    db.stops.push(mk({
      address: "1316 Boulevard Bastien, Les Rivières, Québec, G2K 1G2", street: "1316 Boulevard Bastien",
      city: "Québec", sector: "Les Rivières", postal: "G2K 1G2", lat: 46.8325, lng: -71.2760,
      client: "Exemple — Zach", phone: "581 998-1991", vendor: "Zach",
      appliance: "Réfrigérateur Samsung", pickup: true,
      details: "Reprendre l'ancien frigo au sous-sol."
    }, 1));
    db.stops.push(mk({
      address: "133 Rue Monseigneur Dumas, La Haute-Saint-Charles, Québec, G2B 2Z6", street: "133 Rue Monseigneur Dumas",
      city: "Québec", sector: "La Haute-Saint-Charles", postal: "G2B 2Z6", lat: 46.8455, lng: -71.3150,
      client: "Exemple — Échange", phone: "581 995-4422", vendor: "William",
      appliance: "Laveuse Maytag (échange)", win1s: 600, win1e: 720
    }, 2));
    window.Store.save();
  }

  function bindGlobal() {
    $("#btnCreateDay").addEventListener("click", () => { pendingDuplicateFrom = null; openCreateDay(); });
    $("#homeSearch").addEventListener("input", renderSearch);
    $("#btnDoCreateDay").addEventListener("click", () => {
      const v = $("#newDayDate").value;
      if (!v) { toast("Choisis une date"); return; }
      let day = DB().days.find((d) => d.date === v);
      if (day && day.deletedAt) { day.deletedAt = null; }
      // v12 : une journée (restaurée ou non) SANS aucun arrêt
      // visible repart propre — pas de totaux de trajet ni de
      // statut « confirmé » hérités d'avant (vu au retest v11 : une
      // journée recréée vide affichait encore « Arrivée 08:39,
      // 23,7 km » et « ✓ Trajet confirmé »).
      if (day && getDayStops(day.id).length === 0) {
        day.routeMin = null; day.routeKm = null; day.returnMin = null;
        day.optimized = false; day.status = "draft";
      }
      if (!day) {
        day = { id: uid(), date: v, startTime: CFG.START_TIME || "08:00", status: "draft", optimized: false, routeMin: null, routeKm: null, returnMin: null };
        DB().days.push(day);
      }
      if (pendingDuplicateFrom) {
        const src = getDayStops(pendingDuplicateFrom);
        const existing = getDayStops(day.id).length;
        src.forEach((s, i) => {
          const copy = Object.assign({}, s, {
            id: uid(), dayId: day.id, position: existing + i, delivered: false, failed: false, eta: null, duration: 15, deletedAt: null
          });
          DB().stops.push(copy);
          // v13 : copier aussi les PHOTOS de l'arrêt source — sans
          // elles, la copie échouait le contrôle « photo obligatoire »
          // dès sa première modification et la recherche n'affichait
          // pas « 📷 1 photo » (vu au rodage v12).
          const srcPhotos = DB().photos[s.id] || [];
          if (srcPhotos.length) DB().photos[copy.id] = srcPhotos.map((p) => ({ id: uid(), dataUrl: p.dataUrl, ts: p.ts || Date.now() }));
        });
        day.optimized = false; day.status = "draft";
        pendingDuplicateFrom = null;
        toast("Journée dupliquée");
      }
      window.Store.save();
      closeSheet("createDaySheet");
      openDay(day.id);
    });

    $("#btnBackHome").addEventListener("click", () => { showView("home"); renderHome(); });
    $("#btnDaySettings").addEventListener("click", () => {
      const day = getDay(currentDayId); if (!day) return;
      actionSheet("Journée du " + fmtDayShort(day.date), [
        { label: "Dupliquer la journée", fn: () => { pendingDuplicateFrom = day.id; openCreateDay(addDaysISO(day.date, 1)); } },
        { label: "Supprimer la journée", danger: true, fn: () => dayMenu(day) }
      ]);
    });
    attachAutocomplete($("#addrSearch"), $("#suggestBox"), (r) => {
      const day = getDay(currentDayId); if (!day) return;
      const s = newStop(day, {
        address: r.address, street: r.street, city: r.city, sector: r.sector,
        postal: r.postal, lat: r.lat, lng: r.lng
      });
      $("#addrSearch").value = "";
      day.optimized = day.optimized && false; // un nouvel arrêt déverrouille le trajet
      window.Store.save();
      computeRoute(day, false).then(() => { renderDay(); toast("Arrêt ajouté — complète ses infos"); openStop(s.id); });
    });
    const addBlank = () => {
      const day = getDay(currentDayId); if (!day) return;
      const s = newStop(day, {});
      window.Store.save();
      openStop(s.id);
    };
    $("#btnAddStop").addEventListener("click", addBlank);
    $("#btnAddStop2").addEventListener("click", addBlank);

    $("#btnOptimize").addEventListener("click", async () => {
      const day = getDay(currentDayId); if (!day) return;
      if (day.optimized) {
        // « Affiner » : on déverrouille pour refaire des changements
        day.optimized = false; day.status = "draft";
        window.Store.save();
        renderDay();
        toast("Trajet déverrouillé — refais tes changements, puis Optimiser");
        return;
      }
      toast("Optimisation en cours...");
      await computeRoute(day, true);
      renderDay();
      toast("Trajet optimisé par secteur");
    });
    $("#btnConfirm").addEventListener("click", () => {
      const day = getDay(currentDayId); if (!day) return;
      day.status = "confirmed";
      window.Store.save();
      renderDay();
      toast("Trajet confirmé");
    });
    $("#btnPdf").addEventListener("click", openRouteSheet);

    $("#btnDoLogin").addEventListener("click", async () => {
      const email = $("#loginEmail").value.trim();
      const pass = $("#loginPass").value;
      const err = $("#loginError");
      try {
        await window.Store.signIn(email, pass);
        err.hidden = true;
        closeSheet("loginSheet");
        seedIfNeeded();
        renderHome();
        toast("Connecté — données synchronisées");
      } catch (e) {
        err.textContent = "Connexion impossible : " + (e.message || "vérifie le courriel et le mot de passe");
        err.hidden = false;
      }
    });

    // Filet de sécurité : tout est déjà écrit à chaque frappe, mais on
    // ressynchronise aussi quand l'app passe en arrière-plan.
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) window.Store.saveNow();
    });
    window.addEventListener("beforeunload", () => window.Store.saveNow());
  }

  function onRemoteChange() {
    // Un autre utilisateur vient de modifier quelque chose (mode Supabase)
    if (currentView === "home") renderHome();
    else if (currentView === "day") renderDay();
    // En pleine saisie dans un arrêt, on ne touche pas au formulaire.
  }

  async function init() {
    const res = await window.Store.init(onRemoteChange);
    // v16 : état de synchro VISIBLE en tout temps dans l'en-tête —
    // « ✓ Synchronisé » seulement quand le serveur a confirmé.
    if (window.Store.setSyncListener) window.Store.setSyncListener((st) => {
      const el = $("#syncNote");
      if (!el) return;
      el.textContent = st === "error" ? "⚠ Synchro en attente — données sur l'appareil seulement"
        : st === "pending" ? "Synchro en cours…"
        : "✓ Synchronisé";
    });
    seedIfNeeded();
    bindGlobal();
    bindStopForm();
    bindWindowSheet();
    bindSettings();
    if (DB().profile) $("#brandSub").textContent = DB().profile + " · wlameublement@gmail.com";
    $("#demoBanner").hidden = window.Store.mode === "supabase";
    renderHome();
    showView("home");
    if (!DB().profile) openProfileSheet();
    if (res.needsAuth) openSheet("loginSheet");
    if (res.offline) toast("Supabase injoignable — mode local de secours, tes données sont gardées sur l'appareil");
  }

  document.addEventListener("DOMContentLoaded", init);
})();
