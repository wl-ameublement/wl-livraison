/* ============================================================
   WL Livraison — Couche de données
   ------------------------------------------------------------
   FIABILITÉ (exigence de William) :
   - Enregistrement automatique EN TEMPS RÉEL : chaque saisie ou
     modification est écrite immédiatement, champ par champ.
     Aucun bouton « Enregistrer » : si l'app se ferme, rien n'est perdu.
   - Mode démo local : écriture synchrone dans localStorage à
     chaque changement + copie de secours automatique + un
     snapshot quotidien conservé sur l'appareil (14 jours).
   - Mode Supabase (quand config.js est rempli) : chaque
     changement est poussé aussitôt à la base Postgres hébergée ;
     les changements des autres utilisateurs arrivent en temps
     réel (Supabase Realtime) ; un snapshot quotidien complet est
     aussi déposé dans la table « backups ».
   - Export complet en un clic (JSON) et restauration depuis un
     export, en tout temps, depuis les Réglages.
   ============================================================ */
(function () {
  "use strict";

  const LS_KEY = "wl_livraison_db_v1";
  const LS_BACKUP = "wl_livraison_db_backup";       // copie de secours automatique
  const LS_SNAPS = "wl_livraison_snapshots";        // snapshots quotidiens (local)
  const SUPA_CDN = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js";

  const cfg = window.WL_CONFIG || {};
  const MODE = (cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY) ? "supabase" : "local";

  /* ---------------- État en mémoire (même forme dans les 2 modes) ---------------- */
  let DB = null;
  let onRemoteChange = null;   // callback défini par app.js
  let supa = null;             // client Supabase (mode supabase)
  let supaUser = null;

  function emptyDB() {
    return { version: 1, profile: null, seeded: false, days: [], stops: [], photos: {} };
  }
  /* v8 : de VRAIS UUID dès la création. Avant, les identifiants locaux
     (base36) n'étaient pas reconnus par le serveur : chaque poussée
     insérait une NOUVELLE copie de l'arrêt dans Supabase au lieu de
     mettre à jour l'existante — les arrêts se multipliaient tout seuls
     à chaque enregistrement et rechargement (vu au test du 21 nov.
     2026 : une journée passée de 38 à 101 arrêts sans aucun ajout). */
  function uid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
    });
  }
  /* Adopte l'identifiant serveur d'un arrêt créé avec un ancien
     identifiant local : les photos suivent sous le nouvel identifiant. */
  function adoptStopId(stop, newId) {
    const oldId = stop.id;
    if (!newId || oldId === newId) return;
    stop.id = newId;
    const bucket = DB.photos[oldId];
    if (bucket) {
      const target = DB.photos[newId] || (DB.photos[newId] = []);
      const urls = new Set(target.map((p) => p.dataUrl));
      bucket.forEach((p) => { if (!urls.has(p.dataUrl)) target.push(p); });
      delete DB.photos[oldId];
    }
  }
  function todayISO() {
    const d = new Date();
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }

  /* ================================================================
     MODE LOCAL — persistance immédiate + copies automatiques
     ================================================================ */
  function persistLocal() {
    try { localStorage.setItem(LS_KEY, JSON.stringify(DB)); } catch (e) {
      // v17 : si le stockage est plein, réessayer SANS les photos
      // déjà confirmées par le serveur (elles y sont en sécurité) —
      // seules les photos « sales » (pas encore rendues) restent sur
      // l'appareil. Avant, l'échec était silencieux et la copie
      // locale restait figée à un vieil état.
      try {
        const light = Object.assign({}, DB, { photos: {} });
        Object.keys(DB.photos || {}).forEach((sid) => {
          if (dirtyPhotoStops.has(sid)) light.photos[sid] = DB.photos[sid];
        });
        localStorage.setItem(LS_KEY, JSON.stringify(light));
      } catch (e2) { /* même allégée, ça ne rentre pas : le serveur et les ensembles sales persistés prennent le relais */ }
      warnQuota(e);
    }
    // Copie de secours automatique, réécrite à chaque changement.
    // v13 : SANS les photos (elles sont dans la copie principale et
    // sur Supabase) — ça divise l'empreinte locale et repousse
    // l'avis « stockage presque plein » vu au rodage v12.
    try { localStorage.setItem(LS_BACKUP, JSON.stringify({ at: Date.now(), db: Object.assign({}, DB, { photos: {} }) })); } catch (e) { /* silencieux */ }
    maybeDailySnapshot();
  }

  function maybeDailySnapshot() {
    const today = todayISO();
    let snaps = [];
    try { snaps = JSON.parse(localStorage.getItem(LS_SNAPS) || "[]"); } catch (e) { snaps = []; }
    if (snaps.some((s) => s.date === today)) return;
    const snap = { date: today, at: Date.now(), db: JSON.parse(JSON.stringify(DB)) };
    snaps.push(snap);
    snaps = snaps.slice(-14); // 14 jours de snapshots
    try {
      localStorage.setItem(LS_SNAPS, JSON.stringify(snaps));
    } catch (e) {
      // Si les photos prennent trop de place, snapshot sans les photos
      try {
        snap.db = Object.assign({}, snap.db, { photos: {} });
        snap.sansPhotos = true;
        localStorage.setItem(LS_SNAPS, JSON.stringify(snaps));
      } catch (e2) { /* on garde au moins la copie de secours */ }
    }
  }

  function loadLocal() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) { DB = JSON.parse(raw); return; }
    } catch (e) { /* corrompu : on tombe sur la copie de secours */ }
    try {
      const bak = JSON.parse(localStorage.getItem(LS_BACKUP) || "null");
      if (bak && bak.db) { DB = bak.db; return; }
    } catch (e) { /* rien à faire */ }
    try {
      const snaps = JSON.parse(localStorage.getItem(LS_SNAPS) || "[]");
      if (snaps.length) { DB = snaps[snaps.length - 1].db; return; }
    } catch (e) { /* rien à faire */ }
    DB = emptyDB();
  }

  /* Une seule journée par date (règle absolue) : si l'appareil contient
     deux journées à la même date (ex. création locale + synchro), on les
     fusionne — les arrêts des journées en trop sont déplacés dans la
     journée gardée, jamais supprimés. Sans ça, l'accueil montre la
     journée en double, puis la copie locale disparaît d'un coup au
     rechargement serveur (bug vu par William le 20 nov. 2026). */
  function dedupeDays() {
    if (!DB || !Array.isArray(DB.days)) return;
    const byDate = {};
    DB.days.forEach((d) => { (byDate[d.date] = byDate[d.date] || []).push(d); });
    const dropped = new Set();
    Object.keys(byDate).forEach((date) => {
      const group = byDate[date];
      if (group.length < 2) return;
      const count = (d) => DB.stops.filter((s) => s.dayId === d.id && !s.deletedAt).length;
      const keeper = [...group].sort((a, b) => {
        if (!!a.deletedAt !== !!b.deletedAt) return a.deletedAt ? 1 : -1;
        if (uuidOk(a.id) !== uuidOk(b.id)) return uuidOk(a.id) ? -1 : 1;
        return count(b) - count(a);
      })[0];
      let pos = DB.stops.filter((s) => s.dayId === keeper.id)
        .reduce((m, s) => Math.max(m, s.position || 0), -1) + 1;
      group.forEach((d) => {
        if (d === keeper) return;
        DB.stops.filter((s) => s.dayId === d.id)
          .sort((a, b) => (a.position || 0) - (b.position || 0))
          .forEach((s) => { s.dayId = keeper.id; s.position = pos++; });
        if (keeper.deletedAt && !d.deletedAt) keeper.deletedAt = null;
        dropped.add(d.id);
      });
    });
    if (dropped.size) {
      DB.days = DB.days.filter((d) => !dropped.has(d.id));
      try { persistLocal(); } catch (e) { /* le prochain save() s'en chargera */ }
    }
  }

  /* v8 : une seule copie de chaque arrêt par journée. Les copies
     créées par l'ancien bug de synchro (même adresse, même client,
     même appareil, même téléphone dans la même journée) sont
     fusionnées : on garde la copie qui a un identifiant serveur,
     sinon celle qui a des photos ; les photos des copies retirées
     sont déplacées sur la copie gardée, puis les positions sont
     renumérotées. Les arrêts encore vides (aucune adresse, aucun
     client, aucun appareil) ne sont jamais fusionnés. */
  function dedupeStops() {
    if (!DB || !Array.isArray(DB.stops)) return;
    const seen = {};
    const dropped = new Set();
    const score = (s) => (uuidOk(s.id) ? 2 : 0) + ((DB.photos[s.id] || []).length ? 1 : 0);
    [...DB.stops].sort((a, b) => score(b) - score(a)).forEach((s) => {
      if (!(s.addressKey || s.client || s.appliance)) return;
      // v9 : les copies SUPPRIMÉES sont fusionnées aussi (groupe à
      // part) — avant, elles s'accumulaient dans la corbeille à
      // chaque cycle suppression/restauration.
      // v17 : la POSITION et l'ETA font partie de la clé. Une copie
      // DÉLIBÉRÉE (bouton « Dupliquer ») reçoit la position de fin
      // de journée et un eta vierge : elle n'est donc plus confondue
      // avec son original, fusionnée et EFFACÉE AU SERVEUR à chaque
      // rechargement (bug (e) du rodage v16). Seuls les vrais clones
      // fantômes de l'ancien bug — même position, même eta, même
      // contenu — sont encore fusionnés.
      const k = [s.deletedAt ? "del" : "live", s.dayId, s.position || 0, s.eta == null ? "" : s.eta, s.addressKey || "", s.client || "", s.appliance || "", s.phone || ""].join("|");
      if (!seen[k]) { seen[k] = s; return; }
      const keeper = seen[k];
      const from = DB.photos[s.id] || [];
      if (from.length) {
        const target = DB.photos[keeper.id] || (DB.photos[keeper.id] = []);
        const urls = new Set(target.map((p) => p.dataUrl));
        from.forEach((p) => { if (!urls.has(p.dataUrl)) { target.push(p); urls.add(p.dataUrl); } });
        delete DB.photos[s.id];
      }
      dropped.add(s.id);
    });
    if (dropped.size) {
      // v9 : effacer pour de bon les copies en trop côté serveur,
      // sinon le prochain rechargement les ramène toutes.
      dropped.forEach((id) => { if (uuidOk(id)) deleteRemote("stops", id); });
      // v17 : les ids retirés sortent aussi du suivi de synchro
      // (leurs photos vivent maintenant sur la copie gardée, dont
      // l'empreinte changera et qui sera repoussée au besoin).
      dropped.forEach((id) => { dirtyStops.delete(id); dirtyPhotoStops.delete(id); cleanStops.delete(id); cleanPhotos.delete(id); });
      DB.stops = DB.stops.filter((s) => !dropped.has(s.id));
      const byDay = {};
      DB.stops.filter((s) => !s.deletedAt).forEach((s) => { (byDay[s.dayId] = byDay[s.dayId] || []).push(s); });
      Object.values(byDay).forEach((list) => list
        .sort((a, b) => (a.position || 0) - (b.position || 0))
        .forEach((s, i) => { s.position = i; }));
      try { persistLocal(); } catch (e) { /* le prochain save() s'en chargera */ }
    }
  }

  /* v7 (principe de William) : les photos appartiennent à l'ARRÊT —
     ce sont les photos des appareils à livrer, elles servent au
     chargement (retrouver les bons appareils dans l'entrepôt).
     Avant, elles étaient rangées par clé d'adresse : si l'adresse
     était retapée, la clé changeait et les photos « disparaissaient »
     pour la validation (arrêt bloqué à tort). Migration des anciennes
     données : chaque arrêt de l'adresse reçoit les photos de
     l'adresse — aucune perte. */
  function migratePhotosToStops() {
    if (!DB || !DB.photos) return;
    const stopIds = new Set((DB.stops || []).map((s) => s.id));
    let changed = false;
    Object.keys(DB.photos).forEach((k) => {
      if (stopIds.has(k)) return;
      const bucket = DB.photos[k] || [];
      (DB.stops || []).filter((s) => s.addressKey === k).forEach((s) => {
        const target = DB.photos[s.id] || (DB.photos[s.id] = []);
        const seen = new Set(target.map((p) => p.dataUrl));
        bucket.forEach((p) => { if (!seen.has(p.dataUrl)) { target.push(p); seen.add(p.dataUrl); } });
      });
      delete DB.photos[k];
      changed = true;
    });
    if (changed) { try { persistLocal(); } catch (e) { /* le prochain save() s'en chargera */ } }
  }

  let quotaWarned = false;
  function warnQuota() {
    if (quotaWarned) return;
    quotaWarned = true;
    if (window.WL_toast) window.WL_toast("Stockage du téléphone presque plein : exporte une sauvegarde (Réglages).");
  }

  /* ================================================================
     MODE SUPABASE — poussée immédiate + temps réel
     ================================================================ */
  function loadScript(src) {
    return new Promise((res, rej) => {
      const s = document.createElement("script");
      s.src = src; s.onload = res; s.onerror = rej;
      document.head.appendChild(s);
    });
  }

  async function initSupabase() {
    await loadScript(SUPA_CDN);
    supa = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
    const { data } = await supa.auth.getSession();
    supaUser = data && data.session ? data.session.user : null;
    return !!supaUser;
  }

  async function signIn(email, password) {
    const { data, error } = await supa.auth.signInWithPassword({ email, password });
    if (error) throw error;
    supaUser = data.user;
    loadSyncMeta();
    recomputeDirty();
    // v17 : pousser d'abord ce que l'appareil a et que le serveur
    // n'a pas confirmé, puis recharger — jamais l'inverse.
    if (hasLocalDiff()) await pushSupabaseNowInner();
    await reloadFromSupabase();
    subscribeRealtime();
    return supaUser;
  }

  async function reloadFromSupabase() {
    const [daysR, stopsR, photosR, profR, addrR] = await Promise.all([
      supa.from("days").select("*").order("date"),
      supa.from("stops").select("*").order("position"),
      supa.from("photos").select("id, stop_id, address_id, created_at"), // v15 : sans data_url (le volume) — voir plus bas
      supa.from("profiles").select("*"),
      supa.from("addresses").select("*") // v16 : en parallèle (avant : un aller-retour de plus en série)
    ]);
    // v17 : les erreurs de LECTURE sont enfin vérifiées ici. Avant,
    // un échec (réseau, session expirée) donnait data = null, traité
    // comme « table vide » : la base reconstruite était vide ou
    // partielle, puis persistLocal() l'écrivait PAR-DESSUS la copie
    // locale saine — l'écran se vidait et les données semblaient
    // perdues au rechargement. Maintenant : on abandonne le
    // rechargement, la base courante reste en place, l'état passe
    // en erreur (jamais « ✓ Synchronisé » sur une lecture ratée).
    if (daysR.error || stopsR.error || photosR.error || addrR.error) {
      console.warn("Rechargement Supabase abandonné (lecture en erreur).",
        daysR.error || stopsR.error || photosR.error || addrR.error);
      setSyncState("error");
      scheduleSyncRetry();
      return;
    }
    const next = emptyDB();
    next.profile = DB ? DB.profile : null;
    next.seeded = DB ? !!DB.seeded : false; // v8 : ne pas reperdre le marqueur à chaque rechargement (la journée démo revenait sans cesse)
    next.days = (daysR.data || []).map((d) => ({
      id: d.id, date: d.date, startTime: "08:00", // départ de l'entrepôt TOUJOURS 8 h 00 (règle de William)
      status: d.status, optimized: !!d.optimized,
      deletedAt: d.deleted_at ? Date.parse(d.deleted_at) : null
    }));
    const addrById = {};
    (addrR.data || []).forEach((a) => { addrById[a.id] = a; });
    next.stops = (stopsR.data || []).map((s) => {
      const a = addrById[s.address_id] || {};
      return {
        id: s.id, dayId: s.day_id, position: s.position || 0,
        address: a.full_address || "", street: a.street || "", city: a.city || "",
        sector: a.sector || "", postal: a.postal_code || "",
        lat: a.lat, lng: a.lng, addressKey: a.address_key || "",
        client: s.client_name || "", apartment: s.apartment || "", apartmentNone: !!s.apartment_none, phone: s.phone || "",
        vendor: s.vendor_name || "", appliance: s.appliance || "", pieces: s.pieces || 1,
        installation: !!s.installation, pickup: !!s.pickup,
        orderPref: s.order_pref || "auto", type: s.type || "livraison",
        win1s: t2m(s.win1_start), win1e: t2m(s.win1_end),
        win2s: t2m(s.win2_start), win2e: t2m(s.win2_end),
        duration: 15, details: s.details || "", // durée d'arrêt TOUJOURS 15 min (règle de William)
        delivered: !!s.delivered, failed: !!s.failed,
        eta: s.eta_min != null ? s.eta_min : null,
        deletedAt: s.deleted_at ? Date.parse(s.deleted_at) : null
      };
    });
    // v15 : les photos sont le gros du volume (base64). On ne
    // télécharge les data_url QUE pour les arrêts dont l'ensemble
    // d'identifiants photos a changé depuis la copie locale ; les
    // autres recopient leurs objets locaux. (Le chargement de
    // l'accueil prenait jusqu'à ~55 s en rechargeant toutes les
    // photos à chaque fois.)
    const localPhotos = (DB && DB.photos) || {};
    const srvPhotoIdsByStop = {};
    const legacyPhotoIds = [];
    (photosR.data || []).forEach((p) => {
      if (p.stop_id) { (srvPhotoIdsByStop[p.stop_id] = srvPhotoIdsByStop[p.stop_id] || []).push(p.id); }
      else if (p.address_id) legacyPhotoIds.push(p.id);
    });
    const changedStopIds = [];
    const allPhotoStopIds = new Set([...Object.keys(srvPhotoIdsByStop), ...next.stops.map((s) => s.id)]);
    allPhotoStopIds.forEach((sid) => {
      const srv = (srvPhotoIdsByStop[sid] || []).slice().sort().join(",");
      const loc = ((localPhotos[sid] || []).map((x) => x.id)).slice().sort().join(",");
      if (srv !== loc) changedStopIds.push(sid);
    });
    let fullPhotos = [];
    if (changedStopIds.length) {
      const r = await supa.from("photos").select("*").in("stop_id", changedStopIds);
      if (r.error) { // v17 : abandonner plutôt que de tronquer les photos
        console.warn("Rechargement abandonné (photos illisibles).", r.error);
        setSyncState("error"); scheduleSyncRetry(); return;
      }
      fullPhotos = r.data || [];
    }
    if (legacyPhotoIds.length) {
      const r = await supa.from("photos").select("*").in("id", legacyPhotoIds);
      if (r.error) {
        console.warn("Rechargement abandonné (photos illisibles).", r.error);
        setSyncState("error"); scheduleSyncRetry(); return;
      }
      fullPhotos = fullPhotos.concat(r.data || []);
    }
    next.stops.forEach((s) => {
      if (changedStopIds.indexOf(s.id) === -1 && localPhotos[s.id] && (srvPhotoIdsByStop[s.id] || []).length) {
        next.photos[s.id] = localPhotos[s.id].slice();
      }
    });
    fullPhotos.forEach((p) => {
      const photo = { id: p.id, dataUrl: p.data_url, ts: Date.parse(p.created_at) || Date.now() };
      if (p.stop_id) { // v7 : photos rattachées à l'arrêt
        next.photos[p.stop_id] = next.photos[p.stop_id] || [];
        next.photos[p.stop_id].push(photo);
        return;
      }
      // Anciennes photos (avant v7) rattachées à l'adresse : données à
      // chaque arrêt de cette adresse — aucune perte.
      const a = addrById[p.address_id];
      if (!a) return;
      next.stops.filter((s) => s.addressKey === (a.address_key || "")).forEach((s) => {
        const arr = next.photos[s.id] || (next.photos[s.id] = []);
        if (!arr.some((x) => x.dataUrl === p.data_url)) arr.push(photo);
      });
    });
    // v17 : retenir quelles entités viennent vraiment du serveur
    // dans cette lecture — à la fin du rechargement, seules celles-là
    // pourront avancer les empreintes « propres » (voir plus bas).
    const srvDayDateSet = new Set(next.days.map((d) => d.date));
    const srvStopIdSet = new Set(next.stops.map((s) => s.id));
    // Préserver ce qui n'existe encore que sur cet appareil (créé hors
    // connexion ou pas encore poussé) : sans ça, le rechargement serveur
    // l'effacerait de l'écran — et de l'appareil — en silence.
    if (DB) {
      migratePhotosToStops(); // anciennes photos par adresse -> par arrêt, avant la fusion
      const srvDayByDate = {};
      next.days.forEach((d) => { srvDayByDate[d.date] = d; });
      const srvStopIds = new Set(next.stops.map((s) => s.id));
      const localDayById = {};
      (DB.days || []).forEach((d) => { localDayById[d.id] = d; });
      (DB.days || []).forEach((d) => {
        if (!srvDayByDate[d.date]) { next.days.push(d); srvDayByDate[d.date] = d; }
      });
      (DB.stops || []).forEach((s) => {
        if (srvStopIds.has(s.id)) return;
        const ld = localDayById[s.dayId];
        if (!ld) return;
        const target = srvDayByDate[ld.date];
        if (!target) return;
        // v8 : la vérification de doublon se fait TOUJOURS (avant, elle
        // était sautée quand l'arrêt local pointait déjà sur la journée
        // serveur — la copie locale s'ajoutait alors à la copie serveur,
        // encore et encore). Une copie serveur SUPPRIMÉE compte aussi
        // comme doublon : une suppression faite ailleurs gagne, la
        // copie locale ne ressuscite pas l'arrêt.
        const dup = next.stops.some((x) => x.dayId === target.id &&
          x.addressKey === s.addressKey && x.client === s.client &&
          x.appliance === s.appliance && x.phone === s.phone);
        if (dup) return;
        if (target.id !== s.dayId) s = Object.assign({}, s, { dayId: target.id });
        next.stops.push(s);
      });
      // Photos locales pas encore au serveur : jamais perdues. Si
      // l'arrêt local a été remplacé par sa copie serveur, on rattache
      // ses photos au successeur (même date de journée + même position).
      const haveUrl = new Set();
      Object.values(next.photos).forEach((arr) => arr.forEach((p) => haveUrl.add(p.dataUrl)));
      const nextDayDate = {}; next.days.forEach((d) => { nextDayDate[d.id] = d.date; });
      const oldDayDate = {}; (DB.days || []).forEach((d) => { oldDayDate[d.id] = d.date; });
      (DB.stops || []).forEach((s) => {
        const bucket = (DB.photos || {})[s.id];
        if (!bucket || !bucket.length) return;
        let target = next.stops.find((x) => x.id === s.id);
        if (!target) target = next.stops.find((x) => nextDayDate[x.dayId] === oldDayDate[s.dayId] && (x.position || 0) === (s.position || 0));
        if (!target) target = next.stops.find((x) => nextDayDate[x.dayId] === oldDayDate[s.dayId] &&
          x.addressKey === s.addressKey && x.client === s.client && x.appliance === s.appliance);
        if (!target) return;
        const arr = next.photos[target.id] || (next.photos[target.id] = []);
        bucket.forEach((p) => { if (!haveUrl.has(p.dataUrl)) { arr.push(p); haveUrl.add(p.dataUrl); } });
      });
    }
    // v9 : les totaux de trajet (routeMin, routeKm, returnMin) ne
    // vivent que sur l'appareil (aucune colonne serveur) — les
    // recopier depuis la journée locale de même date, sinon chaque
    // rechargement les efface et l'app prétend à tort que le trajet
    // n'est pas calculé.
    if (DB) {
      const localByDate = {};
      (DB.days || []).forEach((d) => { localByDate[d.date] = d; });
      next.days.forEach((d) => {
        const l = localByDate[d.date];
        if (l && d.routeMin == null && l.routeMin != null) {
          d.routeMin = l.routeMin; d.routeKm = l.routeKm; d.returnMin = l.returnMin;
        }
      });
      // v17 : les anciens hacks « l'état local gagne » (v10 statut
      // confirmé, v11 corbeille) sont RETIRÉS — ils corrigeaient
      // TOUTES les entités, y compris celles que le serveur avait
      // à jour, et masquaient les vraies pertes. Ils sont remplacés
      // par la surcouche ciblée des entités « sales » ci-dessous,
      // qui ne protège que ce qui n'a pas été confirmé par le
      // serveur.
    }
    // v10 : un arrêt dont la JOURNÉE est supprimée est supprimé
    // aussi, même si sa propre ligne serveur n'a pas encore son
    // deleted_at — cas vu au retest v9 : poussée de suppression
    // interrompue en plein vol (la journée partait, ses arrêts
    // non), puis recréation immédiate de la journée = les arrêts
    // « ressuscitaient ». La restauration depuis la corbeille
    // relève journée ET arrêts explicitement : pas touchée.
    // (Appliqué AVANT la surcouche des entités « sales » ci-dessous,
    // pour ne pas écraser une restauration en cours.)
    const deletedDayById = {};
    next.days.forEach((d) => { if (d.deletedAt) deletedDayById[d.id] = d.deletedAt; });
    next.stops.forEach((s) => {
      if (!s.deletedAt && deletedDayById[s.dayId]) s.deletedAt = deletedDayById[s.dayId];
    });
    // v17 : SURCOUCHE DES ENTITÉS « SALES ». Une entité présente
    // dans les ensembles « sales » persistés (modifiée localement,
    // jamais confirmée par une écriture VÉRIFIÉE — voir le suivi
    // explicite plus bas) garde sa forme locale dans la base
    // fusionnée ; tout le reste vient du serveur. Contrairement à
    // la surcouche v16, la décision ne dépend plus d'une
    // comparaison d'ombre reconstruite (qui pouvait déclarer
    // « propre » une entité que le serveur n'avait jamais reçue),
    // mais d'un fait enregistré au moment de la modification et
    // effacé seulement après vérification.
    if (DB) {
      (DB.days || []).forEach((ld) => {
        if (!dirtyDays.has(ld.date)) return;
        const nd = next.days.find((d) => d.date === ld.date);
        if (!nd) return; // inconnue du serveur : préservée plus haut
        nd.status = ld.status; nd.optimized = ld.optimized; nd.deletedAt = ld.deletedAt;
        if (ld.routeMin != null) { nd.routeMin = ld.routeMin; nd.routeKm = ld.routeKm; nd.returnMin = ld.returnMin; }
      });
      (DB.stops || []).forEach((ls) => {
        if (!dirtyStops.has(ls.id)) return;
        const ns = next.stops.find((s) => s.id === ls.id);
        if (!ns) return; // inconnu du serveur : préservé plus haut
        const keepDayId = ns.dayId;
        Object.assign(ns, ls, { id: ns.id, dayId: keepDayId });
        delete ns._addressId;
      });
      Object.keys(DB.photos || {}).forEach((sid) => {
        if (!dirtyPhotoStops.has(sid)) return;
        next.photos[sid] = (DB.photos[sid] || []).slice();
      });
    }
    DB = next;
    dedupeDays();
    dedupeStops();
    // v17 : recalculer les ensembles « sales » contre les
    // empreintes « propres » AVANT d'avancer celles-ci — une photo
    // locale absorbée par la fusion ci-dessus (jamais rendue au
    // serveur) doit rester « sale », pas devenir propre par
    // absorption. Ensuite seulement, les empreintes des entités
    // venues du serveur et non sales avancent jusqu'à l'état lu.
    recomputeDirty();
    refreshCleanFromDB(srvDayDateSet, srvStopIdSet);
    // La copie locale reflète TOUJOURS la base fusionnée — sinon,
    // au prochain démarrage, une vieille copie locale serait prise
    // pour un changement local et écraserait le serveur.
    persistLocal();
    persistSyncMeta();
    refreshUnpushed();
    if (unpushedChanges) { setSyncState("pending"); pushSupabaseSoon(); } // envoyer la surcouche
    else setSyncState("ok");
  }

  function t2m(t) { // "10:30:00" -> 630
    if (!t) return null;
    const p = String(t).split(":");
    return parseInt(p[0], 10) * 60 + parseInt(p[1], 10);
  }
  function m2t(m) { // 630 -> "10:30"
    if (m == null) return null;
    return String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0");
  }

  /* v9 : poussées et rechargements passent par UNE SEULE file
     d'opérations — jamais en même temps. Avant, un rechargement
     déclenché par l'écho temps réel d'une poussée pouvait reconstruire
     la base depuis un état serveur pas encore à jour et ÉCRASER les
     modifications locales en attente (champs d'éditeur perdus,
     suppressions qui revenaient) — vu au rodage v8. */
  let opChain = Promise.resolve();
  function enqueueOp(fn) {
    const p = opChain.then(fn, fn);
    opChain = p.then(() => {}, () => {});
    return p;
  }
  /* v13 : drapeau « modifications locales pas encore poussées ».
     Un rechargement qui lit le serveur AVANT la poussée en attente
     (délai de 350 ms) reconstruisait l'ancienne base et ÉCRAASAIT
     le changement local — puis la poussée envoyait l'état écrasé.
     Vu au rodage v12 : statut « livré », créneau Rive-Sud et
     bascules Collecte/reprise perdus au rechargement. Règle : un
     rechargement commence par POUSSER ce qui est en attente. */
  let unpushedChanges = false;

  /* v17 : SUIVI EXPLICITE DES ENTITÉS « SALES » (remplace l'ombre
     serveur des v15-v16).
     Diagnostic du rodage v16 (22 nov.) : les CRÉATIONS passaient,
     mais TOUTE modification d'une donnée existante (champ édité,
     optimisation, corbeille, duplication, photos) était perdue au
     rechargement alors que l'en-tête affichait « ✓ Synchronisé ».
     Mécanisme : les upserts de la poussée partaient SANS .select()
     — une écriture que le serveur n'appliquait pas ne produisait
     donc aucune erreur visible ; malgré ça, rebuildShadowFromDB()
     avançait l'« ombre » jusqu'à l'état local et l'état passait à
     « ok ». Dès lors, la différence avait disparu des deux côtés :
     les poussées suivantes sautaient l'entité (« égale à l'ombre »)
     et le rechargement ramenait la valeur du serveur. Perte
     permanente ET invisible. Aggravants : l'ombre persistée
     gardait une 2e copie de toutes les photos en base64
     (localStorage saturé — bannière « stockage presque plein »
     vue au rodage) et dedupeStops() effaçait au serveur les
     duplications délibérées (voir plus bas).
     Nouveau principe, plus simple et vérifiable :
     - chaque entité modifiée entre dans un ensemble « sale »
       PERSISTÉ (dirtyDays par date, dirtyStops et dirtyPhotoStops
       par id d'arrêt), calculé par empreintes dans save() ;
     - la poussée n'écrit QUE les entités sales, et chaque écriture
       est VÉRIFIÉE par les lignes retournées (.select()) comparées
       aux valeurs envoyées ; les photos sont relues et leurs
       ensembles d'URLs comparés ;
     - un id ne sort de l'ensemble sale QU'APRÈS cette vérification,
       et seulement si son empreinte n'a pas changé pendant la
       poussée ;
     - tout écart = exception = état « error », ensembles conservés,
       nouvel essai automatique. « ✓ Synchronisé » ne s'affiche que
       lorsque les ensembles sales sont vides après un cycle vérifié.
     Les empreintes utilisent des clés STABLES (date de journée,
     clé d'adresse) plutôt que les identifiants serveur, et les
     photos sont empreintées par hachage — jamais de base64 dans
     l'état de synchro. */
  function dayRowOf(d) {
    return {
      id: uuidOk(d.id) ? d.id : undefined, date: d.date,
      start_time: "08:00", status: d.status, optimized: d.optimized,
      deleted_at: d.deletedAt ? new Date(d.deletedAt).toISOString() : null
    };
  }
  function stopRowOf(s, dayId, addressId) {
    return {
      day_id: dayId, address_id: addressId || null,
      position: s.position || 0, client_name: s.client, apartment: s.apartment, apartment_none: !!s.apartmentNone,
      phone: s.phone, vendor_name: s.vendor, appliance: s.appliance,
      pieces: s.pieces, installation: s.installation, pickup: s.pickup,
      order_pref: s.orderPref, type: s.type,
      win1_start: m2t(s.win1s), win1_end: m2t(s.win1e),
      win2_start: m2t(s.win2s), win2_end: m2t(s.win2e),
      duration_min: 15, details: s.details,
      delivered: s.delivered, failed: s.failed, eta_min: s.eta,
      deleted_at: s.deletedAt ? new Date(s.deletedAt).toISOString() : null
    };
  }
  function addrRowOf(s) {
    return {
      address_key: s.addressKey, full_address: s.address, street: s.street,
      city: s.city, sector: s.sector, postal_code: s.postal, lat: s.lat, lng: s.lng
    };
  }
  function addrCmpOf(r) {
    return JSON.stringify({ full_address: r.full_address, street: r.street, city: r.city, sector: r.sector, postal_code: r.postal_code, lat: r.lat, lng: r.lng });
  }
  /* v17 : EMPREINTES des entités, pour le suivi « propre / sale ».
     Une empreinte décrit le contenu SYNCHRONISABLE d'une entité
     avec des clés stables : la journée est repérée par sa DATE et
     l'adresse par sa CLÉ (jamais par les identifiants serveur, qui
     peuvent être adoptés/remplacés sans que le contenu change). */
  function dayFP(d) {
    return JSON.stringify({ status: d.status, optimized: !!d.optimized, deleted_ms: d.deletedAt || null });
  }
  function stopFP(s) {
    const day = ((DB && DB.days) || []).find((d) => d.id === s.dayId);
    const r = stopRowOf(s, day ? day.date : s.dayId, null);
    r.day_id = day ? day.date : (s.dayId || null); // la DATE (stable), pas l'id serveur
    r.address_id = s.addressKey || null;          // la CLÉ d'adresse (stable), pas l'id serveur
    r.deleted_at = s.deletedAt || null;           // comparer en ms des deux côtés
    return JSON.stringify(r);
  }
  function hashStr(str) { // cyrb53 — empreinte courte d'une photo (jamais le base64 lui-même)
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (let i = 0; i < str.length; i++) {
      const ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (h2 >>> 0).toString(16) + (h1 >>> 0).toString(16) + ":" + str.length;
  }
  function photoFP(bucket) {
    return (bucket || []).map((p) => hashStr(p.dataUrl || "")).sort().join(",");
  }

  /* v17 : ÉTAT DE SYNCHRO PERSISTÉ (localStorage) : les empreintes
     « propres » (dernier état CONFIRMÉ par le serveur pour chaque
     entité) et les ensembles « sales » (entités modifiées depuis).
     Léger : aucune photo en base64 ici — seulement des empreintes.
     L'ancienne clé d'ombre v15-v16 est abandonnée (et retirée) :
     sans empreintes connues, le premier démarrage v17 considère
     TOUT comme sale — la première poussée vérifiée réécrira tout
     et établira les empreintes. C'est volontairement conservateur :
     mieux vaut tout réécrire une fois que perdre une modification. */
  const LS_SYNC = "wl_livraison_sync_v17";
  let cleanDays = new Map(), cleanStops = new Map(), cleanPhotos = new Map();
  let dirtyDays = new Set(), dirtyStops = new Set(), dirtyPhotoStops = new Set();
  function persistSyncMeta() {
    try {
      localStorage.setItem(LS_SYNC, JSON.stringify({
        cleanDays: [...cleanDays], cleanStops: [...cleanStops], cleanPhotos: [...cleanPhotos],
        dirtyDays: [...dirtyDays], dirtyStops: [...dirtyStops], dirtyPhotoStops: [...dirtyPhotoStops]
      }));
    } catch (e) { /* le filet recomputeDirty() au prochain démarrage rattrape */ }
  }
  function loadSyncMeta() {
    try { localStorage.removeItem("wl_livraison_shadow_v1"); } catch (e) { /* nettoyage v16 */ }
    try {
      const o = JSON.parse(localStorage.getItem(LS_SYNC) || "null");
      if (o) {
        cleanDays = new Map(o.cleanDays || []); cleanStops = new Map(o.cleanStops || []);
        cleanPhotos = new Map(o.cleanPhotos || []);
        dirtyDays = new Set(o.dirtyDays || []); dirtyStops = new Set(o.dirtyStops || []);
        dirtyPhotoStops = new Set(o.dirtyPhotoStops || []);
        return;
      }
    } catch (e) { /* première fois */ }
    cleanDays = new Map(); cleanStops = new Map(); cleanPhotos = new Map();
    dirtyDays = new Set(); dirtyStops = new Set(); dirtyPhotoStops = new Set();
  }
  function refreshUnpushed() {
    unpushedChanges = dirtyDays.size + dirtyStops.size + dirtyPhotoStops.size > 0;
  }
  /* Recalcule les ensembles « sales » en comparant chaque entité
     locale à son empreinte « propre ». Filet de sécurité appelé à
     chaque sauvegarde et à chaque démarrage : même si un ensemble
     persisté était perdu, un écart réel est redétecté ici. Un
     ensemble ne rétrécit JAMAIS ici — seul un cycle de poussée
     vérifiée retire des ids. */
  function recomputeDirty() {
    if (!DB) return;
    (DB.days || []).forEach((d) => { if (cleanDays.get(d.date) !== dayFP(d)) dirtyDays.add(d.date); });
    (DB.stops || []).forEach((s) => { if (cleanStops.get(s.id) !== stopFP(s)) dirtyStops.add(s.id); });
    const photoStopIds = new Set([...Object.keys(DB.photos || {}), ...cleanPhotos.keys()]);
    photoStopIds.forEach((sid) => {
      const fp = photoFP((DB.photos || {})[sid]);
      if (fp === "" && !cleanPhotos.has(sid)) return; // arrêt sans photo jamais poussé : rien à suivre
      if (cleanPhotos.get(sid) !== fp) dirtyPhotoStops.add(sid);
    });
    refreshUnpushed();
  }
  /* Après un rechargement : les empreintes « propres » des entités
     LUES du serveur et NON sales avancent jusqu'à l'état lu (c'est
     l'état que le serveur vient de confirmer par cette lecture).
     Les entités absentes de la lecture (préservées localement) et
     les entités sales gardent leur ancienne empreinte. */
  function refreshCleanFromDB(srvDayDateSet, srvStopIdSet) {
    if (!DB) return;
    (DB.days || []).forEach((d) => {
      if (srvDayDateSet && !srvDayDateSet.has(d.date)) return;
      if (!dirtyDays.has(d.date)) cleanDays.set(d.date, dayFP(d));
    });
    (DB.stops || []).forEach((s) => {
      if (srvStopIdSet && !srvStopIdSet.has(s.id)) return;
      if (!dirtyStops.has(s.id)) cleanStops.set(s.id, stopFP(s));
      if (!dirtyPhotoStops.has(s.id)) cleanPhotos.set(s.id, photoFP((DB.photos || {})[s.id]));
    });
    // Oublier les empreintes d'entités disparues de la base.
    const dates = new Set((DB.days || []).map((d) => d.date));
    [...cleanDays.keys()].forEach((k) => { if (!dates.has(k) && !dirtyDays.has(k)) cleanDays.delete(k); });
    const ids = new Set((DB.stops || []).map((s) => s.id));
    [...cleanStops.keys()].forEach((k) => { if (!ids.has(k) && !dirtyStops.has(k)) cleanStops.delete(k); });
    [...cleanPhotos.keys()].forEach((k) => { if (!ids.has(k) && !dirtyPhotoStops.has(k)) cleanPhotos.delete(k); });
  }
  function hasLocalDiff() {
    if (!DB) return false;
    recomputeDirty();
    return unpushedChanges;
  }

  /* v16 : état de synchronisation VISIBLE. Avant, l'indicateur
     « ✓ Enregistré » ne parlait que de l'écriture sur l'appareil,
     même quand le serveur n'avait rien reçu — l'utilisateur
     croyait ses données en sécurité alors qu'elles ne l'étaient
     pas. Maintenant : pending = poussée en cours, error = le
     serveur n'a pas confirmé (nouvel essai automatique), ok =
     le serveur a tout reçu.
     v17 : l'état initial en mode supabase est « pending », PAS
     « ok » — avant, l'en-tête pouvait afficher « ✓ Synchronisé »
     dès l'ouverture, avant la moindre vérification. « ok » ne
     vient maintenant que d'un cycle vérifié (poussée confirmée
     ou rechargement propre avec ensembles sales vides). */
  let syncState = MODE === "supabase" ? "pending" : "ok";
  let onSyncState = null;
  function setSyncState(st) {
    if (syncState === st) return;
    syncState = st;
    if (onSyncState) { try { onSyncState(st); } catch (e) { /* affichage seulement */ } }
  }
  let syncRetryTimer = null;
  function scheduleSyncRetry() {
    if (syncRetryTimer) return;
    syncRetryTimer = setTimeout(() => {
      syncRetryTimer = null;
      if (unpushedChanges) pushSupabaseNow();
    }, 5000);
  }
  function throwIfError(ctx, res) {
    if (res && res.error) throw new Error(ctx + " : " + (res.error.message || "erreur Supabase"));
  }

  let syncTimer = null;
  function pushSupabaseSoon() {
    // Poussée quasi immédiate (petit délai pour grouper les frappes d'un champ texte)
    clearTimeout(syncTimer);
    syncTimer = setTimeout(pushSupabaseNow, 350);
  }
  function pushSupabaseNow() { return enqueueOp(pushSupabaseNowInner); }
  async function pushSupabaseNowInner() {
    // v17 : sans session, on ne prétend PLUS que tout est rendu —
    // les ensembles « sales » restent pleins et l'état reste
    // « pending »/« error » jusqu'à une vraie vérification.
    if (!supa || !supaUser) { refreshUnpushed(); return; }
    recomputeDirty();
    if (!unpushedChanges) { setSyncState("ok"); return; }
    setSyncState("pending");
    // Instantané du travail à faire + empreintes au départ : ce qui
    // changera PENDANT la poussée (autre frappe, autre onglet)
    // gardera une empreinte différente et restera « sale ».
    const todoDays = new Set(dirtyDays), todoStops = new Set(dirtyStops), todoPhotos = new Set(dirtyPhotoStops);
    const fpDay0 = new Map(), fpStop0 = new Map(), fpPhoto0 = new Map();
    todoDays.forEach((date) => { const d = DB.days.find((x) => x.date === date); if (d) fpDay0.set(date, dayFP(d)); });
    todoStops.forEach((id) => { const s = DB.stops.find((x) => x.id === id); if (s) fpStop0.set(id, stopFP(s)); });
    todoPhotos.forEach((sid) => { const s = DB.stops.find((x) => x.id === sid); fpPhoto0.set(sid, photoFP(s ? DB.photos[s.id] : [])); });
    const adoptedMap = {}; // ancien id local -> id serveur (arrêts hérités)
    try {
      // 1. Adresses des seuls arrêts concernés (les arrêts y font
      // référence) — upsert VÉRIFIÉ par la ligne retournée.
      const workStops = DB.stops.filter((s) => todoStops.has(s.id) || todoPhotos.has(s.id));
      const addrIdByKey = {};
      for (const s of workStops) {
        if (!s.addressKey || addrIdByKey[s.addressKey]) continue;
        const res = await supa.from("addresses").upsert(addrRowOf(s), { onConflict: "address_key" }).select("id,address_key").single();
        throwIfError("Adresse", res);
        if (!res.data || !res.data.id) throw new Error("Adresse : écriture non confirmée par le serveur");
        addrIdByKey[s.addressKey] = res.data.id;
      }
      workStops.forEach((s) => { if (s.addressKey) s._addressId = addrIdByKey[s.addressKey]; });
      // v17 : plus de pré-passage « suppressions d'abord » (v10-v16).
      // Chaque entité sale est écrite en LIGNE COMPLÈTE, deleted_at
      // compris, et vérifiée — une suppression est une modification
      // comme une autre, ni plus ni moins protégée.
      // 2. Journées sales — lot unique, VÉRIFIÉ ligne par ligne :
      // chaque ligne retournée doit porter exactement les valeurs
      // envoyées (statut, optimisé, corbeille). C'est LE correctif
      // central de la v17 : avant, l'upsert partait sans .select()
      // et une écriture non appliquée passait pour un succès.
      const dayRows = [];
      for (const date of todoDays) {
        const d = DB.days.find((x) => x.date === date);
        if (d) dayRows.push(dayRowOf(d)); else dirtyDays.delete(date); // disparue de la base : plus rien à écrire
      }
      if (dayRows.length) {
        const res = await supa.from("days").upsert(dayRows, { onConflict: "date" }).select("id,date,status,optimized,deleted_at");
        throwIfError("Journées", res);
        const back = {};
        (res.data || []).forEach((r) => { back[r.date] = r; });
        for (const row of dayRows) {
          const r = back[row.date];
          if (!r) throw new Error("Journée " + row.date + " : écriture non confirmée par le serveur");
          const delSent = row.deleted_at ? Date.parse(row.deleted_at) : null;
          const delBack = r.deleted_at ? Date.parse(r.deleted_at) : null;
          if (r.status !== row.status || !!r.optimized !== !!row.optimized || delBack !== delSent) {
            throw new Error("Journée " + row.date + " : le serveur n'a pas les valeurs envoyées");
          }
        }
      }
      // Carte complète des identifiants de journées (les arrêts y
      // font référence) — relue, jamais supposée.
      const dayIdByDate = {};
      const daysNowRes = await supa.from("days").select("id,date");
      throwIfError("Lecture des journées", daysNowRes);
      (daysNowRes.data || []).forEach((d) => { dayIdByDate[d.date] = d.id; });
      // 3. Arrêts sales — lots de 50, VÉRIFIÉS ligne par ligne sur
      // des champs témoins (téléphone, position, eta, corbeille) :
      // si le serveur n'a pas appliqué l'écriture, la ligne
      // retournée le trahit et tout le cycle échoue (voir plus bas).
      const stopRows = [];
      const legacyStops = [];
      const blockedStops = []; // journée inconnue du serveur : on saute l'arrêt ce cycle-ci (il reste « sale »), sans bloquer les autres
      for (const s of workStops) {
        if (!todoStops.has(s.id)) continue;
        const day = DB.days.find((x) => x.id === s.dayId);
        if (!day || !dayIdByDate[day.date]) { blockedStops.push(s.id); continue; }
        const row = stopRowOf(s, dayIdByDate[day.date], s._addressId || null);
        if (row.phone == null) row.phone = null;       // clés toujours présentes dans le lot
        if (row.eta_min == null) row.eta_min = null;   // (sinon PostgREST peut ignorer la colonne)
        if (uuidOk(s.id)) stopRows.push(Object.assign({ id: s.id }, row));
        else legacyStops.push({ s, row });
      }
      for (const { s, row } of legacyStops) {
        // v8 : ancien identifiant local — insertion UNE fois, puis
        // adoption de l'identifiant serveur retourné et VÉRIFIÉ.
        const res = await supa.from("stops").insert(row).select("id").single();
        throwIfError("Arrêt (insertion)", res);
        if (!res.data || !res.data.id) throw new Error("Arrêt : insertion non confirmée par le serveur");
        adoptedMap[s.id] = res.data.id;
        adoptStopId(s, res.data.id);
      }
      for (let i = 0; i < stopRows.length; i += 50) {
        const chunk = stopRows.slice(i, i + 50);
        const res = await supa.from("stops").upsert(chunk, { onConflict: "id" }).select("id,phone,position,eta_min,deleted_at");
        throwIfError("Arrêts", res);
        const back = {};
        (res.data || []).forEach((r) => { back[r.id] = r; });
        for (const row of chunk) {
          const r = back[row.id];
          if (!r) throw new Error("Arrêt " + row.id + " : écriture non confirmée par le serveur");
          const delSent = row.deleted_at ? Date.parse(row.deleted_at) : null;
          const delBack = r.deleted_at ? Date.parse(r.deleted_at) : null;
          if ((r.phone || null) !== (row.phone || null) || r.position !== row.position ||
              (r.eta_min != null ? r.eta_min : null) !== (row.eta_min != null ? row.eta_min : null) ||
              delBack !== delSent) {
            throw new Error("Arrêt " + row.id + " : le serveur n'a pas les valeurs envoyées");
          }
        }
      }
      persistLocal(); // garder les identifiants serveur adoptés
      // 4. Photos des arrêts « photos sales » : rattachées à l'ARRÊT
      // (photos des appareils, pour le chargement). Réconciliation
      // par arrêt, par identifiant d'arrêt UNIQUEMENT (le repli
      // date+position des v8-v16 pouvait viser le mauvais arrêt),
      // puis RELECTURE et comparaison exacte des ensembles d'URLs :
      // l'arrêt ne devient « propre » que si le serveur détient
      // exactement les photos locales. (Avant v7, les photos
      // n'étaient jamais envoyées au serveur — bug du 20 nov.)
      for (const sid0 of todoPhotos) {
        const sid = adoptedMap[sid0] || sid0;
        const s = DB.stops.find((x) => x.id === sid);
        if (!s) { dirtyPhotoStops.delete(sid0); continue; }
        if (!uuidOk(s.id)) continue; // pas encore d'id serveur : restera sale, repartira après l'insertion de l'arrêt
        if (blockedStops.indexOf(s.id) !== -1) continue; // journée absente du serveur : même sort que l'arrêt (voir étape 3)
        const local = DB.photos[s.id] || [];
        const readSrvPhotos = async () => {
          const r = await supa.from("photos").select("id,data_url").eq("stop_id", s.id);
          throwIfError("Photos (lecture serveur)", r);
          return r.data || [];
        };
        let srv = await readSrvPhotos();
        const srvUrls = new Set(srv.map((p) => p.data_url));
        for (const p of local) {
          if (srvUrls.has(p.dataUrl)) {
            const sp = srv.find((x) => x.data_url === p.dataUrl);
            if (sp && p.id !== sp.id) p.id = sp.id; // adopter l'identifiant serveur
            continue;
          }
          const insRes = await supa.from("photos").insert({
            stop_id: s.id, address_id: s._addressId || null, data_url: p.dataUrl
          }).select("id").single();
          throwIfError("Photo (envoi)", insRes);
          if (!insRes.data || !insRes.data.id) throw new Error("Photo : envoi non confirmé par le serveur");
          p.id = insRes.data.id;
          srvUrls.add(p.dataUrl);
        }
        const localUrls = new Set(local.map((p) => p.dataUrl));
        for (const p of srv) {
          if (!localUrls.has(p.data_url)) throwIfError("Photo (suppression)", await supa.from("photos").delete().eq("id", p.id));
        }
        // VÉRIFICATION FINALE : relire et comparer les ensembles.
        srv = await readSrvPhotos();
        const finalUrls = new Set(srv.map((p) => p.data_url));
        if (finalUrls.size !== localUrls.size || [...localUrls].some((u) => !finalUrls.has(u))) {
          throw new Error("Photos de l'arrêt " + s.id + " : le serveur n'a pas l'ensemble envoyé");
        }
        srv.forEach((sp) => {
          const lp = local.find((x) => x.dataUrl === sp.data_url);
          if (lp && lp.id !== sp.id) lp.id = sp.id;
        });
      }
      persistLocal(); // garder les identifiants de photos adoptés
      // 5. On n'arrive ici que si TOUTES les écritures du cycle ont
      // été VÉRIFIÉES. Seulement là, les entités poussées sortent
      // des ensembles « sales » et leurs empreintes « propres »
      // avancent — et seulement si leur empreinte n'a pas changé
      // pendant la poussée (sinon elles restent sales et repartent).
      todoDays.forEach((date) => {
        const d = DB.days.find((x) => x.date === date);
        if (!d) { dirtyDays.delete(date); return; }
        if (fpDay0.has(date) && dayFP(d) === fpDay0.get(date)) { cleanDays.set(date, fpDay0.get(date)); dirtyDays.delete(date); }
      });
      todoStops.forEach((id0) => {
        const id = adoptedMap[id0] || id0;
        const s = DB.stops.find((x) => x.id === id);
        if (!s) { dirtyStops.delete(id0); dirtyStops.delete(id); return; }
        if (fpStop0.has(id0) && stopFP(s) === fpStop0.get(id0)) { cleanStops.set(id, fpStop0.get(id0)); dirtyStops.delete(id0); dirtyStops.delete(id); }
      });
      todoPhotos.forEach((sid0) => {
        const sid = adoptedMap[sid0] || sid0;
        const s = DB.stops.find((x) => x.id === sid);
        if (!s) { dirtyPhotoStops.delete(sid0); dirtyPhotoStops.delete(sid); return; }
        if (!uuidOk(s.id)) return; // jamais parti : reste sale
        if (fpPhoto0.has(sid0) && photoFP(DB.photos[sid]) === fpPhoto0.get(sid0)) {
          cleanPhotos.set(sid, fpPhoto0.get(sid0)); dirtyPhotoStops.delete(sid0); dirtyPhotoStops.delete(sid);
        }
      });
      persistSyncMeta();
      persistLocal();
      refreshUnpushed();
      if (blockedStops.length) {
        // Des arrêts n'ont pas pu partir (journée absente du
        // serveur) : état d'erreur honnête + nouvel essai espacé,
        // le reste du cycle, lui, est bel et bien rendu.
        console.warn("Synchro incomplète — arrêts sans journée au serveur :", blockedStops);
        setSyncState("error");
        scheduleSyncRetry();
      }
      else if (unpushedChanges) { setSyncState("pending"); pushSupabaseSoon(); } // il reste du travail (changé pendant la poussée)
      else setSyncState("ok");
      pushSnapshotSupabase(); // v16 : en arrière-plan — ne bloque plus la poussée
    } catch (e) {
      console.warn("Synchro Supabase ÉCHOUÉE — les données restent sur l'appareil, nouvel essai automatique.", e);
      setSyncState("error");
      scheduleSyncRetry();
      persistLocal(); // filet de sécurité local même en mode Supabase
    }
  }

  let supaSnapDay = "";
  let lastSnapAt = 0;
  // v16 : le throttle du snapshot est PERSISTÉ — avant, il vivait
  // en mémoire seulement : chaque rechargement de page le remettait
  // à zéro et la première poussée repayait l'insertion du snapshot
  // complet (toute la base, photos comprises) — une des causes des
  // poussées de plusieurs dizaines de secondes.
  try {
    const sn = JSON.parse(localStorage.getItem("wl_livraison_snap") || "null");
    if (sn) { supaSnapDay = sn.day || ""; lastSnapAt = sn.at || 0; }
  } catch (e) { /* première fois */ }
  function noteSnap() {
    try { localStorage.setItem("wl_livraison_snap", JSON.stringify({ day: supaSnapDay, at: lastSnapAt })); } catch (e) { /* sans gravité */ }
  }
  async function pushSnapshotSupabase() {
    if (!supa) return;
    const today = todayISO();
    const now = Date.now();
    // Sauvegarde externe (table backups de Supabase) — règle de William,
    // comme pour le site : une sauvegarde à CHAQUE modification (au
    // plus une par 10 minutes), en plus du snapshot quotidien. Les 30
    // plus récentes sont gardées, les plus vieilles sont purgées.
    if (supaSnapDay === today && now - lastSnapAt < 10 * 60 * 1000) return;
    try {
      if (supaSnapDay !== today) {
        const { data } = await supa.from("backups").select("id,created_at").gte("created_at", today).limit(1);
        if (data && data.length) { supaSnapDay = today; lastSnapAt = now; noteSnap(); return; }
      }
      await supa.from("backups").insert({
        payload: exportObject(),
        note: supaSnapDay === today ? "Snapshot automatique — modification" : "Snapshot quotidien automatique"
      });
      supaSnapDay = today; lastSnapAt = now; noteSnap();
      const { data: old } = await supa.from("backups").select("id").order("created_at", { ascending: false }).range(30, 500);
      if (old && old.length) await supa.from("backups").delete().in("id", old.map((b) => b.id));
    } catch (e) { /* la table backups est un plus, jamais un blocage */ }
  }

  let trashPurged = false;
  async function purgeTrash() {
    if (trashPurged || !DB) return;
    trashPurged = true;
    const cutoff = Date.now() - 30 * 24 * 3600 * 1000;
    const oldStops = DB.stops.filter((s) => s.deletedAt && s.deletedAt < cutoff);
    for (const s of oldStops) { await deleteRemote("stops", s.id); }
    if (oldStops.length) DB.stops = DB.stops.filter((s) => !(s.deletedAt && s.deletedAt < cutoff));
    const oldDays = DB.days.filter((d) => d.deletedAt && d.deletedAt < cutoff && !DB.stops.some((s) => s.dayId === d.id));
    for (const d of oldDays) { await deleteRemote("days", d.id); }
    if (oldDays.length) DB.days = DB.days.filter((d) => !oldDays.includes(d));
    if (oldStops.length || oldDays.length) {
      // v17 : les entités purgées sortent aussi du suivi de synchro.
      oldStops.forEach((s) => { dirtyStops.delete(s.id); dirtyPhotoStops.delete(s.id); cleanStops.delete(s.id); cleanPhotos.delete(s.id); });
      oldDays.forEach((d) => { dirtyDays.delete(d.date); cleanDays.delete(d.date); });
      persistLocal();
      persistSyncMeta();
      refreshUnpushed();
    }
  }

  function uuidOk(v) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v || "");
  }

  function subscribeRealtime() {
    if (!supa) return;
    supa.channel("wl-live")
      .on("postgres_changes", { event: "*", schema: "public", table: "days" }, refreshRemote)
      .on("postgres_changes", { event: "*", schema: "public", table: "stops" }, refreshRemote)
      .on("postgres_changes", { event: "*", schema: "public", table: "photos" }, refreshRemote)
      .on("postgres_changes", { event: "*", schema: "public", table: "addresses" }, refreshRemote)
      .subscribe();
  }
  let refreshTimer = null;
  let remoteDefer = false;
  function refreshRemote() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(runRefreshRemote, 300);
  }
  async function runRefreshRemote() {
    // v9 : éditeur d'arrêt ouvert = rechargement REPORTÉ (la base
    // reconstruite écraserait les champs affichés à l'écran), et
    // rechargement sérialisé avec les poussées via enqueueOp.
    if (remoteDefer) { refreshTimer = setTimeout(runRefreshRemote, 1500); return; }
    const keepProfile = DB ? DB.profile : null;
    await enqueueOp(async () => {
      // v13 : pousser d'abord ce qui est en attente, sinon le
      // rechargement écrase les modifications pas encore rendues.
      if (unpushedChanges) await pushSupabaseNowInner();
      await reloadFromSupabase();
      DB.profile = keepProfile;
    });
    if (onRemoteChange) onRemoteChange();
  }

  async function deleteRemote(kind, id) {
    if (MODE !== "supabase" || !supa || !supaUser || !uuidOk(id)) return;
    try { await supa.from(kind).delete().eq("id", id); } catch (e) { /* id local seulement */ }
  }

  /* ================================================================
     EXPORT / RESTAURATION (un clic)
     ================================================================ */
  function exportObject() {
    return {
      app: "WL Livraison", version: 1, exportedAt: new Date().toISOString(),
      profile: DB.profile, days: DB.days, stops: DB.stops, photos: DB.photos
    };
  }
  function exportJSON() {
    return JSON.stringify(exportObject(), null, 2);
  }
  function importJSON(obj) {
    if (!obj || !Array.isArray(obj.days) || !Array.isArray(obj.stops)) {
      throw new Error("Fichier de sauvegarde invalide.");
    }
    // Copie de sécurité avant restauration : on ne perd jamais l'état actuel
    try { localStorage.setItem("wl_livraison_avant_restauration", JSON.stringify({ at: Date.now(), db: DB })); } catch (e) {}
    DB = {
      version: 1, profile: obj.profile || DB.profile, seeded: true,
      days: obj.days, stops: obj.stops, photos: obj.photos || {}
    };
    dedupeDays();
    // v17 : tout le contenu restauré est « sale » — il sera poussé
    // et vérifié comme du neuf.
    cleanDays.clear(); cleanStops.clear(); cleanPhotos.clear();
    recomputeDirty();
    persistLocal();
    persistSyncMeta();
    if (MODE === "supabase") { setSyncState("pending"); pushSupabaseNow(); }
  }

  /* ================================================================
     API publique utilisée par app.js
     ================================================================ */
  const Store = {
    mode: MODE,
    uid,
    async init(remoteCb) {
      onRemoteChange = remoteCb || null;
      if (MODE === "supabase") {
        loadLocal(); // cache local immédiat (affichage instantané + filet de sécurité)
        loadSyncMeta(); // v17 : ensembles « sales » + empreintes « propres » persistés
        recomputeDirty(); // filet : tout écart local/empreinte devient « sale »
        dedupeDays();
        dedupeStops();
        migratePhotosToStops();
        try {
          const signed = await initSupabase();
          if (signed) {
            subscribeRealtime();
            purgeTrash();
            // v16 : synchronisation initiale EN ARRIÈRE-PLAN —
            // l'écran s'affiche tout de suite depuis la copie
            // locale (avant, il attendait tout le rechargement
            // serveur : accueil figé 15-30 s). On pousse d'abord
            // la différence locale, puis on recharge ; l'écran se
            // rafraîchit via onRemoteChange quand c'est fait.
            enqueueOp(async () => {
              if (hasLocalDiff()) await pushSupabaseNowInner();
              await reloadFromSupabase();
              if (onRemoteChange) onRemoteChange();
            });
            return { needsAuth: false };
          }
          return { needsAuth: true };
        } catch (e) {
          console.warn("Supabase injoignable, mode local de secours.", e);
          setSyncState("error"); // v17 : jamais « ✓ Synchronisé » hors ligne
          return { needsAuth: false, offline: true };
        }
      }
      loadLocal();
      dedupeDays();
      dedupeStops();
      migratePhotosToStops();
      return { needsAuth: false };
    },
    signIn,
    get data() { return DB; },
    /* À appeler après CHAQUE modification : écriture immédiate. */
    save() {
      persistLocal();
      // v17 : chaque sauvegarde recalcule les ensembles « sales »
      // (empreintes) et les persiste AVANT de planifier la poussée —
      // une modification est donc suivie explicitement, jamais
      // déduite d'une comparaison rejouée plus tard.
      if (MODE === "supabase") { recomputeDirty(); persistSyncMeta(); setSyncState("pending"); pushSupabaseSoon(); }
    },
    saveNow() { // synchro immédiate (ex. avant de quitter l'écran)
      persistLocal();
      if (MODE === "supabase") { recomputeDirty(); persistSyncMeta(); setSyncState("pending"); pushSupabaseNow(); }
    },
    /* v16 : l'interface affiche l'état réel de la synchro. */
    setSyncListener(fn) { onSyncState = fn; if (fn) { try { fn(syncState); } catch (e) { /* affichage */ } } },
    get syncState() { return syncState; },
    async removeDay(id) { await deleteRemote("days", id); },
    async removeStop(id) { await deleteRemote("stops", id); },
    exportJSON,
    exportObject,
    importJSON,
    setProfile(name) { DB.profile = name; Store.save(); },
    /* v9 : l'éditeur d'arrêt signale son ouverture pour reporter les
       rechargements serveur jusqu'à sa fermeture. */
    setRemoteDefer(v) { remoteDefer = !!v; },
    snapshotsInfo() {
      try { return (JSON.parse(localStorage.getItem(LS_SNAPS) || "[]")).map((s) => s.date); }
      catch (e) { return []; }
    }
  };

  window.Store = Store;
})();
