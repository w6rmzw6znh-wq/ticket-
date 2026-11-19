# SCRATCH CLUB 🎟️

Plateforme de tickets à gratter virtuelle liée à Discord.  
Hébergée gratuitement sur Cloudflare Workers + D1.

## Mise en place via GitHub (recommandé)

### 1. Créer le dépôt GitHub
1. Va sur [github.com](https://github.com) et connecte-toi.
2. Clique sur **New repository**.
3. Nom : `scratch-club` (ou ce que tu veux).
4. Public ou Private → Create repository.

### 2. Uploader les fichiers
Depuis ton téléphone ou ordinateur :
- Clique sur **Add file** → **Upload files**.
- Glisse-dépose **tous les fichiers et dossiers** de ce projet :
  - `.github/`
  - `src/`
  - `.gitignore`
  - `package.json`
  - `README.md`
  - `schema.sql`
  - `wrangler.toml`
- Commit → **Commit changes**.

### 3. Préparer Cloudflare + Discord
Suis les étapes du guide ci-dessous pour :
- Créer l’application Discord
- Créer la base D1
- Récupérer tous les IDs et tokens

### 4. Déployer automatiquement (optionnel mais pratique)
1. Dans Cloudflare Dashboard → **My Profile** → **API Tokens** → Create Token.
2. Utilise le template **Edit Cloudflare Workers**.
3. Copie le token.
4. Sur GitHub → ton repo → **Settings** → **Secrets and variables** → **Actions**.
5. Ajoute deux secrets :
   - `CLOUDFLARE_API_TOKEN` → le token
   - `CLOUDFLARE_ACCOUNT_ID` → ton Account ID (visible dans le dashboard Cloudflare à droite)
6. Chaque push sur `main` déploiera automatiquement.

### 5. Configurer les variables
Dans le dashboard Cloudflare du Worker :
- Variables : `DISCORD_CLIENT_ID`, `GUILD_ID`, `ADMIN_DISCORD_ID`
- Secrets : `DISCORD_CLIENT_SECRET`, `DISCORD_BOT_TOKEN`, `SESSION_SECRET`
- Binding D1 : `DB`

---

## Configuration détaillée

### Discord
1. [discord.com/developers/applications](https://discord.com/developers/applications) → New Application.
2. OAuth2 → Redirects : `https://TON-WORKER.workers.dev/api/auth/callback`
3. Copie Client ID + Client Secret.
4. Onglet Bot → Create bot → copie le Token.
5. Invite le bot sur ton serveur avec la permission **Manage Roles**.

### IDs nécessaires
- **Guild ID** : Mode développeur Discord → clic droit serveur → Copier l’ID
- **Ton Discord ID** (admin) : clic droit sur ton pseudo → Copier l’ID

### Base de données D1
1. Cloudflare → Workers & Pages → D1 → Create database → `scratch-club-db`
2. Console → colle le contenu de `schema.sql` et exécute.
3. Copie le Database ID et mets-le dans `wrangler.toml` (ou lie-le dans le dashboard).

---

## Tester
1. Ouvre l’URL de ton Worker.
2. Clique **Se connecter avec Discord**.
3. Tu arrives avec 50 000 jetons de test.
4. Achète et gratte des tickets.

## Notes
- Version de test avec jetons fictifs.
- Le lot spécial (0,01 %) ne montre pas le nom du rôle publiquement.
- Résultats 100 % déterminés côté serveur.
- Architecture prête pour connecter plus tard ton vrai système de jetons.

Besoin d’aide ? Dis-moi où tu bloques.
