// Vite injects VITE_-prefixed env at build. VITE_MAPBOX_TOKEN opts the map onto the owner's Mapbox
// tiles (evaluation / promo); unset ⇒ the self-hosted default (REQ-075). Never committed — see .env.example.
interface ImportMetaEnv {
  readonly VITE_MAPBOX_TOKEN?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
