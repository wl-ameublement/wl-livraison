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
    try { localStorage.setItem(LS_KEY, JSON.stringify(DB)); } catch (e) { warnQuota(e); }
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
      const k = [s.deletedAt ? "del" : "live", s.dayId, s.addressKey || "", s.client || "", s.appliance || "", s.phone || ""].join("|");
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
    loadShadow();
    // v16 : pousser d'abord ce que l'appareil a et que le serveur
    // n'a pas, puis recharger — jamais l'inverse.
    if (hasLocalDiff()) await pushSupabaseNowInner();
    await reloadFromSupabase();
    subscribeRealtime();
    return supaUser;
  }

  async function reloadFromSupabase() {
    const prevShadow = serverShadow; // v16 : ombre d'AVANT ce rechargement (pour la surcouche, plus bas)
    const [daysR, stopsR, photosR, profR, addrR] = await Promise.all([
      supa.from("days").select("*").order("date"),
      supa.from("stops").select("*").order("position"),
      supa.from("photos").select("id, stop_id, address_id, created_at"), // v15 : sans data_url (le volume) — voir plus bas
      supa.from("profiles").select("*"),
      supa.from("addresses").select("*") // v16 : en parallèle (avant : un aller-retour de plus en série)
    ]);
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
      fullPhotos = r.data || [];
    }
    if (legacyPhotoIds.length) {
      const r = await supa.from("photos").select("*").in("id", legacyPhotoIds);
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
    // v15 : ombre serveur = l'état tel que LU, avant les fusions
    // locales ci-dessous (qui, elles, représentent ce que la
    // prochaine poussée devra écrire).
    serverShadow = buildShadow(next.days, next.stops, next.photos, addrR.data || []);
    persistShadow();
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
        // v10 : une confirmation de trajet faite sur l'appareil
        // mais pas encore rendue au serveur (rechargement trop
        // rapide) reste confirmée — la confirmation est un geste
        // délibéré, elle ne se perd pas.
        if (l && l.status === "confirmed" && d.status !== "confirmed") d.status = "confirmed";
        // v11 : corbeille — l'état local gagne (voir plus bas).
        if (l && (l.deletedAt == null) !== (d.deletedAt == null)) d.deletedAt = l.deletedAt;
      });
      // v11 : pour la CORBEILLE (deletedAt), l'état LOCAL gagne
      // toujours sur le serveur, journées comme arrêts : une
      // suppression ou une restauration faite sur l'appareil mais
      // pas encore rendue au serveur (page rechargée trop vite,
      // poussée interrompue) ne doit pas être annulée par le
      // rechargement — cas vus au retest v10 : journée recréée
      // disparue, première restauration annulée. La poussée
      // suivante rend l'état local au serveur.
      const localStopById = {};
      (DB.stops || []).forEach((s) => { localStopById[s.id] = s; });
      next.stops.forEach((s) => {
        const l = localStopById[s.id];
        if (l && (l.deletedAt == null) !== (s.deletedAt == null)) s.deletedAt = l.deletedAt;
      });
    }
    // v10 : un arrêt dont la JOURNÉE est supprimée est supprimé
    // aussi, même si sa propre ligne serveur n'a pas encore son
    // deleted_at — cas vu au retest v9 : poussée de suppression
    // interrompue en plein vol (la journée partait, ses arrêts
    // non), puis recréation immédiate de la journée = les arrêts
    // « ressuscitaient ». La restauration depuis la corbeille
    // relève journée ET arrêts explicitement : pas touchée.
    // (Appliqué APRÈS la priorité locale v11, pour ne pas écraser
    // une restauration en cours.)
    const deletedDayById = {};
    next.days.forEach((d) => { if (d.deletedAt) deletedDayById[d.id] = d.deletedAt; });
    next.stops.forEach((s) => {
      if (!s.deletedAt && deletedDayById[s.dayId]) s.deletedAt = deletedDayById[s.dayId];
    });
    // v16 : SURCOUCHE DES MODIFICATIONS LOCALES NON POUSSÉES.
    // Une entité dont la forme locale diffère de l'ombre d'AVANT
    // ce rechargement (prevShadow) porte un changement jamais
    // rendu au serveur (poussée interrompue par un rechargement
    // de page, réseau coupé...) : sa forme locale gagne dans la
    // base fusionnée, et la poussée qui suit l'envoie. Une entité
    // locale ÉGALE à prevShadow était propre : le serveur gagne
    // (il a pu bouger depuis un autre appareil). C'est le
    // correctif central de la v16 — avant, TOUT rechargement
    // (y compris celui du démarrage) écrasait les modifications
    // locales pas encore poussées : positions optimisées,
    // téléphone, détails et suppressions perdus au rodage v15.
    if (DB && prevShadow) {
      const srvDayIdByDate = {};
      next.days.forEach((d) => { srvDayIdByDate[d.date] = d.id; });
      const addrIdByKey3 = {};
      (addrR.data || []).forEach((a) => { addrIdByKey3[a.address_key] = a.id; });
      let dirtyFound = false;
      (DB.days || []).forEach((ld) => {
        const nd = next.days.find((d) => d.date === ld.date);
        if (!nd) return; // inconnue du serveur : préservée plus haut
        if (prevShadow.days.get(ld.date) !== shadowDayJSON(ld)) {
          nd.status = ld.status; nd.optimized = ld.optimized; nd.deletedAt = ld.deletedAt;
          dirtyFound = true;
        }
      });
      (DB.stops || []).forEach((ls) => {
        const ns = next.stops.find((s) => s.id === ls.id);
        if (!ns) return; // inconnu du serveur : préservé plus haut
        const lDay = (DB.days || []).find((d) => d.id === ls.dayId);
        const srvDayId = (lDay && srvDayIdByDate[lDay.date]) || ns.dayId;
        const localJSON = stopShadowJSON(ls, srvDayId, addrIdByKey3[ls.addressKey] || null);
        if (prevShadow.stops.get(ls.id) !== localJSON) {
          const keepDayId = ns.dayId;
          Object.assign(ns, ls, { id: ns.id, dayId: keepDayId });
          delete ns._addressId;
          if (DB.photos && DB.photos[ls.id]) next.photos[ns.id] = DB.photos[ls.id].slice();
          dirtyFound = true;
        }
      });
      if (dirtyFound) unpushedChanges = true;
    }
    DB = next;
    dedupeDays();
    dedupeStops();
    // v16 : la copie locale reflète TOUJOURS la base fusionnée —
    // sinon, au prochain démarrage, une vieille copie locale
    // serait prise pour un changement local et écraserait le
    // serveur (le piège inverse).
    persistLocal();
    if (unpushedChanges) pushSupabaseSoon(); // envoyer la surcouche
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

  /* v15 : OMBRE SERVEUR + POUSSÉES DIFFÉRENTIELLES.
     Constat du diagnostic du 21 nov. (inspection directe des
     tables) : pas de journées en double au serveur, mais des
     corruptions d'état (statut « confirmé » et positions d'une
     journée revenus en arrière) causées par des instances de
     l'app restées ouvertes (anciens onglets/fenêtres) dont la
     mémoire était périmée : chaque poussée réécrivait TOUTE la
     base, donc un onglet périmé qui sauvegardait n'importe quoi
     écrasait les données fraîches du serveur. Correctif : on
     garde une « ombre » de l'état serveur connu (lue au
     rechargement, ou écrite par la dernière poussée réussie) et
     la poussée ne réécrit QUE les entités différentes de
     l'ombre. Un onglet périmé ne peut plus écraser ce qu'il n'a
     pas touché. */
  let serverShadow = null;
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
  function shadowDayJSON(d) {
    return JSON.stringify({ id: d.id, status: d.status, optimized: !!d.optimized, deleted_ms: d.deletedAt || null });
  }
  function stopShadowJSON(s, dayId, addressId) {
    const r = stopRowOf(s, dayId, addressId);
    r.deleted_at = s.deletedAt || null; // comparer en ms, pas en texte ISO (le format serveur diffère)
    return JSON.stringify(r);
  }
  function buildShadow(days, stops, photos, addrRows) {
    const sh = { days: new Map(), stops: new Map(), addrs: new Map(), addrIds: new Map(), photos: new Map() };
    const addrIdByKey = {};
    (addrRows || []).forEach((a) => {
      sh.addrs.set(a.address_key, addrCmpOf(a));
      sh.addrIds.set(a.address_key, a.id);
      addrIdByKey[a.address_key] = a.id;
    });
    (days || []).forEach((d) => { sh.days.set(d.date, shadowDayJSON(d)); });
    (stops || []).forEach((s) => { sh.stops.set(s.id, stopShadowJSON(s, s.dayId, addrIdByKey[s.addressKey] || null)); });
    Object.keys(photos || {}).forEach((sid) => {
      sh.photos.set(sid, new Set((photos[sid] || []).map((p) => p.dataUrl)));
    });
    return sh;
  }
  function rebuildShadowFromDB(dayIdByDate) {
    // Après une poussée réussie : l'ombre devient l'état qu'on
    // vient d'écrire (identifiants serveur résolus).
    const addrRows = [];
    const seen = {};
    DB.stops.forEach((s) => {
      if (s.addressKey && !seen[s.addressKey]) { seen[s.addressKey] = true; addrRows.push(Object.assign(addrRowOf(s), { id: s._addressId || null })); }
    });
    const daysAsServer = DB.days.map((d) => Object.assign({}, d, { id: dayIdByDate[d.date] || d.id }));
    const stopsAsServer = DB.stops.map((s) => {
      const day = DB.days.find((x) => x.id === s.dayId);
      const copy = Object.assign({}, s);
      if (day && dayIdByDate[day.date]) copy.dayId = dayIdByDate[day.date];
      return copy;
    });
    serverShadow = buildShadow(daysAsServer, stopsAsServer, DB.photos, addrRows);
    persistShadow();
  }

  /* v16 : l'ombre est PERSISTÉE (localStorage) avec la base. Sans
     ça, elle mourait à chaque fermeture de page : au redémarrage,
     impossible de savoir ce qui n'avait jamais été rendu au
     serveur, et le rechargement initial écrasait les modifications
     locales pas encore poussées (pertes vues au rodage v15 :
     positions optimisées, téléphone, détails, corbeille). Avec
     l'ombre persistée, le démarrage pousse d'abord la différence
     locale, et la fusion au rechargement garde la forme locale de
     toute entité qui diffère de l'ombre (voir plus bas). */
  const LS_SHADOW = "wl_livraison_shadow_v1";
  function persistShadow() {
    if (!serverShadow) return;
    try {
      localStorage.setItem(LS_SHADOW, JSON.stringify({
        days: [...serverShadow.days], stops: [...serverShadow.stops],
        addrs: [...serverShadow.addrs], addrIds: [...serverShadow.addrIds],
        photos: [...serverShadow.photos].map(([k, v]) => [k, [...v]])
      }));
    } catch (e) { /* l'ombre en mémoire suffit pour la session */ }
  }
  function loadShadow() {
    try {
      const raw = localStorage.getItem(LS_SHADOW);
      if (!raw) { serverShadow = null; return; }
      const o = JSON.parse(raw);
      serverShadow = {
        days: new Map(o.days || []), stops: new Map(o.stops || []),
        addrs: new Map(o.addrs || []), addrIds: new Map(o.addrIds || []),
        photos: new Map((o.photos || []).map(([k, v]) => [k, new Set(v)]))
      };
    } catch (e) { serverShadow = null; }
  }
  function dayDiffers(ld) {
    if (!serverShadow) return true;
    return serverShadow.days.get(ld.date) !== shadowDayJSON(ld);
  }
  function stopDiffers(ls) {
    if (!serverShadow) return true;
    const addrId = serverShadow.addrIds.get(ls.addressKey) || null;
    return serverShadow.stops.get(ls.id) !== stopShadowJSON(ls, ls.dayId, addrId);
  }
  function hasLocalDiff() {
    if (!DB) return false;
    if (!serverShadow) return (DB.days.length + DB.stops.length) > 0;
    return DB.days.some(dayDiffers) || DB.stops.some(stopDiffers);
  }

  /* v16 : état de synchronisation VISIBLE. Avant, l'indicateur
     « ✓ Enregistré » ne parlait que de l'écriture sur l'appareil,
     même quand le serveur n'avait rien reçu — l'utilisateur
     croyait ses données en sécurité alors qu'elles ne l'étaient
     pas. Maintenant : pending = poussée en cours, error = le
     serveur n'a pas confirmé (nouvel essai automatique), ok =
     le serveur a tout reçu. */
  let syncState = "ok";
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
    if (!supa || !supaUser) { unpushedChanges = false; return; }
    setSyncState("pending");
    try {
      // Adresses d'abord (les arrêts y font référence)
      const addrKeys = {};
      for (const s of DB.stops) {
        if (!s.addressKey) continue;
        if (!addrKeys[s.addressKey]) {
          const row = addrRowOf(s);
          // v15 : adresse inchangée depuis l'ombre → réutiliser
          // son identifiant serveur sans réécrire.
          if (serverShadow && serverShadow.addrs.get(s.addressKey) === addrCmpOf(row) && serverShadow.addrIds.get(s.addressKey)) {
            addrKeys[s.addressKey] = serverShadow.addrIds.get(s.addressKey);
          } else {
            const res = await supa.from("addresses").upsert(row, { onConflict: "address_key" }).select("id,address_key").single();
            throwIfError("Adresse", res);
            if (res.data) addrKeys[s.addressKey] = res.data.id;
          }
        }
        s._addressId = addrKeys[s.addressKey];
      }
      // v10 : les SUPPRESSIONS d'abord — si la poussée est
      // interrompue en plein vol (page fermée ou rechargée juste
      // après une suppression), l'état serveur reste cohérent :
      // journées et arrêts supprimés partent en premier.
      // v16 : erreurs VÉRIFIÉES ici aussi (avant, un échec silencieux
      // laissait croire que la suppression était rendue au serveur).
      {
        const daysPreRes = await supa.from("days").select("id,date");
        throwIfError("Suppressions (lecture des journées)", daysPreRes);
        const preByDate = {};
        (daysPreRes.data || []).forEach((d) => { preByDate[d.date] = d.id; });
        for (const d of DB.days) {
          if (!d.deletedAt || !preByDate[d.date]) continue;
          throwIfError("Suppression de journée", await supa.from("days").upsert({
            id: preByDate[d.date], date: d.date,
            deleted_at: new Date(d.deletedAt).toISOString()
          }, { onConflict: "date" }));
        }
        const delStops = [];
        for (const s of DB.stops) {
          if (!s.deletedAt || !uuidOk(s.id)) continue;
          // v16 : seulement les arrêts CONNUS du serveur (dans
          // l'ombre) — l'upsert partiel ci-dessous met à jour une
          // ligne existante ; pour un arrêt créé puis supprimé
          // avant sa première poussée, il tenterait une insertion
          // incomplète (colonnes obligatoires manquantes) et
          // ferait échouer toute la poussée. Ceux-là partent en
          // ligne complète dans la boucle principale, plus bas.
          if (!serverShadow || !serverShadow.stops.has(s.id)) continue;
          const sDay = DB.days.find((x) => x.id === s.dayId);
          if (!sDay || !preByDate[sDay.date]) continue;
          delStops.push({ id: s.id, day_id: preByDate[sDay.date], deleted_at: new Date(s.deletedAt).toISOString() });
        }
        if (delStops.length) throwIfError("Suppression d'arrêts", await supa.from("stops").upsert(delStops, { onConflict: "id" }));
      }

      // v15 : ne réécrire que les journées différentes de l'ombre.
      // v16 : en un seul lot.
      const dayRows = [];
      for (const d of DB.days) {
        if (serverShadow && serverShadow.days.get(d.date) === shadowDayJSON(d)) continue;
        dayRows.push(dayRowOf(d));
      }
      if (dayRows.length) throwIfError("Journées", await supa.from("days").upsert(dayRows, { onConflict: "date" }));
      const dayIdByDate = {};
      const daysNowRes = await supa.from("days").select("id,date");
      throwIfError("Lecture des journées", daysNowRes);
      const daysNow = daysNowRes.data || [];
      daysNow.forEach((d) => { dayIdByDate[d.date] = d.id; });
      // v16 : les arrêts partent en LOT (un aller-retour par tranche
      // de 50) avec erreurs vérifiées. Avant : un aller-retour PAR
      // arrêt, erreurs jamais lues — une poussée pouvait prendre
      // des dizaines de secondes ET échouer en silence, puis
      // l'ombre (v15) marquait quand même les arrêts comme rendus.
      const stopRows = [];
      for (const s of DB.stops) {
        const day = DB.days.find((x) => x.id === s.dayId);
        if (!day || !dayIdByDate[day.date]) continue;
        const row = stopRowOf(s, dayIdByDate[day.date], s._addressId || null);
        if (uuidOk(s.id)) {
          // v15 : ne réécrire que les arrêts différents de l'ombre.
          if (serverShadow && serverShadow.stops.get(s.id) === stopShadowJSON(s, dayIdByDate[day.date], s._addressId || null)) continue;
          stopRows.push(Object.assign({ id: s.id }, row));
        } else {
          // v8 : ancien identifiant local — insertion UNE fois, puis
          // adoption de l'identifiant serveur retourné. Avant, chaque
          // poussée insérait une nouvelle copie de l'arrêt au serveur.
          const res = await supa.from("stops").insert(row).select("id").single();
          throwIfError("Arrêt (insertion)", res);
          if (res.data && res.data.id) adoptStopId(s, res.data.id);
        }
      }
      for (let i = 0; i < stopRows.length; i += 50) {
        throwIfError("Arrêts", await supa.from("stops").upsert(stopRows.slice(i, i + 50), { onConflict: "id" }));
      }
      persistLocal(); // garder les identifiants serveur adoptés
      // Photos : rattachées à l'ARRÊT (photos des appareils, pour le
      // chargement). Réconciliation par empreinte (data_url) avec le
      // serveur : envoi des nouvelles, adoption des identifiants
      // serveur, suppression de celles retirées sur l'appareil. Avant
      // v7, les photos n'étaient JAMAIS envoyées au serveur — elles
      // vivaient seulement sur le téléphone et un rechargement les
      // effaçait (bug vu par William le 20 nov. 2026).
      {
        const srvStopsRes = await supa.from("stops").select("id,day_id,position,address_id");
        throwIfError("Photos (lecture des arrêts serveur)", srvStopsRes);
        const srvStops = srvStopsRes.data || [];
        const srvStopByKey = {};
        const srvStopById = {};
        srvStops.forEach((ss) => {
          srvStopById[ss.id] = ss;
          const d = daysNow.find((x) => x.id === ss.day_id);
          if (d) srvStopByKey[d.date + "|" + (ss.position || 0)] = ss;
        });
        // v15 : ne réconcilier les photos que des arrêts dont
        // l'ensemble d'URLs diffère de l'ombre (ou dont l'arrêt
        // local n'a pas encore d'identifiant serveur) — en régime
        // courant, aucune requête photo du tout.
        const photoStopIds = [];
        for (const s of DB.stops) {
          if (s.deletedAt) continue;
          const day = DB.days.find((x) => x.id === s.dayId);
          if (!day) continue;
          const ss = srvStopById[s.id] || srvStopByKey[day.date + "|" + (s.position || 0)];
          if (!ss) continue;
          if (!uuidOk(s.id)) { photoStopIds.push(ss.id); continue; }
          const localUrls = new Set((DB.photos[s.id] || []).map((p) => p.dataUrl));
          const shUrls = serverShadow ? serverShadow.photos.get(ss.id) : null;
          if (shUrls && shUrls.size === localUrls.size && [...localUrls].every((u) => shUrls.has(u))) continue;
          photoStopIds.push(ss.id);
        }
        const srvPhotosRes = photoStopIds.length
          ? await supa.from("photos").select("id,stop_id,data_url").in("stop_id", photoStopIds)
          : { data: [] };
        throwIfError("Photos (lecture serveur)", srvPhotosRes);
        const srvPhotos = srvPhotosRes.data || [];
        const srvByStop = {};
        (srvPhotos || []).forEach((p) => {
          if (!p.stop_id) return;
          (srvByStop[p.stop_id] = srvByStop[p.stop_id] || []).push(p);
        });
        for (const s of DB.stops) {
          if (s.deletedAt) continue;
          const day = DB.days.find((x) => x.id === s.dayId);
          if (!day) continue;
          // v8 : correspondance par identifiant d'abord (fiable), repli
          // sur date+position pour les anciens arrêts — avec adoption.
          let ss = srvStopById[s.id] || srvStopByKey[day.date + "|" + (s.position || 0)];
          if (!ss) continue;
          if (photoStopIds.indexOf(ss.id) === -1) continue; // v15 : photos inchangées
          if (!uuidOk(s.id)) adoptStopId(s, ss.id);
          const local = DB.photos[s.id] || [];
          const srv = srvByStop[ss.id] || [];
          const srvUrls = new Set(srv.map((p) => p.data_url));
          for (const p of local) {
            if (srvUrls.has(p.dataUrl)) {
              const sp = srv.find((x) => x.data_url === p.dataUrl);
              if (sp && p.id !== sp.id) p.id = sp.id; // adopter l'identifiant serveur
              continue;
            }
            const insRes = await supa.from("photos").insert({
              stop_id: ss.id, address_id: ss.address_id || s._addressId || null, data_url: p.dataUrl
            }).select("id").single();
            throwIfError("Photo (envoi)", insRes);
            if (insRes.data) { p.id = insRes.data.id; srvUrls.add(p.dataUrl); }
          }
          const localUrls = new Set(local.map((p) => p.dataUrl));
          for (const p of srv) {
            if (!localUrls.has(p.data_url)) throwIfError("Photo (suppression)", await supa.from("photos").delete().eq("id", p.id));
          }
        }
        persistLocal(); // garder les identifiants serveur adoptés
      }
      // v16 : on n'arrive ici que si TOUTES les écritures ont été
      // confirmées par le serveur (chaque réponse est vérifiée) —
      // seulement là, l'ombre peut avancer et l'état passer à « ok ».
      rebuildShadowFromDB(dayIdByDate);
      unpushedChanges = false; // v13 : tout est rendu au serveur
      setSyncState("ok");
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
    if (oldStops.length || oldDays.length) persistLocal();
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
    persistLocal();
    if (MODE === "supabase") pushSupabaseNow();
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
        loadShadow(); // v16 : ombre persistée — savoir ce que le serveur n'a pas encore
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
      if (MODE === "supabase") { unpushedChanges = true; setSyncState("pending"); pushSupabaseSoon(); }
    },
    saveNow() { // synchro immédiate (ex. avant de quitter l'écran)
      persistLocal();
      if (MODE === "supabase") { unpushedChanges = true; setSyncState("pending"); pushSupabaseNow(); }
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
