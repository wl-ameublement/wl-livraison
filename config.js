/* ============================================================
   WL Livraison — Configuration
   ------------------------------------------------------------
   À REMPLIR après la création du compte Supabase gratuit
   (voir README.md, section « Mise en ligne »).

   Tant que SUPABASE_URL et SUPABASE_ANON_KEY sont vides,
   l'application fonctionne en MODE DÉMO LOCAL : les données
   sont gardées dans le téléphone (localStorage), sans synchro
   entre les utilisateurs. Dès que les deux valeurs sont
   remplies, l'app se connecte à Supabase (chacun sa connexion,
   synchro en temps réel entre les 4 utilisateurs).
   ============================================================ */
window.WL_CONFIG = {
  SUPABASE_URL: "https://zczpabrkhmczgfluwdva.supabase.co",
  SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpjenBhYnJraG1jemdmbHV3ZHZhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTUxOTYwMzQsImV4cCI6MjExMDc3MjAzNH0.eJGcdNyG7q_wAJ48-mT5S2OjujZqQT5BAwvjBcYHt6s",   // clé "anon public" du projet Supabase (clé publiable moderne équivalente : sb_publishable_CUOIOTZ9pCeSDu6_ecxB1Q_yQS_nKPz)

  /* Entrepôt — départ et retour de chaque journée */
  WAREHOUSE: {
    label: "540 Rue de l'Argon, Charlesbourg, Québec, G2N 2E1",
    lat: 46.8580,
    lng: -71.2720
  },

  /* Heure de départ par défaut d'une journée */
  START_TIME: "08:00",

  /* Clé Google Maps Platform (Places API) — recherche d'adresses.
     Clé restreinte au domaine de l'app + Places API seulement.
     Vide = repli automatique sur Photon (OpenStreetMap, gratuit). */
  GOOGLE_MAPS_KEY: "AIzaSyB7yMlH5cDdX7nmqtXpjOPS1Z26sboVWnE",

  /* Les 4 utilisateurs (sièges) de l'application */
  PROFILES: ["William", "Loucas", "Zach", "Mahmoud"]
};
