# ZOMBIE MINE

Telegram Mini App game — a rebranded clone of the VIKING Miner build, fully independent:
its own repository, its own Render server, its own database and bot. Coin: **ZM**.

- Frontend (this repo root): static Mini App, served by GitHub Pages.
- Server (`server/`): Node functions-framework app (`--target=collectMining`), deployed on Render.
- Before launch the server needs its own env: BOT_TOKEN (new bot), DB_BACKEND=supabase,
  SUPABASE_REST_URL + SUPABASE_SERVICE_KEY (new Supabase project), OWNER_ID,
  ADMIN_PANEL_KEY, TONAPI_KEY / TONCENTER_KEYS, PAYOUT_MNEMONIC (new payout wallet).
- The ZM jetton address is a placeholder (TON zero address) in server/index.js (const JETTON)
  and in the frontend until the real ZM jetton is deployed.
