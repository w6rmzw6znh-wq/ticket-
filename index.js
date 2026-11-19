export default {
  async fetch(request, env) {
    return new Response(`<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>SCRATCH CLUB</title>
<style>
body{margin:0;background:#000;color:#fff;font-family:Arial;text-align:center;padding:40px}
.logo{color:#FFD700;font-size:32px;font-weight:bold}
</style>
</head>
<body>
<div class="logo">🎟️ SCRATCH CLUB</div>
<p>Site en ligne</p>
<a href="https://discord.com/oauth2/authorize?client_id=1572922433822924830&redirect_uri=https%3A%2F%2Fticket-akihara.nhdmpnf4jr.workers.dev%2Fapi%2Fauth%2Fcallback&response_type=code&scope=identify%20guilds">
<button style="padding:15px 30px;background:#5865F2;color:white;border:none;border-radius:10px;font-size:16px">Se connecter avec Discord</button>
</a>
</body>
</html>`, { headers: { "Content-Type": "text/html" } });
  }
};
