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
    const writeLight = () => {
      const light = Object.assign({}, DB, { photos: {} });
      Object.keys(DB.photos || {}).forEach((sid) => {
        if (dirtyPhotoStops.has(sid)) light.photos[sid] = DB.photos[sid];
      });
      localStorage.setItem(LS_KEY, JSON.stringify(light));
    };
    /* v23 (échelle) : si les photos dépassent à elles seules la
       capacité locale plausible, la tentative d'écriture complète
       est vouée au quota — et sa sérialisation (~405 Mo au volume
       réel) coûte des secondes à CHAQUE sauvegarde. On écrit alors
       directement la copie allégée : même état final que le repli
       v17, même avis de stockage. */
    let photoChars = 0;
    try {
      Object.keys(DB.photos || {}).forEach((sid) => {
        (DB.photos[sid] || []).forEach((p) => { photoChars += (p.dataUrl || "").length; });
      });
    } catch (e) { photoChars = 0; }
    if (photoChars > 4500000) {
      try { writeLight(); } catch (e2) { /* même allégée, ça ne rentre pas : le serveur et les ensembles sales persistés prennent le relais */ }
      warnQuota();
    } else {
      try { localStorage.setItem(LS_KEY, JSON.stringify(DB)); } catch (e) {
        // v17 : si le stockage est plein, réessayer SANS les photos
        // déjà confirmées par le serveur (elles y sont en sécurité) —
        // seules les photos « sales » (pas encore rendues) restent sur
        // l'appareil. Avant, l'échec était silencieux et la copie
        // locale restait figée à un vieil état.
        try { writeLight(); } catch (e2) { /* même allégée, ça ne rentre pas : le serveur et les ensembles sales persistés prennent le relais */ }
        warnQuota(e);
      }
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
    /* v23 (échelle) : au-delà du seuil de persistLocal, le clone
       profond complet est voué au repli « sans photos » de toute
       façon — on construit directement cet état final, sans payer
       la sérialisation du volume entier une fois par jour. */
    let snapPhotoChars = 0;
    try {
      Object.keys(DB.photos || {}).forEach((sid) => {
        (DB.photos[sid] || []).forEach((p) => { snapPhotoChars += (p.dataUrl || "").length; });
      });
    } catch (e) { snapPhotoChars = 0; }
    const snap = snapPhotoChars > 4500000
      ? { date: today, at: Date.now(), db: Object.assign({}, DB, { photos: {} }), sansPhotos: true }
      : { date: today, at: Date.now(), db: JSON.parse(JSON.stringify(DB)) };
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
     client, aucun appareil) ne sont jamais fusionnés.
     v18 : PÉRIMÈTRE RÉDUIT — voir la règle dure dans la fonction :
     seuls les résidus à ancien identifiant local (non-UUID) sont
     encore fusionnés ; un arrêt UUID n'est jamais retiré ici. */
  function dedupeStops() {
    if (!DB || !Array.isArray(DB.stops)) return;
    const seen = {};
    const dropped = new Set();
    const score = (s) => (uuidOk(s.id) ? 2 : 0) + ((DB.photos[s.id] || []).length ? 1 : 0);
    const movePhotos = (fromStop, toStop) => {
      const from = DB.photos[fromStop.id] || [];
      if (!from.length) return;
      const target = DB.photos[toStop.id] || (DB.photos[toStop.id] = []);
      const urls = new Set(target.map((p) => p.dataUrl));
      from.forEach((p) => { if (!urls.has(p.dataUrl)) { target.push(p); urls.add(p.dataUrl); } });
      delete DB.photos[fromStop.id];
    };
    [...DB.stops].sort((a, b) => score(b) - score(a)).forEach((s) => {
      if (!(s.addressKey || s.client || s.appliance)) return;
      // v9 : les copies SUPPRIMÉES sont fusionnées aussi (groupe à
      // part) — avant, elles s'accumulaient dans la corbeille à
      // chaque cycle suppression/restauration.
      // v18 : RÈGLE DURE — un arrêt à identifiant UUID n'est JAMAIS
      // fusionné ni retiré ici, et plus RIEN n'est effacé au serveur
      // depuis cette fonction. Le rodage v17 l'a prouvé deux fois :
      // une copie DÉLIBÉRÉE (bouton « Dupliquer ») partage la
      // position de son original (app.js la copie telle quelle) et,
      // tant que la journée n'est pas optimisée, son eta est aussi
      // vide des deux côtés — la clé devenait IDENTIQUE à celle de
      // l'original, la copie était fusionnée puis EFFACÉE AU
      // SERVEUR au rechargement suivant, y compris par le
      // rechargement d'un AUTRE onglet/appareil qui ne la
      // connaissait pas. Or le contenu seul ne distingue PAS une
      // duplication délibérée d'un clone fantôme de l'ancien bug :
      // entre un doublon affiché et une donnée perdue, la donnée
      // gagne. La multiplication fantôme d'origine (identifiants
      // locaux non-UUID réinsérés à chaque poussée) est morte
      // depuis la v8 (UUID + adoption d'id) ; ne sont donc encore
      // fusionnés que les résidus à ANCIEN identifiant local, dans
      // un jumeau gardé — jamais l'inverse, jamais au serveur.
      const k = [s.deletedAt ? "del" : "live", s.dayId, s.position || 0, s.eta == null ? "" : s.eta, s.addressKey || "", s.client || "", s.appliance || "", s.phone || ""].join("|");
      const prev = seen[k];
      if (!prev) { seen[k] = s; return; }
      if (uuidOk(s.id)) {
        if (!uuidOk(prev.id)) { // le gardé était un résidu local : le vrai (UUID) prend sa place
          movePhotos(prev, s);
          dropped.add(prev.id);
          seen[k] = s;
        }
        return; // deux copies UUID : on garde les deux, toujours
      }
      movePhotos(s, prev);
      dropped.add(s.id);
    });
    if (dropped.size) {
      // v18 : aucun effacement distant ici — les seuls ids retirés
      // sont des résidus locaux (non-UUID) qui n'existent pas au
      // serveur ; leurs photos vivent sur la copie gardée.
      // v17 : les ids retirés sortent aussi du suivi de synchro.
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

  /* v22 : LECTURES PAGINÉES — PostgREST plafonne chaque réponse
     (db-max-rows, 1000 par défaut chez Supabase) : une lecture
     sans range() est TRONQUÉE en silence au-delà de la limite.
     Prouvé par run28 (P3) : la lecture des identifiants photos
     du rechargement, tronquée à 1000 lignes, faisait croire à
     un seau serveur vide pour l'arrêt dont la photo était la
     1006e ligne ; refreshCleanFromDB effaçait alors son
     empreinte propre, la photo devenait invisible — et dès
     l'ajout d'une autre photo, la réconciliation par arrêt
     EFFAÇAIT l'originale du serveur pour de bon. On lit donc
     par pages de 1000 (range) jusqu'à une page courte, pour
     toutes les lectures en bloc : journées, arrêts, adresses,
     identifiants photos et téléchargements de photos. */
  const READ_PAGE = 1000;
  async function selectAllPages(build) {
    const all = [];
    for (let from = 0; ; from += READ_PAGE) {
      const r = await build(from, from + READ_PAGE - 1);
      if (r.error) return { data: null, error: r.error };
      const rows = r.data || [];
      for (const row of rows) all.push(row);
      if (rows.length < READ_PAGE) return { data: all, error: null };
    }
  }

  async function reloadFromSupabase() {
    // v20 : pendant toute la fusion, merging = true — les
    // suppressions qui apparaissent dans la base fusionnée ne
    // sont pas des gestes de l'utilisateur (garde-fou corbeille).
    merging = true;
    // v20 : photo des ensembles « sales » d'AVANT la fusion —
    // refreshCleanFromDB s'en sert pour distinguer une vraie
    // modification locale en attente d'une entité simplement
    // jamais marquée propre (voir son commentaire).
    const preDirty = { days: new Set(dirtyDays), stops: new Set(dirtyStops), photos: new Set(dirtyPhotoStops) };
    const [daysR, stopsR, photosR, profR, addrR] = await Promise.all([
      selectAllPages((a, b) => supa.from("days").select("*").order("date").range(a, b)), // v22 : paginé (limite PostgREST)
      selectAllPages((a, b) => supa.from("stops").select("*").order("position").range(a, b)), // v22 : paginé
      selectAllPages((a, b) => supa.from("photos").select("id, stop_id, address_id, created_at").range(a, b)), // v15 : sans data_url (le volume) — voir plus bas ; v22 : paginé
      supa.from("profiles").select("*"),
      selectAllPages((a, b) => supa.from("addresses").select("*").range(a, b)) // v16 : en parallèle (avant : un aller-retour de plus en série) ; v22 : paginé
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
      merging = false;
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
    // v24 : téléchargement par PETITS LOTS d'arrêts (8 à la fois).
    // Avant, UNE requête .in() géante partait pour tous les arrêts
    // changés : la moindre erreur avortait TOUT le rechargement et
    // l'app restait sur la copie allégée (0 photo affichée le
    // 23 nov. alors que le serveur les détenait). Un lot en échec
    // est désormais ISOLÉ : ses arrêts gardent leur seau local
    // (jamais un seau « vide » par erreur), ne sont pas certifiés
    // propres (empreinte sentinelle plus bas) et une relance du
    // rechargement est programmée en fin de fonction.
    const photoDlFailed = new Set();
    for (let i = 0; i < changedStopIds.length; i += 8) {
      const batch = changedStopIds.slice(i, i + 8);
      const r = await selectAllPages((a, b) => supa.from("photos").select("*").in("stop_id", batch).range(a, b)); // v22 : paginé
      if (r.error) {
        console.warn("Rechargement : lot de photos illisible — seaux locaux conservés, relance programmée.", r.error);
        batch.forEach((sid) => photoDlFailed.add(sid));
        continue;
      }
      fullPhotos = fullPhotos.concat(r.data || []);
    }
    for (let i = 0; i < legacyPhotoIds.length; i += 200) {
      const batch = legacyPhotoIds.slice(i, i + 200);
      const r = await selectAllPages((a, b) => supa.from("photos").select("*").in("id", batch).range(a, b)); // v22 : paginé
      if (r.error) {
        // Rattachement purement additif : sauter un lot ne peut
        // vider aucun seau ; les photos héritées manquées se
        // rattacheront au prochain rechargement réussi.
        console.warn("Rechargement : lot de photos héritées illisible — rattachement reporté.", r.error);
        photoDlFailed.add("__legacy__");
        continue;
      }
      fullPhotos = fullPhotos.concat(r.data || []);
    }
    next.stops.forEach((s) => {
      // v24 : un arrêt dont le lot a échoué conserve son seau local,
      // exactement comme un arrêt inchangé.
      const keepLocal = changedStopIds.indexOf(s.id) === -1 || photoDlFailed.has(s.id);
      if (keepLocal && localPhotos[s.id] && (srvPhotoIdsByStop[s.id] || []).length) {
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
    // v23 : empreintes du contenu TEL QUE LU du serveur, avant
    // toute surcouche locale (préservation, rattachement de
    // photos, propagation de suppression de journée, surcouche
    // des entités « sales »). refreshCleanFromDB ne certifiera
    // « propre » que ce qui est resté IDENTIQUE à cette lecture :
    // une modification locale arrivée PENDANT le rechargement
    // (invisible dans preDirty, photographié au départ) ne doit
    // jamais être crue confirmée par le serveur — voir son
    // commentaire (perte silencieuse prouvée par run26a).
    const srvDayFPs = new Map(next.days.map((d) => [d.date, dayFP(d)]));
    const srvDateByDayId2 = {};
    next.days.forEach((d) => { srvDateByDayId2[d.id] = d.date; });
    const srvStopFPs = new Map(next.stops.map((s) => {
      const r = stopRowOf(s, srvDateByDayId2[s.dayId] || s.dayId, null);
      r.day_id = srvDateByDayId2[s.dayId] || s.dayId || null;
      r.address_id = s.addressKey || null;
      r.deleted_at = s.deletedAt || null;
      return [s.id, JSON.stringify(r)];
    }));
    const srvPhotoFPs = new Map(next.stops.map((s) => [s.id, photoFP(next.photos[s.id])]));
    // v24 : les arrêts dont le lot de téléchargement a échoué
    // reçoivent une empreinte serveur SENTINELLE — impossible à
    // confondre avec une vraie empreinte : refreshCleanFromDB ne
    // les certifiera pas « propres » (leur contenu serveur reste
    // non vérifié jusqu'au rechargement de relance).
    photoDlFailed.forEach((sid) => { if (srvPhotoFPs.has(sid)) srvPhotoFPs.set(sid, "__dl_failed__"); });
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
        // v18 : MAIS seulement pour les anciens identifiants LOCAUX
        // (non-UUID) — le seul cas où un jumeau serveur peut exister
        // sous un autre id (adoption d'id de l'ère pré-v8). Un arrêt
        // à id UUID inconnu du serveur est une création locale pas
        // encore poussée : le rodage v17 a montré qu'une DUPLICATION
        // faite pendant les lectures d'un rechargement en vol était
        // écartée ici (elle « ressemble » à son original par
        // construction), puis son entrée « sale » était effacée en
        // silence par la poussée suivante — copie perdue, « ✓
        // Synchronisé » affiché. Règle v18 : un UUID local n'est
        // JAMAIS écarté pour ressemblance ; la poussée le créera.
        if (!uuidOk(s.id)) {
          const dup = next.stops.some((x) => x.dayId === target.id &&
            x.addressKey === s.addressKey && x.client === s.client &&
            x.appliance === s.appliance && x.phone === s.phone);
          if (dup) return;
        }
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
    refreshCleanFromDB(srvDayDateSet, srvStopIdSet, preDirty, { days: srvDayFPs, stops: srvStopFPs, photos: srvPhotoFPs });
    // La copie locale reflète TOUJOURS la base fusionnée — sinon,
    // au prochain démarrage, une vieille copie locale serait prise
    // pour un changement local et écraserait le serveur.
    persistLocal();
    persistSyncMeta();
    // v20 : fin de fusion — les cartes corbeille « connues » sont
    // reconstruites depuis la base fusionnée (sans rien marquer
    // d'explicite), puis seulement les gestes utilisateur comptent.
    merging = false;
    refreshKnownDeleted();
    refreshUnpushed();
    if (actionableCount() > 0) { setSyncState("pending"); pushSupabaseSoon(); } // envoyer la surcouche
    else if (quarantineCount() > 0) setSyncState("error"); // v20 : quarantaine = erreur visible, jamais « ✓ Synchronisé »
    else setSyncState("ok");
    // v24 : des lots de photos n'ont pas pu être lus — ne jamais
    // laisser « ✓ Synchronisé » : erreur visible par-dessus l'état
    // ci-dessus et rechargement retenté automatiquement (les
    // seaux concernés sont conservés en local, rien n'est perdu
    // ni certifié à tort).
    if (photoDlFailed.size) {
      setSyncState("error");
      clearTimeout(reloadRetryTimer);
      reloadRetryTimer = setTimeout(() => { refreshRemote(); }, 5000);
    }
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
  const _hashMemo = new Map(); // v23 : mémo cyrb53 — fonction pure de la chaîne, valeurs inchangées
  function hashStr(str) { // cyrb53 — empreinte courte d'une photo (jamais le base64 lui-même)
    /* v23 (échelle) : sans mémo, CHAQUE recomputeDirty() — donc
       chaque sauvegarde — rehachait TOUTES les photos (~405 Mo de
       dataURL au volume réel de 2 700 arrêts) : démarrage à froid
       et sauvegardes gelaient proportionnellement au volume total.
       La mémo (clé = la chaîne elle-même, immuable) rend les
       rehachages d'une photo inchangée quasi gratuits ; le premier
       hachage de chaque photo reste payé une seule fois. */
    if (str && str.length > 4096) {
      const hit = _hashMemo.get(str);
      if (hit !== undefined) return hit;
    }
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (let i = 0; i < str.length; i++) {
      const ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    const out = (h2 >>> 0).toString(16) + (h1 >>> 0).toString(16) + ":" + str.length;
    if (str && str.length > 4096) _hashMemo.set(str, out); // v23
    return out;
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
  let freshnessExempt = false; // v23 : posé par importJSON (restauration volontaire) — le garde-fou fraîcheur laisse alors tout passer, un seul cycle
  let dirtyDays = new Set(), dirtyStops = new Set(), dirtyPhotoStops = new Set();
  /* v20 : ISOLATION DES ERREURS + QUARANTAINE (état persisté).
     En v17-v19, la poussée était UN bloc try/catch : la première
     écriture qui échouait (ou dont la vérification différait)
     levait une exception qui annulait TOUT le cycle — l'étape qui
     retire les entités confirmées des ensembles « sales » ne
     tournait pas, donc même les entités saines restaient « sales »,
     et le cycle suivant réessayait tout et rééchouait au même
     endroit : la synchro ne se terminait JAMAIS (test de charge
     v19 : ~25 min, 8 rechargements, jamais « ✓ Synchronisé »).
     En v20, chaque entité est isolée : son échec est compté ici,
     et après QUARANTINE_AFTER échecs elle est mise en QUARANTAINE
     (persistée) — exclue des poussées, le reste de la synchro se
     termine, et l'état reste « error » (visible) tant qu'il reste
     une entité en quarantaine. Sortie de quarantaine : l'entité
     est MODIFIÉE (empreinte différente), le délai QUARANTINE_MS
     s'écoule, ou saveNow() la retente (compteur conservé : un
     échec la remet en quarantaine immédiatement, sans boucle). */
  const QUARANTINE_AFTER = 5;
  const QUARANTINE_MS = 15 * 60 * 1000;
  let failCounts = { days: {}, stops: {}, photos: {} };
  let quarantine = { days: {}, stops: {}, photos: {} }; // clé -> { fp, at }
  /* v20 : GARDE-FOU CORBEILLE — arrêts (par id) et journées (par
     date) dont la suppression a été EXPLICITEMENT demandée par
     l'utilisateur : transition vivant -> corbeille observée dans
     recomputeDirty() HORS fusion de rechargement (voir
     noteTrashTransitions). Persisté : une suppression demandée
     juste avant un rechargement reste légitime après. La poussée
     refuse toute autre suppression (voir pushCycleLocked). */
  let explicitTrashStops = new Set(), explicitTrashDays = new Set();
  /* v20 : dernier état corbeille CONNU de chaque entité — sert à
     détecter les transitions explicites. Reconstruit après chaque
     rechargement : ce qu'une fusion y a mis n'est jamais tenu
     pour un geste de l'utilisateur. */
  let knownDeletedStops = new Map(), knownDeletedDays = new Map();
  // v21 : arrêts dont les photos sont INCONNUES de cette session.
  // Calculé à l'init (voir Store.init) : l'empreinte « propre »
  // prouve que le serveur détient des photos, mais le seau local
  // est vide — la copie locale chargée était ALLÉGÉE (quota :
  // persistLocal n'y garde que les photos des arrêts « sales »).
  // Pour ces arrêts, un seau vide ne vaut JAMAIS suppression
  // (recomputeDirty) et la phase photos réimporte d'abord les
  // photos du serveur (pushCycleLocked). Le drapeau tombe dès
  // qu'un rechargement relit l'arrêt du serveur
  // (refreshCleanFromDB) ou que la phase photos l'a complété.
  let photoUnknownStops = new Set();
  let merging = false; // vrai pendant reloadFromSupabase()
  function persistSyncMeta() {
    try {
      localStorage.setItem(LS_SYNC, JSON.stringify({
        cleanDays: [...cleanDays], cleanStops: [...cleanStops], cleanPhotos: [...cleanPhotos],
        dirtyDays: [...dirtyDays], dirtyStops: [...dirtyStops], dirtyPhotoStops: [...dirtyPhotoStops],
        failCounts, quarantine,
        explicitTrashStops: [...explicitTrashStops], explicitTrashDays: [...explicitTrashDays]
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
        failCounts = o.failCounts || { days: {}, stops: {}, photos: {} };
        quarantine = o.quarantine || { days: {}, stops: {}, photos: {} };
        explicitTrashStops = new Set(o.explicitTrashStops || []);
        explicitTrashDays = new Set(o.explicitTrashDays || []);
        return;
      }
    } catch (e) { /* première fois */ }
    cleanDays = new Map(); cleanStops = new Map(); cleanPhotos = new Map();
    dirtyDays = new Set(); dirtyStops = new Set(); dirtyPhotoStops = new Set();
    failCounts = { days: {}, stops: {}, photos: {} };
    quarantine = { days: {}, stops: {}, photos: {} };
    explicitTrashStops = new Set(); explicitTrashDays = new Set();
  }
  function refreshUnpushed() {
    unpushedChanges = dirtyDays.size + dirtyStops.size + dirtyPhotoStops.size > 0;
  }
  /* v20 : empreinte courante d'une entité suivie (pour la
     quarantaine : comparer l'empreinte au moment de la mise de
     côté à celle d'aujourd'hui). null = entité disparue. */
  function currentFP(kind, key) {
    if (!DB) return null;
    if (kind === "days") { const d = (DB.days || []).find((x) => x.date === key); return d ? dayFP(d) : null; }
    if (kind === "stops") { const s = (DB.stops || []).find((x) => x.id === key); return s ? stopFP(s) : null; }
    const s = (DB.stops || []).find((x) => x.id === key);
    return s ? photoFP((DB.photos || {})[key]) : null;
  }
  /* v20 : sortie de quarantaine — entité disparue, MODIFIÉE
     depuis sa mise de côté (empreinte différente), ou délai
     écoulé. La sortie rend des chances fraîches (compteur à zéro)
     et recomputeDirty() remettra l'entité dans les ensembles
     « sales » si son empreinte diffère de l'empreinte propre. */
  function releaseQuarantine() {
    if (!DB) return;
    const now = Date.now();
    ["days", "stops", "photos"].forEach((kind) => {
      Object.keys(quarantine[kind]).forEach((key) => {
        const q = quarantine[kind][key];
        const fp = currentFP(kind, key);
        if (fp === null || fp !== q.fp || now - (q.at || 0) > QUARANTINE_MS) {
          delete quarantine[kind][key];
          delete failCounts[kind][key];
        }
      });
    });
  }
  function noteFailure(kind, key) {
    failCounts[kind][key] = (failCounts[kind][key] || 0) + 1;
    if (failCounts[kind][key] >= QUARANTINE_AFTER && !quarantine[kind][key]) {
      quarantine[kind][key] = { fp: currentFP(kind, key), at: Date.now() };
      console.warn("Synchro : entité mise en quarantaine après " + QUARANTINE_AFTER + " échecs (" + kind + " : " + key + ") — le reste de la synchro continue sans elle.");
      if (window.WL_toast) { try { window.WL_toast("Un élément résiste à la synchro : il est mis de côté, le reste continue de se synchroniser."); } catch (e) { /* affichage seulement */ } }
    }
    persistSyncMeta();
  }
  function noteSuccess(kind, key) { if (failCounts[kind][key]) { delete failCounts[kind][key]; persistSyncMeta(); } }
  /* Entités « sales » qui peuvent partir maintenant (hors
     quarantaine) — c'est ça, « du travail à faire ». */
  function actionableCount() {
    let n = 0;
    dirtyDays.forEach((k) => { if (!quarantine.days[k]) n++; });
    dirtyStops.forEach((k) => { if (!quarantine.stops[k]) n++; });
    dirtyPhotoStops.forEach((k) => { if (!quarantine.photos[k]) n++; });
    return n;
  }
  function quarantineCount() {
    return Object.keys(quarantine.days).length + Object.keys(quarantine.stops).length + Object.keys(quarantine.photos).length;
  }
  /* v20 : transitions corbeille EXPLICITES. Toute modification de
     l'utilisateur passe par save()/saveNow() -> recomputeDirty()
     HORS fusion : un passage vivant -> corbeille observé là est
     un geste de l'utilisateur (cette session, ou une session
     précédente du même appareil — l'ensemble est persisté). Un
     passage corbeille -> vivant retire le sauf-conduit.
     Pendant un rechargement (merging = true), RIEN n'est marqué :
     la base est reconstruite par fusion (ligne serveur, règle
     « l'arrêt suit sa journée supprimée », surcouche) — ce ne
     sont pas des gestes de l'utilisateur. */
  function noteTrashTransitions() {
    (DB.days || []).forEach((d) => {
      const now = d.deletedAt || null;
      if (knownDeletedDays.has(d.date)) {
        const prev = knownDeletedDays.get(d.date);
        if (!prev && now) explicitTrashDays.add(d.date);
        else if (prev && !now) explicitTrashDays.delete(d.date);
      }
      knownDeletedDays.set(d.date, now);
    });
    (DB.stops || []).forEach((s) => {
      const now = s.deletedAt || null;
      if (knownDeletedStops.has(s.id)) {
        const prev = knownDeletedStops.get(s.id);
        if (!prev && now) explicitTrashStops.add(s.id);
        else if (prev && !now) explicitTrashStops.delete(s.id);
      }
      knownDeletedStops.set(s.id, now);
    });
  }
  /* Après un rechargement : les cartes « connues » sont
     reconstruites depuis la base fusionnée — sans rien marquer. */
  function refreshKnownDeleted() {
    knownDeletedDays = new Map(); knownDeletedStops = new Map();
    if (!DB) return;
    (DB.days || []).forEach((d) => knownDeletedDays.set(d.date, d.deletedAt || null));
    (DB.stops || []).forEach((s) => knownDeletedStops.set(s.id, s.deletedAt || null));
  }
  /* Recalcule les ensembles « sales » en comparant chaque entité
     locale à son empreinte « propre ». Filet de sécurité appelé à
     chaque sauvegarde et à chaque démarrage : même si un ensemble
     persisté était perdu, un écart réel est redétecté ici. Un
     ensemble ne rétrécit JAMAIS ici — seul un cycle de poussée
     vérifiée retire des ids. */
  function recomputeDirty() {
    if (!DB) return;
    releaseQuarantine(); // v20 : une entité modifiée ou périmée sort de quarantaine
    (DB.days || []).forEach((d) => { if (cleanDays.get(d.date) !== dayFP(d)) dirtyDays.add(d.date); });
    (DB.stops || []).forEach((s) => { if (cleanStops.get(s.id) !== stopFP(s)) dirtyStops.add(s.id); });
    const photoStopIds = new Set([...Object.keys(DB.photos || {}), ...cleanPhotos.keys()]);
    photoStopIds.forEach((sid) => {
      const fp = photoFP((DB.photos || {})[sid]);
      if (fp === "" && !cleanPhotos.has(sid)) return; // arrêt sans photo jamais poussé : rien à suivre
      // v21 : un seau local VIDE ne prouve une suppression que
      // si les photos de l'arrêt sont CONNUES de cette session.
      // Quand le stockage du téléphone sature (des dizaines de
      // photos de ~150 Ko dépassent vite les ~5 Mo de
      // localStorage), persistLocal() écrit sa copie ALLÉGÉE —
      // photos des seuls arrêts « sales » : au redémarrage, les
      // photos CONFIRMÉES ont disparu de la copie locale sans
      // avoir été supprimées. Le test de charge réel v20 l'a
      // montré, et le harnais l'a prouvé (run27/dbg27, journal
      // des écritures à l'appui) : sans ce garde-fou, ce filet
      // déduisait une suppression de CHAQUE seau vidé par la
      // copie allégée, la poussée EFFAÇAIT les photos du serveur
      // une à une, et la vérification finale comparait deux
      // ensembles vides — « ✓ Synchronisé » sur des photos
      // perdues. Le drapeau photoUnknownStops (posé à l'init,
      // levé dès que le serveur est relu) distingue les deux
      // cas ; une vraie suppression — geste fait sur des photos
      // visibles, donc connues — passe normalement.
      if (fp === "" && photoUnknownStops.has(sid)) return;
      if (cleanPhotos.get(sid) !== fp) dirtyPhotoStops.add(sid);
    });
    if (!merging) noteTrashTransitions(); // v20 : garde-fou corbeille (jamais pendant une fusion)
    refreshUnpushed();
  }
  /* Après un rechargement : les empreintes « propres » des entités
     LUES du serveur et NON sales avancent jusqu'à l'état lu (c'est
     l'état que le serveur vient de confirmer par cette lecture).
     Les entités absentes de la lecture (préservées localement) et
     les entités sales gardent leur ancienne empreinte. */
  function refreshCleanFromDB(srvDayDateSet, srvStopIdSet, preDirty, srvFPs) {
    if (!DB) return;
    // v20 : « non sale » se juge sur les ensembles d'AVANT ce
    // rechargement (preDirty : les vraies modifications locales en
    // attente). Le recomputeDirty() de fin de fusion, lui, marque
    // « sale » toute entité lue du serveur dont l'empreinte n'a
    // jamais été enregistrée — avec les ensembles courants, AUCUNE
    // entité nouvellement lue n'avançait jamais son empreinte :
    // elle restait « sale » et chaque fenêtre la REPOUSSAIT telle
    // quelle au cycle suivant. C'est ce repoussage verbatim qui,
    // au rodage v20 (run), a écrasé la corbeille d'un clone posée
    // par la fenêtre active : une fenêtre périmée a réécrit sa
    // copie vivante par-dessus, après coup. Une entité lue du
    // serveur et non modifiée localement est PROPRE, point.
    // Deuxième moitié du même correctif : l'entité ressort aussi
    // de l'ensemble « sale ». recomputeDirty() ne rétrécit JAMAIS
    // les ensembles (règle v17) : sans ce retrait, l'entité lue
    // restait « sale » jusqu'à ce qu'un cycle la RÉÉCRIVE telle
    // quelle au serveur — et si une autre fenêtre la corbeillait
    // entre la lecture et ce repoussage, le repoussage la
    // ressuscitait (prouvé au rodage v20, run : le clone corbeillé
    // par la fenêtre active revenait vivant sous les repoussages
    // des fenêtres périmées). Ici, la forme locale EST la forme
    // lue du serveur : il n'y a rien à confirmer, rien à écrire.
    const wasDirtyDay = (k) => (preDirty ? preDirty.days.has(k) : dirtyDays.has(k));
    const wasDirtyStop = (k) => (preDirty ? preDirty.stops.has(k) : dirtyStops.has(k));
    const wasDirtyPhoto = (k) => (preDirty ? preDirty.photos.has(k) : dirtyPhotoStops.has(k));
    // v21 : un arrêt relu du serveur et non « sale » (au sens
    // d'avant la fusion) a de nouveau des photos CONNUES : le
    // seau fusionné fait foi, le drapeau « inconnu » tombe.
    (DB.stops || []).forEach((s) => {
      if (srvStopIdSet && !srvStopIdSet.has(s.id)) return;
      if (!wasDirtyPhoto(s.id)) photoUnknownStops.delete(s.id);
    });
    // v23 : on ne certifie que ce qui est IDENTIQUE au contenu
    // lu du serveur (srvFPs, capturé avant la surcouche). Si le
    // contenu fusionné diffère de la lecture, il porte la
    // surcouche d'une modification locale arrivée PENDANT ce
    // rechargement — preDirty, photographié au départ, ne peut
    // pas la voir, et l'ancienne règle avançait quand même
    // l'empreinte « propre » jusqu'au contenu local : la
    // modification était crue CONFIRMÉE alors qu'elle n'avait
    // jamais été écrite au serveur ; jamais poussée ensuite,
    // elle était écrasée par le rechargement suivant (perte
    // silencieuse prouvée par run26a : modification faite
    // pendant un rechargement en vol, disparue sans trace).
    // L'entité reste alors « sale » : la poussée qui suit le
    // rechargement la rendra pour de vrai.
    const srvDayFPs = srvFPs && srvFPs.days, srvStopFPs = srvFPs && srvFPs.stops, srvPhotoFPs = srvFPs && srvFPs.photos;
    (DB.days || []).forEach((d) => {
      if (srvDayDateSet && !srvDayDateSet.has(d.date)) return;
      if (!wasDirtyDay(d.date)) {
        if (srvDayFPs && srvDayFPs.has(d.date) && srvDayFPs.get(d.date) !== dayFP(d)) return; // surcouche en vol : ne pas certifier
        cleanDays.set(d.date, dayFP(d)); dirtyDays.delete(d.date);
      }
    });
    (DB.stops || []).forEach((s) => {
      if (srvStopIdSet && !srvStopIdSet.has(s.id)) return;
      if (!wasDirtyStop(s.id)) {
        if (!(srvStopFPs && srvStopFPs.has(s.id) && srvStopFPs.get(s.id) !== stopFP(s))) { cleanStops.set(s.id, stopFP(s)); dirtyStops.delete(s.id); }
      }
      if (!wasDirtyPhoto(s.id)) {
        if (!(srvPhotoFPs && srvPhotoFPs.has(s.id) && srvPhotoFPs.get(s.id) !== photoFP((DB.photos || {})[s.id]))) { cleanPhotos.set(s.id, photoFP((DB.photos || {})[s.id])); dirtyPhotoStops.delete(s.id); }
      }
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
  let reloadRetryTimer = null; // v24 : relance d'un rechargement dont un lot de photos a échoué
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

  /* v20 : VERROU DE SYNCHRO — une seule fenêtre synchronise à la
     fois. Le test de charge v19 s'est déroulé avec possiblement
     DEUX fenêtres de l'app ouvertes sur le même appareil (celle
     du déploiement précédent, jamais fermée, + la nouvelle) :
     deux moteurs de synchro sur le MÊME stockage local et le
     MÊME serveur, chacun persistant SA vue fusionnée par-dessus
     celle de l'autre entre les poussées — c'est ainsi que les
     restaurations faites dans une fenêtre étaient annulées par
     les rechargements de l'autre (voir le garde-fou corbeille
     dans la poussée). Règle v20 : pousser exige un verrou exclusif.
     - Si l'API Web Locks est disponible (navigateurs récents),
       elle arbitre : la fenêtre détient le verrou nommé pendant
       tout son cycle de poussée.
     - Sinon, élection par battement de cœur dans localStorage :
       le détenteur réécrit son jeton toutes les 2 s ; un jeton
       sans battement depuis plus de 6 s est expiré (fenêtre fermée
       ou rechargée en pleine poussée) et le verrou peut être pris.
       La prise se fait en écriture + relecture synchrone : un
       seul gagnant.
     Une fenêtre qui n'obtient pas le verrou dans le délai
     n'écrit RIEN : son cycle est replanifié (nouvel essai
     automatique) — jamais de poussée en parallèle. Le verrou est
     par appareil (stockage partagé) : entre deux APPAREILS, la
     limite connue demeure (dernière poussée gagne, par entité). */
  const LS_LOCK = "wl_livraison_sync_lock_v20";
  const LOCK_TTL_MS = 6000, LOCK_BEAT_MS = 2000, LOCK_WAIT_MS = 30000;
  const lockOwnerId = uid();
  const HAS_WEB_LOCKS = typeof navigator !== "undefined" && !!navigator.locks && typeof navigator.locks.request === "function";
  let syncLockHeld = false;
  let lockBeatTimer = null;
  let wlHeld = false, wlRequestPending = false, wlReleaseFn = null;
  function readSyncLock() {
    try { return JSON.parse(localStorage.getItem(LS_LOCK) || "null"); } catch (e) { return null; }
  }
  function hbTryTakeLock() {
    const now = Date.now();
    const cur = readSyncLock();
    if (cur && cur.owner !== lockOwnerId && now - (cur.beat || 0) <= LOCK_TTL_MS) return false;
    try { localStorage.setItem(LS_LOCK, JSON.stringify({ owner: lockOwnerId, beat: now })); } catch (e) { return false; }
    const conf = readSyncLock();
    return !!conf && conf.owner === lockOwnerId;
  }
  function hbBeatStart() {
    hbBeatStop();
    const beat = () => {
      if (!syncLockHeld) return;
      const cur = readSyncLock();
      if (cur && cur.owner === lockOwnerId) {
        try { localStorage.setItem(LS_LOCK, JSON.stringify({ owner: lockOwnerId, beat: Date.now() })); } catch (e) { /* page morte : le jeton expirera tout seul */ }
      }
      lockBeatTimer = setTimeout(beat, LOCK_BEAT_MS);
    };
    lockBeatTimer = setTimeout(beat, LOCK_BEAT_MS);
  }
  function hbBeatStop() { if (lockBeatTimer) { clearTimeout(lockBeatTimer); lockBeatTimer = null; } }
  function wlTryStart() {
    if (wlHeld || wlRequestPending) return;
    wlRequestPending = true;
    try {
      const p = navigator.locks.request("wl_livraison_sync_v20", { ifAvailable: true }, async (lock) => {
        if (!lock) { wlRequestPending = false; return; }
        wlHeld = true;
        await new Promise((res) => { wlReleaseFn = () => { wlRequestPending = false; res(); }; });
        wlHeld = false; wlReleaseFn = null;
      });
      if (p && p.catch) p.catch(() => { wlRequestPending = false; });
    } catch (e) { wlRequestPending = false; }
  }
  async function acquireSyncLock() {
    if (syncLockHeld) return true;
    const deadline = Date.now() + LOCK_WAIT_MS;
    while (Date.now() < deadline) {
      if (HAS_WEB_LOCKS) {
        wlTryStart();
        if (wlHeld) { syncLockHeld = true; return true; }
      } else if (hbTryTakeLock()) {
        syncLockHeld = true;
        hbBeatStart();
        return true;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    return false;
  }
  function releaseSyncLock() {
    if (!syncLockHeld) return;
    syncLockHeld = false;
    hbBeatStop();
    if (HAS_WEB_LOCKS) { if (wlReleaseFn) wlReleaseFn(); }
    else {
      const cur = readSyncLock();
      if (cur && cur.owner === lockOwnerId) { try { localStorage.removeItem(LS_LOCK); } catch (e) { /* page morte : expiration naturelle */ } }
    }
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
    if (!unpushedChanges) { setSyncState(quarantineCount() ? "error" : "ok"); return; }
    // v20 : il ne reste que des entités en quarantaine — rien à
    // pousser, mais l'erreur reste VISIBLE (pas de « ✓ » mensonger).
    if (!actionableCount()) { setSyncState("error"); return; }
    setSyncState("pending");
    // v20 : VERROU — une seule fenêtre pousse à la fois. Sans le
    // verrou dans le délai, ce cycle n'écrit RIEN et se replanifie.
    const gotLock = await acquireSyncLock();
    if (!gotLock) { setSyncState("pending"); scheduleSyncRetry(); return; }
    try { await pushCycleLocked(); }
    finally { releaseSyncLock(); }
  }
  /* v20 : le cycle de poussée proprement dit, sous verrou.
     Structure nouvelle : ISOLATION PAR ENTITÉ. Chaque phase
     confirme ses entités une à une (le lot reste le chemin
     rapide ; le repli individuel décide pour les entités que le
     lot n'a pas confirmées) ; une entité en échec est comptée
     (noteFailure -> quarantaine après 5) et reste « sale », mais
     n'empêche plus JAMAIS les autres d'être confirmées ni le
     cycle de se terminer. Seul un échec de LECTURE globale
     (impossible de savoir ce que le serveur détient) avorte le
     cycle entier, comme avant. */
  async function pushCycleLocked() {
    recomputeDirty();
    // Instantané du travail à faire (HORS quarantaine) + empreintes
    // au départ : ce qui changera PENDANT la poussée (autre frappe,
    // autre onglet) gardera une empreinte différente et restera
    // « sale ».
    const todoDays = new Set([...dirtyDays].filter((k) => !quarantine.days[k]));
    const todoStops = new Set([...dirtyStops].filter((k) => !quarantine.stops[k]));
    const todoPhotos = new Set([...dirtyPhotoStops].filter((k) => !quarantine.photos[k]));
    const fpDay0 = new Map(), fpStop0 = new Map(), fpPhoto0 = new Map();
    todoDays.forEach((date) => { const d = DB.days.find((x) => x.date === date); if (d) fpDay0.set(date, dayFP(d)); });
    todoStops.forEach((id) => { const s = DB.stops.find((x) => x.id === id); if (s) fpStop0.set(id, stopFP(s)); });
    todoPhotos.forEach((sid) => { const s = DB.stops.find((x) => x.id === sid); fpPhoto0.set(sid, photoFP(s ? DB.photos[s.id] : [])); });
    const adoptedMap = {}; // ancien id local -> id serveur (arrêts hérités)
    const okDays = new Set(), okStops = new Set(), okPhotos = new Set();
    const failed = { days: new Set(), stops: new Set(), photos: new Set() };
    const settledByDay = new Set(); // arrêts soldés localement par le garde-fou (règle c)
    const staleStops = new Set(); // v23 : arrêts bloqués par le garde-fou fraîcheur (voir phase 3)
    let cycleError = null;
    let srvDayDeletedByDate = {};
    try {
      // 0. v20 : lecture des journées serveur AVANT toute écriture
      // (ids par date + suppressions) — sert à l'adoption d'id et
      // au garde-fou corbeille plus bas.
      const daysPre = await selectAllPages((a, b) => supa.from("days").select("id,date,deleted_at").range(a, b)); // v22 : paginé
      throwIfError("Lecture des journées", daysPre);
      const srvDayIdByDate = {};
      const srvDateByDayId = {}; // v23 : inverse — sert au garde-fou fraîcheur (empreinte des lignes serveur)
      (daysPre.data || []).forEach((d) => {
        srvDayIdByDate[d.date] = d.id;
        srvDateByDayId[d.id] = d.date;
        srvDayDeletedByDate[d.date] = d.deleted_at ? Date.parse(d.deleted_at) : null;
      });
      // v20 : ADOPTION D'ID DE JOURNÉE. Deux fenêtres/appareils qui
      // créent la MÊME date chacun de leur côté lui donnent deux id
      // différents ; l'upsert (onConflict « date ») de la fenêtre
      // perdante partait alors avec un id contredisant la clé de
      // conflit — PostgREST rejette le lot ENTIER des journées,
      // l'exception annulait tout le cycle, et la synchro bouclait
      // sans jamais finir (l'autre symptôme du test de charge v19).
      // Maintenant : si le serveur connaît déjà la date sous un
      // autre id, l'appareil ADOPTE l'id serveur (les arrêts
      // suivent), comme les arrêts le font depuis la v8.
      (DB.days || []).forEach((d) => {
        const srvId = srvDayIdByDate[d.date];
        if (srvId && srvId !== d.id) {
          const oldId = d.id;
          d.id = srvId;
          (DB.stops || []).forEach((s) => { if (s.dayId === oldId) s.dayId = srvId; });
        }
      });
      // 1. Adresses des seuls arrêts concernés — upsert VÉRIFIÉ par
      // la ligne retournée, ISOLÉ par adresse (v20) : une adresse
      // qui échoue ne bloque que ses arrêts, pas le cycle.
      const workStops = DB.stops.filter((s) => todoStops.has(s.id) || todoPhotos.has(s.id));
      const addrIdByKey = {};
      const failedAddrKeys = new Set();
      for (const s of workStops) {
        if (!s.addressKey || addrIdByKey[s.addressKey] || failedAddrKeys.has(s.addressKey)) continue;
        try {
          const res = await supa.from("addresses").upsert(addrRowOf(s), { onConflict: "address_key" }).select("id,address_key").single();
          throwIfError("Adresse", res);
          if (!res.data || !res.data.id) throw new Error("Adresse : écriture non confirmée par le serveur");
          addrIdByKey[s.addressKey] = res.data.id;
        } catch (e) {
          failedAddrKeys.add(s.addressKey);
          console.warn("Synchro : adresse non rendue ce cycle-ci (" + s.addressKey + ") — ses arrêts attendront le prochain cycle.", e);
        }
      }
      workStops.forEach((s) => { if (s.addressKey && addrIdByKey[s.addressKey]) s._addressId = addrIdByKey[s.addressKey]; });
      // v17 : plus de pré-passage « suppressions d'abord » (v10-v16).
      // Chaque entité sale est écrite en LIGNE COMPLÈTE, deleted_at
      // compris, et vérifiée — une suppression est une modification
      // comme une autre, ni plus ni moins protégée.
      // 2. Journées sales — lot VÉRIFIÉ ligne par ligne (v17 : chaque
      // ligne retournée doit porter exactement les valeurs envoyées),
      // puis v20 : REPLI INDIVIDUEL pour les journées que le lot n'a
      // pas confirmées, et échec ISOLÉ pour celles qui échouent
      // encore — elles ne bloquent plus les autres.
      const dayRowByDate = new Map();
      for (const date of todoDays) {
        const d = DB.days.find((x) => x.date === date);
        if (!d) { dirtyDays.delete(date); continue; } // disparue de la base : plus rien à écrire
        // v20 : GARDE-FOU CORBEILLE (journées) — une suppression ne
        // part que si elle est EXPLICITE (geste de l'utilisateur,
        // suivi par noteTrashTransitions) ou si le serveur a déjà
        // cette journée à la corbeille. Sinon elle est BLOQUÉE et
        // réparée localement : la journée revit sur l'appareil.
        // Cas (e) : journée ABSENTE du serveur (purgée là-bas ou
        // jamais rendue) — rien à protéger côté serveur : on solde
        // localement SANS écrire et SANS ressusciter. Sans ce cas,
        // la course purge/rechargement à l'amorçage (la purge
        // supprime la ligne pendant que le rechargement la
        // réimporte comme « locale seulement, sale ») faisait
        // ressusciter les vieilles corbeilles purgées.
        if (d.deletedAt && !explicitTrashDays.has(date) && !(date in srvDayDeletedByDate)) {
          okDays.add(date);
          continue;
        }
        if (d.deletedAt && !explicitTrashDays.has(date) && !srvDayDeletedByDate[date]) {
          console.warn("Garde-fou corbeille : suppression de journée NON explicite bloquée (" + date + ") — journée restaurée localement, rien n'a été envoyé au serveur.");
          if (window.WL_toast) { try { window.WL_toast("Suppression automatique bloquée : une journée a failli partir à la corbeille toute seule."); } catch (e) { /* affichage seulement */ } }
          d.deletedAt = null;
        }
        dayRowByDate.set(date, dayRowOf(d));
      }
      const dayRows = [...dayRowByDate.values()];
      const verifyDayRow = (row, r) => {
        if (!r) return false;
        const delSent = row.deleted_at ? Date.parse(row.deleted_at) : null;
        const delBack = r.deleted_at ? Date.parse(r.deleted_at) : null;
        return r.status === row.status && !!r.optimized === !!row.optimized && delBack === delSent;
      };
      if (dayRows.length) {
        try {
          const res = await supa.from("days").upsert(dayRows, { onConflict: "date" }).select("id,date,status,optimized,deleted_at");
          throwIfError("Journées", res);
          const back = {};
          (res.data || []).forEach((r) => { back[r.date] = r; });
          dayRows.forEach((row) => { if (verifyDayRow(row, back[row.date])) okDays.add(row.date); });
        } catch (e) { /* le repli individuel ci-dessous décide, journée par journée */ }
        for (const row of dayRows) {
          if (okDays.has(row.date)) continue;
          try {
            const res = await supa.from("days").upsert([row], { onConflict: "date" }).select("id,date,status,optimized,deleted_at");
            throwIfError("Journée " + row.date, res);
            if (!verifyDayRow(row, (res.data || [])[0])) throw new Error("Journée " + row.date + " : le serveur n'a pas les valeurs envoyées");
            okDays.add(row.date);
          } catch (e) {
            failed.days.add(row.date);
            noteFailure("days", row.date);
            console.warn("Synchro : journée non rendue ce cycle-ci (" + row.date + ") — les autres continuent.", e);
          }
        }
      }
      // Carte complète des identifiants de journées (les arrêts y
      // font référence) — relue, jamais supposée.
      const dayIdByDate = {};
      const daysNowRes = await selectAllPages((a, b) => supa.from("days").select("id,date").range(a, b)); // v22 : paginé
      throwIfError("Lecture des journées", daysNowRes);
      (daysNowRes.data || []).forEach((d) => { dayIdByDate[d.date] = d.id; });
      // 3. Arrêts sales — d'abord le GARDE-FOU CORBEILLE (v20).
      // Une suppression (deleted_at) ne part au serveur que si :
      //  (a) elle est EXPLICITE — geste de l'utilisateur suivi par
      //      noteTrashTransitions (et persisté) ; ou
      //  (b) le serveur a DÉJÀ cet arrêt à la corbeille —
      //      confirmation idempotente (suppression faite sur un
      //      autre appareil, apprise par rechargement) ; ou
      //  (c) sa JOURNÉE est à la corbeille AU SERVEUR — l'arrêt
      //      suit sa journée : on ne pousse RIEN pour lui, son état
      //      local est soldé sans écriture (la règle de fusion v10
      //      le maintient corbeillé tant que la journée l'est ; si
      //      la journée est restaurée, ses champs repartiront
      //      normalement à la prochaine modification) ; ou
      //  (e) l'arrêt est ABSENT du serveur (purgé là-bas, ou créé
      //      hors ligne et corbeillé avant sa première synchro) :
      //      rien à protéger côté serveur — soldé localement SANS
      //      écrire et SANS ressusciter. Ce cas ferme la course
      //      purge/rechargement à l'amorçage : purgeTrash supprime
      //      la ligne serveur d'une vieille corbeille pendant que
      //      le rechargement initial la réimporte comme « locale
      //      seulement, sale » — sans (e), le garde-fou la
      //      ressuscitait et la purge ne finissait jamais.
      // Sinon — arrêt vivant au serveur, journée vivante, aucune
      // suppression explicite — la suppression est un FANTÔME :
      // elle est BLOQUÉE et réparée localement (l'arrêt revit sur
      // l'appareil), jamais appliquée au serveur.
      // LE CHEMIN DU BUG V19 : au test de charge, 16 arrêts
      // « Charge » sont passés à la corbeille tout seuls et les
      // restaurations étaient annulées à chaque rechargement.
      // Mécanisme (fenêtre périmée + règles d'avant v20) : une
      // deuxième fenêtre restée ouverte gardait en mémoire des
      // journées corbeillées lors d'un nettoyage antérieur ; sa
      // poussée les rendait au serveur ; à la fusion, la règle
      // v10 (« un arrêt dont la journée est supprimée est supprimé
      // aussi ») corbeillait LOCALEMENT tous les arrêts de ces
      // journées ; ces arrêts devenaient « sales » et la poussée
      // suivante écrivait leurs deleted_at au serveur — suppression
      // permanente, sans aucun geste de l'utilisateur. Et quand
      // l'utilisateur restaurait un arrêt dans la fenêtre active,
      // la fenêtre périmée persistait SA base fusionnée (arrêt
      // encore corbeillé) dans le stockage local partagé avant que
      // la restauration soit poussée : au rechargement suivant, la
      // restauration avait disparu des deux copies. Le verrou
      // (plus haut) empêche les poussées parallèles ; ce garde-fou
      // ferme la porte aux suppressions fantômes elles-mêmes,
      // quelle que soit leur source.
      const trashedCandidates = workStops.filter((s) => todoStops.has(s.id) && s.deletedAt);
      const srvStopDeleted = {};
      if (trashedCandidates.length) {
        const ids = trashedCandidates.map((s) => s.id).filter((id) => uuidOk(id));
        if (ids.length) {
          const r = await supa.from("stops").select("id,deleted_at").in("id", ids);
          throwIfError("Corbeille (lecture serveur)", r);
          (r.data || []).forEach((row) => { srvStopDeleted[row.id] = row.deleted_at ? Date.parse(row.deleted_at) : null; });
        }
      }
      for (const s of trashedCandidates) {
        if (explicitTrashStops.has(s.id)) continue; // (a) explicite
        if (srvStopDeleted[s.id]) continue;         // (b) déjà corbeillé au serveur
        if (!(s.id in srvStopDeleted)) { settledByDay.add(s.id); continue; } // (e) ABSENT du serveur : soldé localement, sans écrire ni ressusciter (course purge/rechargement — voir le cas (e) des journées)
        const day = DB.days.find((x) => x.id === s.dayId);
        if (day && srvDayDeletedByDate[day.date]) { settledByDay.add(s.id); continue; } // (c) suit sa journée
        console.warn("Garde-fou corbeille : suppression d'arrêt NON explicite bloquée (" + s.id + ", " + (s.client || "") + ") — arrêt restauré localement, rien n'a été envoyé au serveur.");
        if (window.WL_toast) { try { window.WL_toast("Suppression automatique bloquée : un arrêt a failli partir à la corbeille tout seul."); } catch (e) { /* affichage seulement */ } }
        s.deletedAt = null; // réparation locale : l'arrêt revit et repart vivant ce cycle-ci
      }
      // v23 : GARDE-FOU FRAÎCHEUR (arrêts vivants) — LE BUG DU
      // TEST NAVIGATEUR RÉEL v22 (23 nov. 2026, prouvé par run30,
      // journal des écritures à l'appui) : 6 arrêts sur 63
      // retrouvés à un état PARTIEL de mi-création (téléphone
      // « 41 », adresse « 189 ») APRÈS avoir été complétés et
      // vérifiés. Mécanisme : une fenêtre périmée (onglet resté
      // ouvert d'une session interrompue, ou état « sale » hérité
      // au redémarrage) détenait la copie d'avant la complétion ;
      // sa poussée suivante l'écrivait PAR-DESSUS la version
      // complète du serveur — la phase 3 ne comparait jamais la
      // ligne locale à l'état serveur (seule la corbeille avait
      // un garde-fou) et aucun updated_at n'existe pour départager.
      // Règle, par arrêt sur le point d'être écrit : relire sa
      // ligne serveur, reconstruire son empreinte EXACTEMENT
      // comme le rechargement construit les arrêts (même
      // conversion, donc empreintes comparables aux empreintes
      // « propres »), puis —
      //  · serveur = ce qu'on allait écrire : déjà rendu,
      //    confirmer SANS écrire ;
      //  · serveur = l'empreinte « propre » de cette fenêtre
      //    (sa dernière base confirmée) : rien n'a bougé depuis,
      //    écrire normalement ;
      //  · sinon (le serveur a bougé depuis la base de cette
      //    fenêtre, ou cette fenêtre n'a aucune base) : la
      //    fenêtre est PÉRIMÉE pour cet arrêt — NE RIEN ÉCRIRE,
      //    le solder localement et recharger en fin de cycle :
      //    la version serveur, plus récente, sera adoptée.
      // Une restauration explicite (importJSON) est exemptée :
      // geste volontaire qui DOIT pouvoir tout écraser.
      const exemptFresh = freshnessExempt; freshnessExempt = false;
      if (!exemptFresh) {
        const freshCands = workStops.filter((s) => todoStops.has(s.id) && uuidOk(s.id) && !settledByDay.has(s.id) && !s.deletedAt);
        if (freshCands.length) {
          const srvStopById = {};
          for (let i = 0; i < freshCands.length; i += 100) {
            const chunkIds = freshCands.slice(i, i + 100).map((s) => s.id);
            const rr = await selectAllPages((a, b) => supa.from("stops").select("*").in("id", chunkIds).range(a, b));
            throwIfError("Fraîcheur (lecture des arrêts)", rr);
            (rr.data || []).forEach((r) => { srvStopById[r.id] = r; });
          }
          const addrIds = [...new Set(Object.values(srvStopById).map((r) => r.address_id).filter(Boolean))];
          const srvAddrById = {};
          if (addrIds.length) {
            const ra = await selectAllPages((a, b) => supa.from("addresses").select("*").in("id", addrIds).range(a, b));
            throwIfError("Fraîcheur (lecture des adresses)", ra);
            (ra.data || []).forEach((r) => { srvAddrById[r.id] = r; });
          }
          let toastShown = false;
          for (const s of freshCands) {
            const row = srvStopById[s.id];
            if (!row) continue; // absent du serveur : création normale
            const a = srvAddrById[row.address_id] || {};
            const srvLocal = {
              id: row.id, dayId: row.day_id, position: row.position || 0,
              address: a.full_address || "", street: a.street || "", city: a.city || "",
              sector: a.sector || "", postal: a.postal_code || "",
              lat: a.lat, lng: a.lng, addressKey: a.address_key || "",
              client: row.client_name || "", apartment: row.apartment || "", apartmentNone: !!row.apartment_none, phone: row.phone || "",
              vendor: row.vendor_name || "", appliance: row.appliance || "", pieces: row.pieces || 1,
              installation: !!row.installation, pickup: !!row.pickup,
              orderPref: row.order_pref || "auto", type: row.type || "livraison",
              win1s: t2m(row.win1_start), win1e: t2m(row.win1_end),
              win2s: t2m(row.win2_start), win2e: t2m(row.win2_end),
              duration: 15, details: row.details || "",
              delivered: !!row.delivered, failed: !!row.failed,
              eta: row.eta_min != null ? row.eta_min : null,
              deletedAt: row.deleted_at ? Date.parse(row.deleted_at) : null
            };
            const r = stopRowOf(srvLocal, srvDateByDayId[row.day_id] || row.day_id, null);
            r.day_id = srvDateByDayId[row.day_id] || row.day_id;
            r.address_id = srvLocal.addressKey || null;
            r.deleted_at = srvLocal.deletedAt || null;
            const srvFP = JSON.stringify(r);
            if (srvFP === stopFP(s)) { okStops.add(s.id); continue; } // déjà rendu tel quel : confirmer sans écrire
            const baseFP = cleanStops.get(s.id);
            if (baseFP !== undefined && srvFP === baseFP) continue; // serveur toujours à ma base : écriture normale
            staleStops.add(s.id);
            console.warn("Garde-fou fraîcheur : arrêt modifié ailleurs entre-temps (" + s.id + ", " + (s.client || "") + ") — la version périmée de cette fenêtre n'a PAS été envoyée ; resynchronisation.");
            if (!toastShown && window.WL_toast) { toastShown = true; try { window.WL_toast("Conflit évité : un arrêt avait été mis à jour ailleurs — cette fenêtre s'est resynchronisée sans rien écraser."); } catch (e) { /* affichage seulement */ } }
          }
        }
      }
      // Lots de 50, VÉRIFIÉS ligne par ligne sur des champs témoins
      // (téléphone, position, eta, corbeille) — v20 : repli
      // individuel + échec isolé, comme pour les journées.
      const stopRows = [];
      const legacyStops = [];
      const blockedStops = []; // journée inconnue du serveur : l'arrêt attend (compté en échec, quarantaine possible si sa journée est elle-même en quarantaine)
      for (const s of workStops) {
        if (!todoStops.has(s.id)) continue;
        if (settledByDay.has(s.id)) continue; // soldé par le garde-fou (c) : aucune écriture
        if (staleStops.has(s.id)) continue; // v23 : bloqué par le garde-fou fraîcheur : aucune écriture
        if (s.addressKey && failedAddrKeys.has(s.addressKey)) { failed.stops.add(s.id); noteFailure("stops", s.id); continue; }
        const day = DB.days.find((x) => x.id === s.dayId);
        if (!day || !dayIdByDate[day.date]) { blockedStops.push(s.id); failed.stops.add(s.id); noteFailure("stops", s.id); continue; }
        const row = stopRowOf(s, dayIdByDate[day.date], s._addressId || null);
        if (row.phone == null) row.phone = null;       // clés toujours présentes dans le lot
        if (row.eta_min == null) row.eta_min = null;   // (sinon PostgREST peut ignorer la colonne)
        if (uuidOk(s.id)) stopRows.push(Object.assign({ id: s.id }, row));
        else legacyStops.push({ s, row });
      }
      for (const { s, row } of legacyStops) {
        // v8 : ancien identifiant local — insertion UNE fois, puis
        // adoption de l'identifiant serveur retourné et VÉRIFIÉ.
        // v20 : isolée — un échec ne bloque plus les autres arrêts.
        const id0 = s.id;
        try {
          const res = await supa.from("stops").insert(row).select("id").single();
          throwIfError("Arrêt (insertion)", res);
          if (!res.data || !res.data.id) throw new Error("Arrêt : insertion non confirmée par le serveur");
          adoptedMap[id0] = res.data.id;
          adoptStopId(s, res.data.id);
          okStops.add(id0);
        } catch (e) {
          failed.stops.add(id0);
          noteFailure("stops", id0);
          console.warn("Synchro : arrêt (insertion) non rendu ce cycle-ci (" + id0 + ").", e);
        }
      }
      const verifyStopRow = (row, r) => {
        if (!r) return false;
        const delSent = row.deleted_at ? Date.parse(row.deleted_at) : null;
        const delBack = r.deleted_at ? Date.parse(r.deleted_at) : null;
        return (r.phone || null) === (row.phone || null) && r.position === row.position &&
          (r.eta_min != null ? r.eta_min : null) === (row.eta_min != null ? row.eta_min : null) &&
          delBack === delSent;
      };
      for (let i = 0; i < stopRows.length; i += 50) {
        const chunk = stopRows.slice(i, i + 50);
        try {
          const res = await supa.from("stops").upsert(chunk, { onConflict: "id" }).select("id,phone,position,eta_min,deleted_at");
          throwIfError("Arrêts", res);
          const back = {};
          (res.data || []).forEach((r) => { back[r.id] = r; });
          chunk.forEach((row) => { if (verifyStopRow(row, back[row.id])) okStops.add(row.id); });
        } catch (e) { /* le repli individuel ci-dessous décide, arrêt par arrêt */ }
        for (const row of chunk) {
          if (okStops.has(row.id)) continue;
          try {
            const res = await supa.from("stops").upsert([row], { onConflict: "id" }).select("id,phone,position,eta_min,deleted_at");
            throwIfError("Arrêt " + row.id, res);
            if (!verifyStopRow(row, (res.data || [])[0])) throw new Error("Arrêt " + row.id + " : le serveur n'a pas les valeurs envoyées");
            okStops.add(row.id);
          } catch (e) {
            failed.stops.add(row.id);
            noteFailure("stops", row.id);
            console.warn("Synchro : arrêt non rendu ce cycle-ci (" + row.id + ") — les autres continuent.", e);
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
        if (staleStops.has(s.id)) continue; // v23 : fenêtre périmée pour cet arrêt (garde-fou fraîcheur) — ne pas toucher non plus à ses photos
        if (failed.stops.has(sid0) || failed.stops.has(s.id)) continue; // v20 : l'arrêt n'est pas rendu ce cycle-ci — ses photos attendront, sans compter comme un échec photo
        try {
        // v22 : le réimport d'abord s'impose dans DEUX cas —
        // (1) le drapeau v21 (copie allégée : empreinte propre
        // non vide, seau vide) ; (2) NOUVEAU : seau local vide
        // ET AUCUNE empreinte propre non vide pour cet arrêt.
        // Le cas (2) est le trou résiduel du test de charge réel
        // v21 (1 photo perdue sur 63), prouvé par run28 (P2) :
        // la photo avait été poussée et confirmée EN MÉMOIRE,
        // mais l'écriture du méta qui persiste cette
        // confirmation a été refusée (quota — persistSyncMeta
        // avale l'échec en silence) ; au redémarrage, l'arrêt
        // était « photos sales » SANS empreinte propre (le
        // drapeau v21, qui exige une empreinte, ne pouvait pas
        // être posé), la copie allégée n'avait pas sa photo, et
        // la phase prenait le seau vide pour une suppression :
        // elle a EFFACÉ la photo du serveur, puis « vérifié »
        // vide = vide — perte permanente sous « ✓ Synchronisé ».
        // Règle v22 : un seau vide ne prouve une suppression que
        // si cet appareil a déjà CONFIRMÉ un ensemble non vide
        // (empreinte propre non vide) — c'est le cas de la vraie
        // suppression (geste fait sur des photos visibles, donc
        // connues et confirmées, run27 (E)). Sinon, le seau est
        // INCONNU, pas vide : réimporter d'abord (union), comme
        // pour le drapeau. Si le serveur n'a rien, l'union
        // n'ajoute rien et le calcul continue normalement.
        const bucketNow0 = (DB.photos || {})[s.id] || [];
        if (photoUnknownStops.has(s.id) || (!bucketNow0.length && !cleanPhotos.get(s.id))) {
          // v21 : arrêt chargé depuis une copie locale ALLÉGÉE
          // (quota) : ses photos serveur ne sont pas dans le seau
          // local. Les réimporter AVANT tout calcul — sinon la
          // phase supprimerait du serveur des photos que
          // l'utilisateur n'a jamais retirées (bogue du test de
          // charge v20, prouvé par run27/dbg27). Après l'union,
          // le seau local fait foi et le drapeau tombe ;
          // l'empreinte de départ du cycle devient celle du seau
          // complété pour que le nettoyage de fin de cycle
          // puisse conclure dès ce cycle-ci.
          // v24 : PAGINÉ — la lecture eq() non paginée plafonnait
          // à 1 000 lignes (PostgREST) : pour un arrêt qui en
          // détient davantage, la phase travaillait sur une
          // fenêtre aveugle (cœur du cliquet de duplication,
          // prouvé par run36 — voir DIAG-v24).
          const r0 = await selectAllPages((a, b) => supa.from("photos").select("id,data_url").eq("stop_id", s.id).range(a, b));
          throwIfError("Photos (réimport copie allégée)", r0);
          if (!DB.photos) DB.photos = {};
          const bucket0 = DB.photos[s.id] || (DB.photos[s.id] = []);
          const haveId = new Set(bucket0.map((p) => p.id));
          (r0.data || []).forEach((r) => { if (!haveId.has(r.id)) bucket0.push({ id: r.id, dataUrl: r.data_url }); });
          photoUnknownStops.delete(s.id);
          fpPhoto0.set(sid0, photoFP(bucket0));
        }
        const local = DB.photos[s.id] || [];
        const readSrvPhotos = async () => {
          // v24 : PAGINÉ, comme le réimport ci-dessus — srvUrls
          // et la vérification finale doivent voir TOUTES les
          // lignes de l'arrêt. Sans pagination, une photo au-delà
          // de la ligne 1 000 paraît absente : insertion en
          // doublon à chaque cycle, et la vérification (relue par
          // la même fenêtre) échoue pour toujours — l'arrêt reste
          // « photos sales » et chaque relance ajoute une copie
          // (run36, DIAG-v24).
          const r = await selectAllPages((a, b) => supa.from("photos").select("id,data_url").eq("stop_id", s.id).range(a, b));
          throwIfError("Photos (lecture serveur)", r);
          return r.data || [];
        };
        let srv = await readSrvPhotos();
        // v24 : appariement PAR EFFECTIF — chaque entrée du seau
        // adopte une ligne serveur DISTINCTE de même URL ; une
        // ligne n'est créée que pour une entrée sans ligne libre.
        // (Avant : appariement par ENSEMBLE d'URL — deux entrées
        // de la même photo adoptaient la même ligne, et surtout
        // une URL « présente » masquait n'importe quel nombre de
        // lignes.) La lecture étant complète (paginée), les
        // comptes sont exacts : la phase est idempotente.
        const srvIds = new Set(srv.map((p) => p.id));
        const usedIds = new Set();
        const paired = new Set(); // v24 : une ligne ne peut être revendiquée que par UNE entrée (des entrées héritées peuvent partager le même id serveur)
        local.forEach((p) => { if (srvIds.has(p.id) && !usedIds.has(p.id)) { usedIds.add(p.id); paired.add(p); } });
        const freeByUrl = new Map();
        srv.forEach((p) => {
          if (usedIds.has(p.id)) return;
          const a = freeByUrl.get(p.data_url) || []; a.push(p); freeByUrl.set(p.data_url, a);
        });
        for (const p of local) {
          if (paired.has(p)) continue; // déjà appariée à sa ligne
          const pool = freeByUrl.get(p.dataUrl) || [];
          const sp = pool.shift();
          if (sp) { p.id = sp.id; usedIds.add(sp.id); srvIds.add(sp.id); continue; } // adopter une ligne libre
          const insRes = await supa.from("photos").insert({
            stop_id: s.id, address_id: s._addressId || null, data_url: p.dataUrl
          }).select("id").single();
          throwIfError("Photo (envoi)", insRes);
          if (!insRes.data || !insRes.data.id) throw new Error("Photo : envoi non confirmé par le serveur");
          p.id = insRes.data.id;
          usedIds.add(p.id); srvIds.add(p.id);
        }
        const localUrls = new Set(local.map((p) => p.dataUrl));
        // v24 : CONVERGENCE — toute ligne serveur non consommée
        // par l'appariement ci-dessus est un surplus et part :
        // URL absente du seau (comportement d'avant) OU doublon
        // d'une URL présente au-delà de l'effectif du seau
        // (nouveau). Avant la v24, ce deuxième cas n'était jamais
        // supprimé — un tas, une fois formé, était éternel
        // (8 284 copies sur un arrêt, 23 nov.). Avec la lecture
        // paginée complète, la prochaine réconciliation d'un
        // arrêt empilé le ramène exactement à son seau.
        for (const p of srv) {
          if (usedIds.has(p.id)) continue;
          throwIfError("Photo (suppression)", await supa.from("photos").delete().eq("id", p.id));
        }
        // VÉRIFICATION FINALE : relire et comparer les ensembles
        // ET les effectifs par URL (v24) — le serveur doit détenir
        // exactement le seau local, ni plus ni moins.
        srv = await readSrvPhotos();
        const finalUrls = new Set(srv.map((p) => p.data_url));
        const localCount = new Map();
        local.forEach((p) => localCount.set(p.dataUrl, (localCount.get(p.dataUrl) || 0) + 1));
        const finalCount = new Map();
        srv.forEach((p) => finalCount.set(p.data_url, (finalCount.get(p.data_url) || 0) + 1));
        const countMismatch = [...localCount].some(([u, n]) => (finalCount.get(u) || 0) !== n);
        if (countMismatch || finalUrls.size !== localUrls.size || [...localUrls].some((u) => !finalUrls.has(u))) {
          throw new Error("Photos de l'arrêt " + s.id + " : le serveur n'a pas l'ensemble envoyé");
        }
        okPhotos.add(sid0);
        } catch (e) {
          // v20 : échec ISOLÉ aux photos de CET arrêt — compté,
          // quarantaine possible, les autres arrêts continuent.
          failed.photos.add(sid0);
          noteFailure("photos", sid0);
          console.warn("Synchro : photos non rendues ce cycle-ci (arrêt " + sid + ") — les autres continuent.", e);
        }
      }
      persistLocal(); // garder les identifiants de photos adoptés
    } catch (e) {
      // Échec de CYCLE (une lecture globale impossible : on ne sait
      // plus ce que le serveur détient) — rien n'est tenu pour
      // rendu au-delà des confirmations déjà obtenues ci-dessous,
      // nouvel essai automatique, comme avant la v20.
      cycleError = e;
      console.warn("Synchro Supabase interrompue — les données restent sur l'appareil, nouvel essai automatique.", e);
    }
    // 5. Nettoyage : seules les entités CONFIRMÉES ce cycle-ci
    // sortent des ensembles « sales » et voient leur empreinte
    // « propre » avancer — et seulement si leur empreinte n'a pas
    // changé pendant la poussée (sinon elles restent sales et
    // repartent). v20 : les entités en échec isolé restent sales
    // (quarantaine éventuelle) sans retenir les autres.
    todoDays.forEach((date) => {
      const d = DB.days.find((x) => x.date === date);
      if (!d) { dirtyDays.delete(date); return; }
      if (!okDays.has(date)) return;
      if (fpDay0.has(date) && dayFP(d) === fpDay0.get(date)) { cleanDays.set(date, fpDay0.get(date)); dirtyDays.delete(date); noteSuccess("days", date); }
    });
    todoStops.forEach((id0) => {
      const id = adoptedMap[id0] || id0;
      const s = DB.stops.find((x) => x.id === id);
      if (!s) { dirtyStops.delete(id0); dirtyStops.delete(id); return; }
      if (staleStops.has(id0) || staleStops.has(id)) {
        // v23 : soldé par le garde-fou fraîcheur — rien n'a été
        // écrit ; l'arrêt sort des ensembles « sales » SANS que
        // son empreinte « propre » avance : le rechargement
        // demandé en fin de cycle adoptera la version serveur et
        // reconstruira l'empreinte (refreshCleanFromDB).
        dirtyStops.delete(id0); dirtyStops.delete(id);
        dirtyPhotoStops.delete(id0); dirtyPhotoStops.delete(id);
        return;
      }
      if (settledByDay.has(id0) || settledByDay.has(id)) {
        // Soldé par le garde-fou (c) : aucune écriture serveur,
        // l'état local fait foi tant que la journée est corbeillée
        // au serveur (la fusion le maintient à chaque rechargement).
        cleanStops.set(id, stopFP(s)); dirtyStops.delete(id0); dirtyStops.delete(id);
        return;
      }
      if (!okStops.has(id0) && !okStops.has(id)) return;
      if (fpStop0.has(id0) && stopFP(s) === fpStop0.get(id0)) {
        cleanStops.set(id, fpStop0.get(id0)); dirtyStops.delete(id0); dirtyStops.delete(id); noteSuccess("stops", id);
        // Suppression confirmée par le serveur : le sauf-conduit
        // explicite n'est plus nécessaire (la règle (b) couvre la
        // suite : le serveur a déjà l'arrêt à la corbeille).
        if (s.deletedAt) { explicitTrashStops.delete(id0); explicitTrashStops.delete(id); }
      }
    });
    todoPhotos.forEach((sid0) => {
      if (!okPhotos.has(sid0)) return;
      const sid = adoptedMap[sid0] || sid0;
      const s = DB.stops.find((x) => x.id === sid);
      if (!s) { dirtyPhotoStops.delete(sid0); dirtyPhotoStops.delete(sid); return; }
      if (!uuidOk(s.id)) return; // jamais parti : reste sale
      if (fpPhoto0.has(sid0) && photoFP(DB.photos[sid]) === fpPhoto0.get(sid0)) {
        cleanPhotos.set(sid, fpPhoto0.get(sid0)); dirtyPhotoStops.delete(sid0); dirtyPhotoStops.delete(sid); noteSuccess("photos", sid);
      }
    });
    persistSyncMeta();
    persistLocal();
    refreshUnpushed();
    if (cycleError || failed.days.size || failed.stops.size || failed.photos.size) {
      // Au moins un échec ce cycle-ci : état d'erreur honnête +
      // nouvel essai espacé. Les entités confirmées, elles, sont
      // bel et bien rendues (nettoyées ci-dessus).
      setSyncState("error");
      scheduleSyncRetry();
    }
    else if (actionableCount() > 0) { setSyncState("pending"); pushSupabaseSoon(); } // il reste du travail (changé pendant la poussée)
    else if (quarantineCount() > 0) setSyncState("error"); // v20 : quarantaine restante = erreur visible
    else setSyncState("ok");
    if (staleStops.size) refreshRemote(); // v23 : adopter la version serveur des arrêts bloqués par le garde-fou fraîcheur
    pushSnapshotSupabase(); // v16 : en arrière-plan — ne bloque plus la poussée
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
    // v21 : ne jamais figer un snapshot depuis une copie locale
    // ALLÉGÉE (quota — voir recomputeDirty) : si le serveur est
    // connu pour détenir des photos absentes de la copie locale
    // (empreinte propre non vide, seau vide), le snapshot serait
    // une « sauvegarde » SANS ces photos — pire que pas de
    // snapshot, car une restauration depuis lui les perdrait
    // pour de bon. Le rechargement qui suit réimporte les
    // photos ; le prochain cycle snapshottera juste.
    const missingPhotos = [...cleanPhotos.entries()].some(([sid, fp]) => fp && !(((DB || {}).photos || {})[sid] || []).length);
    if (missingPhotos) return;
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
      // v20 : idem pour la quarantaine, les compteurs et les
      // sauf-conduits corbeille.
      oldStops.forEach((s) => {
        dirtyStops.delete(s.id); dirtyPhotoStops.delete(s.id); cleanStops.delete(s.id); cleanPhotos.delete(s.id);
        delete quarantine.stops[s.id]; delete quarantine.photos[s.id];
        delete failCounts.stops[s.id]; delete failCounts.photos[s.id];
        explicitTrashStops.delete(s.id); knownDeletedStops.delete(s.id);
      });
      oldDays.forEach((d) => {
        dirtyDays.delete(d.date); cleanDays.delete(d.date);
        delete quarantine.days[d.date]; delete failCounts.days[d.date];
        explicitTrashDays.delete(d.date); knownDeletedDays.delete(d.date);
      });
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
    // v20 : une restauration est un geste explicite de
    // l'utilisateur — les suppressions qu'elle contient sont
    // légitimes aux yeux du garde-fou corbeille.
    (DB.days || []).forEach((d) => { if (d.deletedAt) explicitTrashDays.add(d.date); });
    (DB.stops || []).forEach((s) => { if (s.deletedAt) explicitTrashStops.add(s.id); });
    refreshKnownDeleted();
    // v17 : tout le contenu restauré est « sale » — il sera poussé
    // et vérifié comme du neuf.
    cleanDays.clear(); cleanStops.clear(); cleanPhotos.clear();
    recomputeDirty();
    persistLocal();
    persistSyncMeta();
    if (MODE === "supabase") { freshnessExempt = true; setSyncState("pending"); pushSupabaseNow(); }
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
        // v21 : repérer les arrêts « photos inconnues » AVANT le
        // filet — empreinte propre non vide (le serveur détient
        // des photos) mais seau local vide (copie allégée, quota).
        photoUnknownStops = new Set();
        cleanPhotos.forEach((fp, sid) => { if (fp && !((DB.photos || {})[sid] || []).length) photoUnknownStops.add(sid); });
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
      // v17 : chaque sauvegarde recalcule les ensembles « sales »
      // (empreintes) et les persiste AVANT de planifier la poussée —
      // une modification est donc suivie explicitement, jamais
      // déduite d'une comparaison rejouée plus tard.
      // v22 : recomputeDirty() AVANT persistLocal() — avant, la
      // copie locale était écrite avec les ensembles « sales »
      // d'AVANT la modification : sous quota, la copie ALLÉGÉE
      // jetait la photo qui venait d'être ajoutée (son arrêt
      // n'était pas encore marqué « photos sales »), et si la
      // confirmation du méta se perdait ensuite, plus rien ne
      // protégeait cette photo au redémarrage (voir la phase
      // photos de pushCycleLocked, garde-fou v22).
      if (MODE === "supabase") { recomputeDirty(); persistLocal(); persistSyncMeta(); setSyncState("pending"); pushSupabaseSoon(); }
      else persistLocal();
    },
    saveNow() { // synchro immédiate (ex. avant de quitter l'écran)
      if (MODE === "supabase") {
        // v20 : une demande de synchro explicite redonne une chance
        // immédiate aux entités en quarantaine. Leurs compteurs
        // d'échecs sont CONSERVÉS : si l'écriture échoue encore, la
        // quarantaine revient dès ce premier échec — pas de boucle.
        quarantine = { days: {}, stops: {}, photos: {} };
        // v22 : même ordre que save() — recalculer avant d'écrire.
        recomputeDirty(); persistLocal(); persistSyncMeta(); setSyncState("pending"); pushSupabaseNow();
      } else persistLocal();
    },
    /* v16 : l'interface affiche l'état réel de la synchro. */
    setSyncListener(fn) { onSyncState = fn; if (fn) { try { fn(syncState); } catch (e) { /* affichage */ } } },
    get syncState() { return syncState; },
    /* v20 : diagnostics — cette fenêtre détient-elle le verrou de
       synchro, et quelles entités sont en quarantaine (l'état
       « error » visible dans l'en-tête les reflète). */
    get syncLockHeld() { return syncLockHeld; },
    get syncErrors() {
      return { days: Object.keys(quarantine.days), stops: Object.keys(quarantine.stops), photos: Object.keys(quarantine.photos) };
    },
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
