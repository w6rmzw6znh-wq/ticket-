export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/auth/callback") {
      try {
        const code = url.searchParams.get("code");
        if (!code) return new Response("No code", { status: 400 });
        const tokenRes = await fetch("https://discord.com/api/oauth2/token", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_id: env.DISCORD_CLIENT_ID,
            client_secret: env.DISCORD_CLIENT_SECRET,
            grant_type: "authorization_code",
            code,
            redirect_uri: "https://ticket-akihara.nhdmpnf4jr.workers.dev/api/auth/callback"
          })
        });
        const token = await tokenRes.json();
        if (token.error) return new Response("Token error: " + JSON.stringify(token), { status: 400 });
        const userRes = await fetch("https://discord.com/api/users/@me", { headers: { Authorization: "Bearer " + token.access_token } });
        const user = await userRes.json();
        const guildRes = await fetch("https://discord.com/api/users/@me/guilds", { headers: { Authorization: "Bearer " + token.access_token } });
        const guilds = await guildRes.json();
        if (!Array.isArray(guilds)) return new Response("Guilds error: " + JSON.stringify(guilds), { status: 400 });
        if (!guilds.some(g => g.id === env.GUILD_ID)) return new Response("Not in server", { status: 403 });
        await env.DB.prepare("INSERT INTO users (discord_id, username, avatar, balance) VALUES (?, ?, ?, 50000) ON CONFLICT(discord_id) DO UPDATE SET username = ?, avatar = ?").bind(user.id, user.username, user.avatar, user.username, user.avatar).run();
        return new Response(null, { status: 302, headers: { Location: "/", "Set-Cookie": "session=" + user.id + "; Path=/; HttpOnly; Secure; SameSite=Lax" } });
      } catch (e) {
        return new Response("Callback error: " + e.message, { status: 500 });
      }
    }
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
    return new Response(`<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>AKIHARA</title>
<style>
body{margin:0;background:#000;color:#fff;font-family:Arial;text-align:center;padding:40px}
.logo{color:#FFD700;font-size:32px;font-weight:bold}
</style>
</head>
<body>
<div class="logo">🎟️ AKIHARA</div>
<p>Site en ligne</p>
<a href="https://discord.com/oauth2/authorize?client_id=1572922433822924830&redirect_uri=https%3A%2F%2Fticket-akihara.nhdmpnf4jr.workers.dev%2Fapi%2Fauth%2Fcallback&response_type=code&scope=identify%20guilds">
<button style="padding:15px 30px;background:#5865F2;color:white;border:none;border-radius:10px;font-size:16px">Se connecter avec Discord</button>
</a>
</body>
</html>`, { headers: { "Content-Type": "text/html" } });
  }
};
