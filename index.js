export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/me") {
      const cookie = request.headers.get("Cookie") || "";
      const session = cookie.match(/session=([^;]+)/)?.[1];
      if (!session) return new Response("Unauthorized", { status: 401 });
      const user = await env.DB.prepare("SELECT * FROM users WHERE discord_id = ?").bind(session).first();
      return Response.json(user || {});
    }
    if (url.pathname === "/api/tickets") {
      const tickets = await env.DB.prepare("SELECT * FROM ticket_configs WHERE enabled = 1").all();
      return Response.json(tickets.results);
    }
    if (url.pathname === "/api/auth/callback") {
      return new Response("Auth callback - à compléter", { status: 200 });
    }
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
<p>Site en maintenance</p>
<a href="https://discord.com/oauth2/authorize?client_id=1572922433822924830&redirect_uri=https%3A%2F%2Fticket-akihara.nhdmpnf4jr.workers.dev%2Fapi%2Fauth%2Fcallback&response_type=code&scope=identify%20guilds">
<button style="padding:15px 30px;background:#5865F2;color:white;border:none;border-radius:10px;font-size:16px">Se connecter avec Discord</button>
</a>
</body>
</html>`, { headers: { "Content-Type": "text/html" } });
  }
};
