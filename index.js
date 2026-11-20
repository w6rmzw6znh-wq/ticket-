export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/logout") {
      return new Response(null, { status: 302, headers: { Location: "/", "Set-Cookie": "session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0" } });
    }
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
        if (!tokenRes.ok || !token.access_token) return new Response("Token error: " + JSON.stringify(token), { status: 400 });
        const userRes = await fetch("https://discord.com/api/users/@me", { headers: { Authorization: "Bearer " + token.access_token } });
        const user = await userRes.json();
        if (!user.id) return new Response("Discord user error", { status: 400 });
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
      return Response.json(tickets.results || []);
    }
    if (url.pathname === "/api/leaderboard") {
      const leaders = await env.DB.prepare("SELECT username, balance, total_won FROM users ORDER BY total_won DESC LIMIT 10").all();
      return Response.json(leaders.results || []);
    }
    if (url.pathname === "/api/admin/players") {
      const cookie = request.headers.get("Cookie") || "";
      const session = cookie.match(/session=([^;]+)/)?.[1];
      if (!session || session !== env.ADMIN_DISCORD_ID) return new Response("Forbidden", { status: 403 });
      const players = await env.DB.prepare("SELECT discord_id, username, balance FROM users ORDER BY balance DESC").all();
      return Response.json(players.results || []);
    }
    if (url.pathname === "/api/discord-shop") {
      const items = await env.DB.prepare("SELECT * FROM discord_shop WHERE stock > 0").all();
      return Response.json(items.results || []);
    }
    if (url.pathname === "/api/buy-discord" && request.method === "POST") {
      const cookie = request.headers.get("Cookie") || "";
      const session = cookie.match(/session=([^;]+)/)?.[1];
      if (!session) return new Response("Unauthorized", { status: 401 });
      let body;
      try { body = await request.json(); } catch { return Response.json({ error: "Requête invalide" }, { status: 400 }); }
      const itemId = Number(body.id);
      if (!Number.isInteger(itemId) || itemId <= 0) return Response.json({ error: "Article invalide" }, { status: 400 });
      if (!env.DISCORD_BOT_TOKEN || !env.GUILD_ID) return Response.json({ error: "Configuration Discord manquante" }, { status: 500 });
      const item = await env.DB.prepare("SELECT * FROM discord_shop WHERE id = ? AND stock > 0").bind(itemId).first();
      if (!item) return Response.json({ error: "Article indisponible" }, { status: 400 });
      const user = await env.DB.prepare("SELECT * FROM users WHERE discord_id = ?").bind(session).first();
      if (!user) return Response.json({ error: "Utilisateur introuvable" }, { status: 404 });
      const stockUpdate = await env.DB.prepare("UPDATE discord_shop SET stock = stock - 1 WHERE id = ? AND stock > 0").bind(itemId).run();
      if (!stockUpdate.meta || stockUpdate.meta.changes !== 1) return Response.json({ error: "Article épuisé" }, { status: 400 });
      const debit = await env.DB.prepare("UPDATE users SET balance = balance - ? WHERE discord_id = ? AND balance >= ?").bind(item.price, session, item.price).run();
      if (!debit.meta || debit.meta.changes !== 1) {
        await env.DB.prepare("UPDATE discord_shop SET stock = stock + 1 WHERE id = ?").bind(itemId).run();
        return Response.json({ error: "Pas assez de jetons" }, { status: 400 });
      }
      const staffRole = env.STAFF_ROLE_ID || "1555283320508780757";
      const botId = "1572922433822924830";
      const overwrites = [
        { id: env.GUILD_ID, type: 0, deny: "1024" },
        { id: session, type: 1, allow: "68608" },
        { id: staffRole, type: 0, allow: "68608" },
        { id: botId, type: 1, allow: "68608" }
      ];
      const safeName = String(user.username || "membre").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "membre";
      let ticketRes;
      try {
        ticketRes = await fetch("https://discord.com/api/v10/guilds/" + env.GUILD_ID + "/channels", {
          method: "POST",
          headers: { "Authorization": "Bot " + env.DISCORD_BOT_TOKEN, "Content-Type": "application/json" },
          body: JSON.stringify({ name: "ticket-" + safeName, type: 0, parent_id: "1571511806340497598", permission_overwrites: overwrites })
        });
      } catch (e) {
        await env.DB.prepare("UPDATE users SET balance = balance + ? WHERE discord_id = ?").bind(item.price, session).run();
        await env.DB.prepare("UPDATE discord_shop SET stock = stock + 1 WHERE id = ?").bind(itemId).run();
        return Response.json({ error: "Erreur de connexion à Discord : " + e.message }, { status: 502 });
      }
      if (!ticketRes.ok) {
        const error = await ticketRes.text();
        await env.DB.prepare("UPDATE users SET balance = balance + ? WHERE discord_id = ?").bind(item.price, session).run();
        await env.DB.prepare("UPDATE discord_shop SET stock = stock + 1 WHERE id = ?").bind(itemId).run();
        return Response.json({ error: "Impossible de créer le ticket", details: error }, { status: 502 });
      }
      const ticket = await ticketRes.json();
      const orderDate = new Date().toLocaleString("fr-FR", { timeZone: "Europe/Paris" });
      let messageRes;
      try {
        messageRes = await fetch("https://discord.com/api/v10/channels/" + ticket.id + "/messages", {
          method: "POST",
          headers: { "Authorization": "Bot " + env.DISCORD_BOT_TOKEN, "Content-Type": "application/json" },
          body: JSON.stringify({
            content: "Nouvelle commande AKIHARA !\n<@" + session + "> <@&" + staffRole + ">",
            embeds: [{
              title: "Details de la commande",
              color: 0x7c3aed,
              fields: [
                { name: "Article", value: String(item.name), inline: false },
                { name: "Prix", value: Number(item.price).toLocaleString("fr-FR") + " jetons", inline: true },
                { name: "Client", value: String(user.username), inline: true },
                { name: "ID Discord", value: session, inline: false },
                { name: "Date", value: orderDate, inline: false },
                { name: "Statut", value: "En attente", inline: false }
              ],
              footer: { text: "AKIHARA" },
              timestamp: new Date().toISOString()
            }],
            allowed_mentions: { parse: [], users: [session], roles: [staffRole] }
          })
        });
      } catch (e) {}
      const updatedUser = await env.DB.prepare("SELECT balance FROM users WHERE discord_id = ?").bind(session).first();
      return Response.json({ success: true, ticketId: ticket.id, newBalance: updatedUser.balance, messageSent: Boolean(messageRes && messageRes.ok) });
    }
    if (url.pathname === "/api/buy" && request.method === "POST") {
      const cookie = request.headers.get("Cookie") || "";
      const session = cookie.match(/session=([^;]+)/)?.[1];
      if (!session) return new Response("Unauthorized", { status: 401 });
      let body;
      try { body = await request.json(); } catch { return Response.json({ error: "Requête invalide" }, { status: 400 }); }
      const ticket = await env.DB.prepare("SELECT * FROM ticket_configs WHERE type = ?").bind(body.type).first();
      if (!ticket) return Response.json({ error: "Ticket introuvable" }, { status: 404 });
      const user = await env.DB.prepare("SELECT * FROM users WHERE discord_id = ?").bind(session).first();
      if (!user) return Response.json({ error: "Utilisateur introuvable" }, { status: 404 });
      if (user.balance < ticket.price) return Response.json({ error: "Pas assez de jetons" }, { status: 400 });
      const debit = await env.DB.prepare("UPDATE users SET balance = balance - ? WHERE discord_id = ? AND balance >= ?").bind(ticket.price, session, ticket.price).run();
      if (!debit.meta || debit.meta.changes !== 1) return Response.json({ error: "Pas assez de jetons" }, { status: 400 });
      let probs;
      try { probs = JSON.parse(ticket.probabilities || "[]"); } catch { return Response.json({ error: "Configuration des probabilités invalide" }, { status: 500 }); }
      let rand = Math.random() * 100;
      let win = 0;
      for (const p of probs) { rand -= p.chance; if (rand <= 0) { win = p.amount || 0; break; } }
      if (win > 0) {
        await env.DB.prepare("UPDATE users SET balance = balance + ?, total_won = total_won + ? WHERE discord_id = ?").bind(win, win, session).run();
        if (env.DISCORD_BOT_TOKEN) {
          await fetch("https://discord.com/api/v10/channels/1572952017846927452/messages", {
            method: "POST",
            headers: { "Authorization": "Bot " + env.DISCORD_BOT_TOKEN, "Content-Type": "application/json" },
            body: JSON.stringify({ content: "<@" + session + "> a gagne **" + win + "** jetons sur AKIHARA !" })
          });
        }
      }
      await env.DB.prepare("UPDATE users SET tickets_scratched = tickets_scratched + 1 WHERE discord_id = ?").bind(session).run();
      return Response.json({ win, newBalance: user.balance - ticket.price + win, ticketName: ticket.name });
    }
    if (url.pathname === "/api/free" && request.method === "POST") {
      const cookie = request.headers.get("Cookie") || "";
      const session = cookie.match(/session=([^;]+)/)?.[1];
      if (!session) return new Response("Unauthorized", { status: 401 });
      const user = await env.DB.prepare("SELECT * FROM users WHERE discord_id = ?").bind(session).first();
      if (!user) return Response.json({ error: "Utilisateur introuvable" }, { status: 404 });
      const now = Math.floor(Date.now() / 1000);
      if (user.last_free_ticket && now - user.last_free_ticket < 86400) {
        return Response.json({ error: "Ticket gratuit disponible dans " + Math.ceil((86400 - (now - user.last_free_ticket)) / 3600) + "h" }, { status: 400 });
      }
      await env.DB.prepare("UPDATE users SET last_free_ticket = ? WHERE discord_id = ?").bind(now, session).run();
      const win = Math.random() < 0.5 ? Math.floor(Math.random() * 500) + 100 : 0;
      if (win > 0) {
        await env.DB.prepare("UPDATE users SET balance = balance + ?, total_won = total_won + ? WHERE discord_id = ?").bind(win, win, session).run();
        if (env.DISCORD_BOT_TOKEN) {
          await fetch("https://discord.com/api/v10/channels/1572952017846927452/messages", {
            method: "POST",
            headers: { "Authorization": "Bot " + env.DISCORD_BOT_TOKEN, "Content-Type": "application/json" },
            body: JSON.stringify({ content: "<@" + session + "> a gagne **" + win + "** jetons avec le ticket gratuit !" })
          });
        }
      }
      return Response.json({ win, newBalance: user.balance + win });
    }
    if (url.pathname === "/api/roulette" && request.method === "POST") {
      const cookie = request.headers.get("Cookie") || "";
      const session = cookie.match(/session=([^;]+)/)?.[1];
      if (!session) return new Response("Unauthorized", { status: 401 });
      const user = await env.DB.prepare("SELECT * FROM users WHERE discord_id = ?").bind(session).first();
      if (!user) return Response.json({ error: "Utilisateur introuvable" }, { status: 404 });
      const now = Math.floor(Date.now() / 1000);
      if (session !== env.ADMIN_DISCORD_ID) {
        if (user.last_roulette && now - user.last_roulette < 86400) {
          return Response.json({ error: "Roulette disponible dans " + Math.ceil((86400 - (now - user.last_roulette)) / 3600) + "h" }, { status: 400 });
        }
        await env.DB.prepare("UPDATE users SET last_roulette = ? WHERE discord_id = ?").bind(now, session).run();
      }
      const win = Math.floor(Math.random() * 49500) + 500;
      await env.DB.prepare("UPDATE users SET balance = balance + ?, total_won = total_won + ? WHERE discord_id = ?").bind(win, win, session).run();
      if (env.DISCORD_BOT_TOKEN) {
        await fetch("https://discord.com/api/v10/channels/1572952017846927452/messages", {
          method: "POST",
          headers: { "Authorization": "Bot " + env.DISCORD_BOT_TOKEN, "Content-Type": "application/json" },
          body: JSON.stringify({ content: "<@" + session + "> a gagne **" + win + "** jetons a la roulette !" })
        });
      }
      return Response.json({ win, newBalance: user.balance + win });
    }
    if (url.pathname === "/api/bj-result" && request.method === "POST") {
      const cookie = request.headers.get("Cookie") || "";
      const session = cookie.match(/session=([^;]+)/)?.[1];
      if (!session) return new Response("Unauthorized", { status: 401 });
      let body;
      try { body = await request.json(); } catch { return Response.json({ error: "Requête invalide" }, { status: 400 }); }
      const change = Number(body.change);
      if (!Number.isSafeInteger(change)) return Response.json({ error: "Montant invalide" }, { status: 400 });
      const user = await env.DB.prepare("SELECT balance FROM users WHERE discord_id = ?").bind(session).first();
      if (!user) return Response.json({ error: "Utilisateur introuvable" }, { status: 404 });
      if (user.balance + change < 0) return Response.json({ error: "Solde insuffisant" }, { status: 400 });
      await env.DB.prepare("UPDATE users SET balance = balance + ? WHERE discord_id = ?").bind(change, session).run();
      const updated = await env.DB.prepare("SELECT balance FROM users WHERE discord_id = ?").bind(session).first();
      return Response.json({ success: true, newBalance: updated.balance });
    }
    if (url.pathname === "/api/roulette-spin" && request.method === "POST") {
      const cookie = request.headers.get("Cookie") || "";
      const session = cookie.match(/session=([^;]+)/)?.[1];
      if (!session) return new Response("Unauthorized", { status: 401 });
      let body;
      try { body = await request.json(); } catch { return Response.json({ error: "Requête invalide" }, { status: 400 }); }
      const bets = body.bets || [];
      const totalBet = bets.reduce((s, b) => s + (b.amount || 0), 0);
      if (totalBet <= 0) return Response.json({ error: "Aucune mise" }, { status: 400 });
      const user = await env.DB.prepare("SELECT balance FROM users WHERE discord_id = ?").bind(session).first();
      if (!user || user.balance < totalBet) return Response.json({ error: "Solde insuffisant" }, { status: 400 });
      await env.DB.prepare("UPDATE users SET balance = balance - ? WHERE discord_id = ?").bind(totalBet, session).run();
      const result = Math.floor(Math.random() * 37);
      let winAmount = 0;
      const red = [1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36];
      for (const b of bets) {
        let mult = 0;
        if (b.type === "number" && b.value === result) mult = 36;
        else if (b.type === "red" && red.includes(result)) mult = 2;
        else if (b.type === "black" && result !== 0 && !red.includes(result)) mult = 2;
        else if (b.type === "even" && result !== 0 && result % 2 === 0) mult = 2;
        else if (b.type === "odd" && result % 2 === 1) mult = 2;
        else if (b.type === "low" && result >= 1 && result <= 18) mult = 2;
        else if (b.type === "high" && result >= 19 && result <= 36) mult = 2;
        else if (b.type === "dozen1" && result >= 1 && result <= 12) mult = 3;
        else if (b.type === "dozen2" && result >= 13 && result <= 24) mult = 3;
        else if (b.type === "dozen3" && result >= 25 && result <= 36) mult = 3;
        if (mult > 0) winAmount += b.amount * mult;
      }
      if (winAmount > 0) {
        await env.DB.prepare("UPDATE users SET balance = balance + ?, total_won = total_won + ? WHERE discord_id = ?").bind(winAmount, winAmount, session).run();
      }
      const updated = await env.DB.prepare("SELECT balance FROM users WHERE discord_id = ?").bind(session).first();
      return Response.json({ result, winAmount, newBalance: updated.balance });
    }
    if (url.pathname === "/api/admin/set-tokens" && request.method === "POST") {
      const cookie = request.headers.get("Cookie") || "";
      const session = cookie.match(/session=([^;]+)/)?.[1];
      if (!session || session !== env.ADMIN_DISCORD_ID) return new Response("Forbidden", { status: 403 });
      let body;
      try { body = await request.json(); } catch { return Response.json({ error: "Requête invalide" }, { status: 400 }); }
      const amount = Number(body.amount);
      if (!body.userId || !Number.isSafeInteger(amount) || amount <= 0) return Response.json({ error: "Montant ou utilisateur invalide" }, { status: 400 });
      const result = await env.DB.prepare("UPDATE users SET balance = balance + ? WHERE discord_id = ?").bind(amount, body.userId).run();
      if (!result.meta || result.meta.changes !== 1) return Response.json({ error: "Joueur introuvable" }, { status: 404 });
      return Response.json({ success: true });
    }
    return new Response(HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } });
  }
};

const HTML = `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>AKIHARA</title>
<style>
body{margin:0;background:#0f0b1e;color:#fff;font-family:system-ui,Arial;min-height:100vh;display:flex;flex-direction:column}
.header{text-align:center;padding:12px 10px;background:#0f0b1e;border-bottom:1px solid #2a2040}
.logo{color:#a78bfa;font-size:22px;font-weight:bold}
.user-bar{display:flex;flex-wrap:wrap;justify-content:center;align-items:center;gap:8px;margin-top:8px;font-size:15px}
.balance{background:#1a1430;border:1px solid #3b2f5e;padding:6px 16px;border-radius:20px;font-weight:bold;font-size:16px}
.nav{display:flex;flex-wrap:wrap;gap:8px;justify-content:center;padding:10px}
.nav button{padding:10px 16px;background:#1a1430;color:#c4b5fd;border:1px solid #3b2f5e;border-radius:10px;font-weight:600;font-size:13px}
.container{width:100%;padding:10px;box-sizing:border-box;flex:1;overflow-y:auto}
.grid{display:grid;grid-template-columns:repeat(2,1fr);gap:10px;margin-top:10px}
.card{background:#16122a;border:1px solid #2a2040;border-radius:14px;padding:12px;text-align:center}
.card img{width:100%;border-radius:10px;margin-bottom:8px}
.price{font-size:16px;color:#c4b5fd;margin:6px 0;font-weight:bold}
.btn{padding:10px 18px;background:#7c3aed;color:#fff;border:none;border-radius:10px;font-weight:bold;cursor:pointer;font-size:14px}
.scratch-area{width:260px;height:150px;margin:12px auto;background:#1a1430;border-radius:14px;position:relative;overflow:hidden;touch-action:none}
canvas{position:absolute;inset:0;width:100%;height:100%;cursor:pointer;z-index:2}
.scratch-result{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:26px;font-weight:bold;color:#c4b5fd;z-index:1}
.bj-table{background:#1a1430;border:2px solid #7c3aed;border-radius:16px;padding:16px;margin-top:12px}
.bj-hand{min-height:90px;display:flex;gap:6px;justify-content:center;flex-wrap:wrap;margin:8px 0}
.bj-card{width:58px;height:80px;background:linear-gradient(145deg,#fff,#f0f0f0);color:#1a1430;border-radius:8px;font-weight:bold;font-size:20px;display:flex;align-items:center;justify-content:center;box-shadow:0 4px 10px rgba(0,0,0,.5);position:relative}
.bj-card.red{color:#e11d48}
.bj-card.hidden{background:linear-gradient(145deg,#7c3aed,#5b21b6);color:#7c3aed}
.bj-score{text-align:center;font-size:13px;color:#c4b5fd;margin-top:4px}
.bj-actions{display:flex;gap:8px;justify-content:center;flex-wrap:wrap;margin-top:14px}
.game-card{background:#16122a;border:1px solid #2a2040;border-radius:14px;padding:12px;text-align:center;cursor:pointer}
.game-card:hover{border-color:#7c3aed}
.game-card img{width:100%;border-radius:10px;margin-bottom:8px}
.wheel-wrap{position:relative;width:260px;height:260px;margin:16px auto}
.wheel{width:100%;height:100%;border-radius:50%;border:12px solid #2a2040;position:relative;background:#0a0a0a;transition:transform 5s cubic-bezier(0.15,0.8,0.3,1);box-shadow:0 0 20px rgba(124,58,237,.4)}
.wheel-inner{position:absolute;inset:18%;border-radius:50%;background:#0f0b1e;border:4px solid #1a1430}
.wheel-num{position:absolute;font-size:11px;font-weight:bold;color:#fff;transform-origin:center;width:24px;text-align:center}
.ball{position:absolute;width:16px;height:16px;background:#fff;border-radius:50%;top:10px;left:50%;transform:translateX(-50%);box-shadow:0 0 10px #fff;z-index:10}
.bet-table{display:grid;grid-template-columns:repeat(3,1fr);gap:4px;margin:10px 0;font-size:12px}
.bet-cell{padding:10px 4px;background:#1a1430;border:1px solid #3b2f5e;border-radius:6px;text-align:center;cursor:pointer;position:relative;min-height:38px}
.bet-cell.red{background:#7f1d1d}
.bet-cell.black{background:#1a1a1a}
.bet-cell.green{background:#14532d}
.chip-on{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);background:#f59e0b;color:#1a1430;border-radius:50%;width:24px;height:24px;font-size:10px;font-weight:bold;display:flex;align-items:center;justify-content:center;box-shadow:0 2px 6px rgba(0,0,0,.5);z-index:2}
.chips{display:flex;gap:6px;justify-content:center;flex-wrap:wrap;margin:8px 0}
.chip{padding:8px 14px;background:#7c3aed;border-radius:20px;cursor:pointer;font-weight:bold;font-size:13px}
.chip.selected{background:#a78bfa;color:#1a1430}
.footer{text-align:center;padding:8px;font-size:12px;color:#6b7280;border-top:1px solid #1a1430;flex-shrink:0}
</style>
</head>
<body>
<div class="header">
  <div class="logo">AKIHARA</div>
  <div id="userInfo" class="user-bar"></div>
</div>
<div class="nav" id="nav"></div>
<div class="container" id="content"></div>
<div class="footer">by zerr</div>
<script>
let user = null;
const images = {
  free: "https://cdn.discordapp.com/attachments/1571623648303783942/1572966832120406046/IMG_2823.png?ex=6b004b05&is=6afef985&hm=4ffd3ecead972644f8e6b4e68c4a3f1a667c6738a516bf06930edd337724505a&",
  bronze: "https://cdn.discordapp.com/attachments/1571623648303783942/1572966264299585566/IMG_2819.png?ex=6b004a7d&is=6afef8fd&hm=49cece172187d1aeaa715771dada4d43531a022784af6deaee2c0b05dec8b0ee&",
  silver: "https://cdn.discordapp.com/attachments/1571623648303783942/1572966456185061518/IMG_2820.png?ex=6b004aab&is=6afef92b&hm=f70b7d4c70d0628834d0903df906261f7782ba85d5459b1d17a3c064bf050087&",
  gold: "https://cdn.discordapp.com/attachments/1571623648303783942/1572966585101058178/IMG_2821.png?ex=6b004aca&is=6afef94a&hm=061d249def798ff2b0e2d4792ec2c9e50c5af8fb60565a18ae2b8db8023cac50&",
  diamond: "https://cdn.discordapp.com/attachments/1571623648303783942/1572966713069412513/IMG_2822.png?ex=6b004ae8&is=6afef968&hm=ebf7dd60b3ec05e63204dd3204ee2ac7184e9f137917a0fb79eb167d83437289&",
  blackjack: "https://cdn.discordapp.com/attachments/1571623648303783942/1573114784465817741/IMG_2876.png?ex=6b00d4cf&is=6aff834f&hm=c7012eb926d0ff1fb2751337d9f4e1a52c9e6ab531c1d82ac5385594eee1e566&",
  roulette: "https://cdn.discordapp.com/attachments/1571623648303783942/1573269410393751623/IMG_2880.png?ex=6b0164d1&is=6b001351&hm=7660cbe0d2604852e5f870bc69eed1aa733fe186ecf991811351caff90718644&"
};
async function init() {
  try {
    const res = await fetch("/api/me");
    if (res.ok) user = await res.json();
  } catch(e) {}
  if (user && user.discord_id) { renderNav(); loadBoutique(); }
  else showLogin();
}
function showLogin() {
  document.getElementById("content").innerHTML = '<div style="text-align:center;padding:30px 15px;max-width:420px;margin:0 auto"><h1 style="color:#a78bfa;font-size:28px;margin:0 0 6px;font-weight:700">AKIHARA</h1><p style="color:#9ca3af;font-size:14px;margin:0 0 24px">Tickets a gratter • Jeux • Classement</p><div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:24px"><div class="card">Tickets</div><div class="card">Jeux</div><div class="card">Classement</div><div class="card">Gratuit</div></div><a href="https://discord.com/oauth2/authorize?client_id=1572922433822924830&redirect_uri=https%3A%2F%2Fticket-akihara.nhdmpnf4jr.workers.dev%2Fapi%2Fauth%2Fcallback&response_type=code&scope=identify%20guilds"><button class="btn" style="width:100%;padding:14px;font-size:15px;border-radius:12px">Se connecter avec Discord</button></a><p style="margin-top:16px;font-size:12px;color:#6b7280">by zerr</p></div>';
}
function renderNav() {
  document.getElementById("userInfo").innerHTML = user.username + ' <span class="balance">' + user.balance + ' jetons</span> <button onclick="logout()" style="padding:4px 10px;background:#1a1430;color:#c4b5fd;border:1px solid #3b2f5e;border-radius:8px;font-size:12px">Deconnexion</button>';
  document.getElementById("nav").innerHTML = '<button onclick="loadBoutique()">Boutique</button><button onclick="loadDiscordShop()">Boutique Discord</button><button onclick="loadJeux()">Jeux</button><button onclick="loadLeaderboard()">Classement</button><button onclick="loadRouletteDaily()">Roulette Quotidienne</button><button onclick="loadAdmin()">Admin</button>';
}
function loadJeux() {
  document.getElementById("content").innerHTML = '<h2 style="text-align:center;color:#a78bfa;font-size:20px;margin:8px 0">Jeux</h2><div class="grid"><div class="game-card" onclick="loadBlackjack()"><img src="' + images.blackjack + '"><h3 style="color:#c4b5fd">Blackjack</h3><p style="font-size:13px;color:#9ca3af;margin:6px 0">Joue contre le dealer</p><button class="btn">Jouer</button></div><div class="game-card" onclick="loadRouletteGame()"><img src="' + images.roulette + '"><h3 style="color:#c4b5fd">Roulette</h3><p style="font-size:13px;color:#9ca3af;margin:6px 0">Roue européenne</p><button class="btn">Jouer</button></div></div>';
}
async function loadBoutique() {
  const res = await fetch("/api/tickets");
  const tickets = await res.json();
  let html = '<h2 style="text-align:center;color:#a78bfa;font-size:20px;margin:8px 0">Boutique</h2><div class="grid"><div class="card"><img src="' + images.free + '"><h3>Ticket Gratuit (24h)</h3><button class="btn" onclick="claimFree()">Recuperer</button></div>';
  tickets.filter(t => t.type !== "free").forEach(t => {
    html += '<div class="card"><img src="' + (images[t.type] || images.bronze) + '"><h3>' + t.name + '</h3><div class="price">' + t.price + ' jetons</div><button class="btn" onclick="buyTicket(\\'' + t.type + '\\')">Acheter</button></div>';
  });
  html += '</div>';
  document.getElementById("content").innerHTML = html;
}
async function loadDiscordShop() {
  const res = await fetch("/api/discord-shop");
  const items = await res.json();
  let html = '<h2 style="text-align:center;color:#a78bfa;font-size:20px;margin:8px 0">Boutique Discord</h2><div class="grid">';
  items.forEach(item => {
    html += '<div class="card"><h3>' + item.name + '</h3><p style="font-size:13px;color:#9ca3af;margin:6px 0">' + item.description + '</p><div class="price">' + item.price.toLocaleString() + ' jetons</div><div style="font-size:12px;color:#6b7280;margin-bottom:8px">Stock : ' + item.stock + '</div><button class="btn" onclick="buyDiscord(' + item.id + ')">Acheter</button></div>';
  });
  html += '</div>';
  document.getElementById("content").innerHTML = items.length ? html : '<div class="card">Aucun article disponible</div>';
}
async function buyDiscord(id) {
  const res = await fetch("/api/buy-discord", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }) });
  const data = await res.json();
  if (data.error) return alert(data.error + (data.details ? "\\n" + data.details : ""));
  user.balance = data.newBalance;
  renderNav();
  alert(data.messageSent ? "Achat effectue ! Le ticket a ete cree." : "Ticket cree, mais le message n'a pas pu etre envoye.");
  loadDiscordShop();
}
async function claimFree() {
  const res = await fetch("/api/free", { method: "POST" });
  const data = await res.json();
  if (data.error) return alert(data.error);
  user.balance = data.newBalance;
  renderNav();
  alert(data.win > 0 ? "Tu as gagne " + data.win + " jetons !" : "Perdu !");
}
async function buyTicket(type) {
  const res = await fetch("/api/buy", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type }) });
  const data = await res.json();
  if (data.error) return alert(data.error);
  user.balance = data.newBalance;
  renderNav();
  showScratch(data.win, data.ticketName);
}
function showScratch(win, ticketName) {
  const resultText = win > 0 ? win + " jetons" : "Perdu";
  document.getElementById("content").innerHTML = '<div class="card" style="max-width:320px;margin:10px auto"><h2 style="color:#a78bfa">' + ticketName + '</h2><div class="scratch-area"><div class="scratch-result" id="result" style="display:flex">' + resultText + '</div><canvas id="scratch"></canvas></div><button class="btn" onclick="loadBoutique()" style="margin-top:10px">Retour</button></div>';
  initScratch();
}
function initScratch() {
  const canvas = document.getElementById("scratch");
  const ctx = canvas.getContext("2d");
  const rect = canvas.parentElement.getBoundingClientRect();
  canvas.width = rect.width;
  canvas.height = rect.height;
  ctx.fillStyle = "#7c3aed";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.globalCompositeOperation = "destination-out";
  let drawing = false;
  function getPos(e) {
    const r = canvas.getBoundingClientRect();
    const touch = e.touches ? e.touches[0] : e;
    return { x: touch.clientX - r.left, y: touch.clientY - r.top };
  }
  function scratch(e) {
    if (!drawing) return;
    e.preventDefault();
    const pos = getPos(e);
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, 26, 0, Math.PI * 2);
    ctx.fill();
  }
  canvas.addEventListener("mousedown", () => drawing = true);
  canvas.addEventListener("mouseup", () => drawing = false);
  canvas.addEventListener("mouseleave", () => drawing = false);
  canvas.addEventListener("mousemove", scratch);
  canvas.addEventListener("touchstart", (e) => { drawing = true; scratch(e); });
  canvas.addEventListener("touchend", () => drawing = false);
  canvas.addEventListener("touchmove", scratch);
}
async function loadLeaderboard() {
  const res = await fetch("/api/leaderboard");
  const leaders = await res.json();
  let html = '<h2 style="text-align:center;color:#a78bfa;font-size:20px;margin:8px 0">Classement</h2><div class="grid">';
  leaders.forEach((u, i) => {
    html += '<div class="card">' + (i+1) + '. <strong style="color:#c4b5fd">' + u.username + '</strong><br>' + u.total_won + ' gagnes</div>';
  });
  html += '</div>';
  document.getElementById("content").innerHTML = html;
}
function loadRouletteDaily() {
  document.getElementById("content").innerHTML = '<div class="card" style="max-width:460px;margin:10px auto;text-align:center"><h2 style="color:#a78bfa;margin-bottom:10px">Roulette Quotidienne</h2><div id="roulette" style="height:60px;overflow:hidden;background:linear-gradient(90deg,#1a1430,#2d2250,#1a1430);border-radius:12px;margin:10px 0;position:relative;border:2px solid #7c3aed"><div id="roulette-items" style="display:flex;position:absolute;height:100%;transition:none"></div><div style="position:absolute;left:50%;top:0;bottom:0;width:3px;background:#a78bfa;transform:translateX(-50%);box-shadow:0 0 8px #a78bfa"></div></div><button class="btn" onclick="spinRoulette()" style="padding:10px 24px;font-size:15px">Tourner</button></div>';
  const items = document.getElementById("roulette-items");
  let html = "";
  for (let i = 0; i < 20; i++) {
    const val = Math.floor(Math.random() * 49500) + 500;
    html += '<div style="min-width:130px;height:60px;line-height:60px;font-size:16px;font-weight:bold;text-align:center">' + val + ' jetons</div>';
  }
  items.innerHTML = html;
}
async function spinRoulette() {
  const res = await fetch("/api/roulette", { method: "POST" });
  const data = await res.json();
  if (data.error) return alert(data.error);
  user.balance = data.newBalance;
  renderNav();
  const items = document.getElementById("roulette-items");
  items.style.transition = "none";
  items.style.transform = "translateX(0)";
  let html = "";
  for (let i = 0; i < 15; i++) {
    const val = Math.floor(Math.random() * 49500) + 500;
    html += '<div style="min-width:130px;height:60px;line-height:60px;font-size:16px;font-weight:bold;text-align:center">' + val + ' jetons</div>';
  }
  html += '<div style="min-width:130px;height:60px;line-height:60px;font-size:18px;font-weight:bold;text-align:center;color:#a78bfa">' + data.win + ' jetons</div>';
  items.innerHTML = html;
  setTimeout(() => {
    items.style.transition = "transform 4s cubic-bezier(0.15, 0.8, 0.3, 1)";
    items.style.transform = "translateX(-" + (15 * 130) + "px)";
  }, 50);
  setTimeout(() => {
    alert("Tu as gagne " + data.win + " jetons !");
  }, 4200);
}
let bjDeck = [], bjPlayer = [], bjDealer = [], bjBet = 0, bjDone = false;
function loadBlackjack() {
  document.getElementById("content").innerHTML = '<div style="max-width:480px;margin:10px auto"><button class="btn" onclick="loadJeux()" style="margin-bottom:10px;background:#1a1430;color:#c4b5fd;border:1px solid #3b2f5e">Retour</button><div class="card"><h2 style="color:#a78bfa;text-align:center">Blackjack</h2><p>Mise :</p><input id="bjBet" type="number" value="100" min="1" style="width:100%;padding:10px;margin:6px 0;background:#1a1430;color:#fff;border:1px solid #3b2f5e;border-radius:10px;box-sizing:border-box"><button class="btn" onclick="startBj()" style="width:100%">Nouvelle main</button><div id="bjArea"></div></div></div>';
}
function makeDeck() {
  const suits = ["S","H","D","C"];
  const ranks = ["A","2","3","4","5","6","7","8","9","10","J","Q","K"];
  let d = [];
  for (let s of suits) for (let r of ranks) d.push(r + s);
  for (let i = d.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [d[i], d[j]] = [d[j], d[i]]; }
  return d;
}
function cardVal(c) {
  const r = c.slice(0, -1);
  if (r === "A") return 11;
  if (["J","Q","K"].includes(r)) return 10;
  return parseInt(r, 10);
}
function handScore(h) {
  let s = 0, aces = 0;
  for (let c of h) { s += cardVal(c); if (c.startsWith("A")) aces++; }
  while (s > 21 && aces > 0) { s -= 10; aces--; }
  return s;
}
function renderCard(c, hidden) {
  if (hidden) return '<div class="bj-card hidden">?</div>';
  const r = c.slice(0, -1);
  const suit = c.slice(-1);
  const red = suit === "H" || suit === "D";
  return '<div class="bj-card' + (red ? ' red' : '') + '">' + r + '</div>';
}
function renderBj() {
  const area = document.getElementById("bjArea");
  if (!area) return;
  let html = '<div class="bj-table"><div style="color:#9ca3af;font-size:13px;text-align:center">Dealer</div><div class="bj-hand">' + bjDealer.map((c, i) => renderCard(c, !bjDone && i === 1)).join("") + '</div>';
  html += '<div class="bj-score">Joueur : ' + handScore(bjPlayer) + '</div><div class="bj-hand">' + bjPlayer.map(c => renderCard(c, false)).join("") + '</div>';
  if (!bjDone) {
    html += '<div class="bj-actions"><button class="btn" onclick="bjHit()">Tirer</button><button class="btn" onclick="bjStand()">Rester</button><button class="btn" onclick="bjDouble()">Doubler</button></div>';
  } else {
    html += '<div style="text-align:center;margin-top:12px;font-weight:bold;color:#a78bfa;font-size:18px" id="bjResult"></div>';
  }
  html += '</div>';
  area.innerHTML = html;
}
async function startBj() {
  const bet = parseInt(document.getElementById("bjBet").value, 10);
  if (!bet || bet <= 0 || bet > user.balance) return alert("Mise invalide");
  bjBet = bet;
  bjDone = false;
  bjDeck = makeDeck();
  bjPlayer = [bjDeck.pop(), bjDeck.pop()];
  bjDealer = [bjDeck.pop(), bjDeck.pop()];
  const res = await fetch("/api/bj-result", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ change: -bjBet }) });
  const data = await res.json();
  if (!res.ok) return alert(data.error || "Erreur");
  user.balance = data.newBalance;
  renderNav();
  renderBj();
  if (handScore(bjPlayer) === 21) endBj();
}
function bjHit() {
  if (bjDone) return;
  bjPlayer.push(bjDeck.pop());
  renderBj();
  if (handScore(bjPlayer) > 21) endBj();
}
function bjStand() {
  if (bjDone) return;
  endBj();
}
async function bjDouble() {
  if (bjDone || user.balance < bjBet) return;
  const res = await fetch("/api/bj-result", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ change: -bjBet }) });
  const data = await res.json();
  if (!res.ok) return alert(data.error || "Erreur");
  user.balance = data.newBalance;
  bjBet *= 2;
  renderNav();
  bjHit();
  if (!bjDone) endBj();
}
async function endBj() {
  bjDone = true;
  while (handScore(bjDealer) < 17) bjDealer.push(bjDeck.pop());
  renderBj();
  const ps = handScore(bjPlayer), ds = handScore(bjDealer);
  let msg = "", gain = 0;
  if (ps > 21) msg = "Buste ! Perdu";
  else if (ds > 21 || ps > ds) { msg = "Gagne !"; gain = bjBet * 2; }
  else if (ps === ds) { msg = "Egalite"; gain = bjBet; }
  else msg = "Perdu";
  if (gain > 0) {
    const res = await fetch("/api/bj-result", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ change: gain }) });
    const data = await res.json();
    if (res.ok) user.balance = data.newBalance;
  }
  renderNav();
  const el = document.getElementById("bjResult");
  if (el) el.textContent = msg + (gain ? " +" + gain + " jetons" : "");
}
let rouletteBets = [];
let currentChip = 10;
const wheelNumbers = [0,32,15,19,4,21,2,25,17,34,6,27,13,36,11,30,8,23,10,5,24,16,33,1,20,14,31,9,22,18,29,7,28,12,35,3,26];
function loadRouletteGame() {
  let numbers = "";
  for (let i = 1; i <= 36; i++) {
    const red = [1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36].includes(i);
    numbers += '<div class="bet-cell ' + (red ? "red" : "black") + '" onclick="addBet(this,\\'number\\',' + i + ')">' + i + '</div>';
  }
  document.getElementById("content").innerHTML = '<div style="max-width:500px;margin:10px auto"><button class="btn" onclick="loadJeux()" style="margin-bottom:10px;background:#1a1430;color:#c4b5fd;border:1px solid #3b2f5e">Retour</button><div class="card"><h2 style="color:#a78bfa;text-align:center;margin-bottom:4px">ROULETTE EUROPEENNE</h2><div class="wheel-wrap"><div class="wheel" id="wheel"><div class="wheel-inner"></div></div><div class="ball"></div></div><div id="rouletteResult" style="text-align:center;font-size:18px;font-weight:bold;color:#a78bfa;min-height:28px"></div><div class="chips"><span class="chip" onclick="setChip(10,this)">10</span><span class="chip" onclick="setChip(50,this)">50</span><span class="chip" onclick="setChip(100,this)">100</span><span class="chip" onclick="setChip(500,this)">500</span></div><div class="bet-table"><div class="bet-cell green" onclick="addBet(this,\\'number\\',0)">0</div>' + numbers + '</div><div style="display:grid;grid-template-columns:repeat(3,1fr);gap:4px;margin:6px 0"><div class="bet-cell" onclick="addBet(this,\\'dozen1\\')">1-12</div><div class="bet-cell" onclick="addBet(this,\\'dozen2\\')">13-24</div><div class="bet-cell" onclick="addBet(this,\\'dozen3\\')">25-36</div><div class="bet-cell" onclick="addBet(this,\\'low\\')">1-18</div><div class="bet-cell" onclick="addBet(this,\\'even\\')">Pair</div><div class="bet-cell" onclick="addBet(this,\\'red\\')">Rouge</div><div class="bet-cell" onclick="addBet(this,\\'black\\')">Noir</div><div class="bet-cell" onclick="addBet(this,\\'odd\\')">Impair</div><div class="bet-cell" onclick="addBet(this,\\'high\\')">19-36</div></div><div id="currentBets" style="font-size:12px;color:#9ca3af;margin:8px 0">Aucune mise</div><button class="btn" onclick="spinRouletteGame()" style="width:100%">Lancer</button></div></div>';
  buildWheel();
  setChip(10, document.querySelector(".chip"));
}
function buildWheel() {
  const wheel = document.getElementById("wheel");
  if (!wheel) return;
  const red = [1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36];
  wheelNumbers.forEach((n, i) => {
    const el = document.createElement("div");
    el.className = "wheel-num";
    el.textContent = n;
    const angle = (i / 37) * 360 - 90;
    const rad = angle * Math.PI / 180;
    const x = 50 + 42 * Math.cos(rad);
    const y = 50 + 42 * Math.sin(rad);
    el.style.left = x + "%";
    el.style.top = y + "%";
    el.style.transform = "translate(-50%,-50%) rotate(" + (angle + 90) + "deg)";
    el.style.color = n === 0 ? "#4ade80" : (red.includes(n) ? "#f87171" : "#fff");
    wheel.appendChild(el);
  });
}
function setChip(v, el) {
  currentChip = v;
  document.querySelectorAll(".chip").forEach(c => c.classList.remove("selected"));
  if (el) el.classList.add("selected");
}
function addBet(cell, type, value) {
  rouletteBets.push({ type, value, amount: currentChip });
  const existing = cell.querySelector(".chip-on");
  if (existing) {
    existing.textContent = (parseInt(existing.textContent) + currentChip);
  } else {
    const chip = document.createElement("div");
    chip.className = "chip-on";
    chip.textContent = currentChip;
    cell.appendChild(chip);
  }
  updateBetsDisplay();
}
function updateBetsDisplay() {
  const total = rouletteBets.reduce((s, b) => s + b.amount, 0);
  document.getElementById("currentBets").textContent = rouletteBets.length ? "Mises : " + rouletteBets.length + " (" + total + " jetons)" : "Aucune mise";
}
async function spinRouletteGame() {
  if (!rouletteBets.length) return alert("Place au moins une mise");
  const res = await fetch("/api/roulette-spin", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ bets: rouletteBets }) });
  const data = await res.json();
  if (!res.ok) return alert(data.error || "Erreur");
  user.balance = data.newBalance;
  renderNav();
  const wheel = document.getElementById("wheel");
  const idx = wheelNumbers.indexOf(data.result);
  const deg = 360 * 7 + (360 / 37) * (37 - idx);
  wheel.style.transform = "rotate(" + deg + "deg)";
  setTimeout(() => {
    document.getElementById("rouletteResult").textContent = "Resultat : " + data.result + (data.winAmount > 0 ? " | Gain : " + data.winAmount : " | Perdu");
    rouletteBets = [];
    document.querySelectorAll(".chip-on").forEach(c => c.remove());
    updateBetsDisplay();
  }, 5000);
}
function loadAdmin() {
  if (user.discord_id !== "1473948546674724889") {
    document.getElementById("content").innerHTML = '<div class="card">Acces refuse</div>';
    return;
  }
  document.getElementById("content").innerHTML = '<div class="card" style="max-width:460px;margin:10px auto"><h2 style="color:#a78bfa">Admin</h2><p>ID Discord :</p><input id="targetId" placeholder="Discord ID" style="width:100%;padding:10px;margin:6px 0;background:#1a1430;color:#fff;border:1px solid #3b2f5e;border-radius:10px;box-sizing:border-box"><p>Montant :</p><input id="amount" type="number" placeholder="Montant" style="width:100%;padding:10px;margin:6px 0;background:#1a1430;color:#fff;border:1px solid #3b2f5e;border-radius:10px;box-sizing:border-box"><br><button class="btn" onclick="setTokens()" style="margin-top:10px">Ajouter</button><hr style="margin:14px 0;border-color:#2a2040"><h3 style="color:#a78bfa">Liste des joueurs</h3><div id="playerList">Chargement...</div></div>';
  loadPlayerList();
}
async function loadPlayerList() {
  const res = await fetch("/api/admin/players");
  if (!res.ok) { document.getElementById("playerList").innerHTML = "Impossible de charger les joueurs"; return; }
  const players = await res.json();
  let html = "";
  players.forEach(p => {
    html += '<div style="background:#1a1430;border:1px solid #2a2040;border-radius:10px;padding:8px;margin:6px 0;display:flex;justify-content:space-between;align-items:center;font-size:14px"><div><strong>' + p.username + '</strong><br><span style="font-size:12px;color:#9ca3af">' + p.discord_id + '</span></div><div style="font-weight:bold">' + p.balance + ' jetons</div></div>';
  });
  document.getElementById("playerList").innerHTML = html || "Aucun joueur";
}
async function setTokens() {
  const userId = document.getElementById("targetId").value;
  const amount = document.getElementById("amount").value;
  if (!userId || !amount || Number(amount) <= 0) return alert("Remplis les deux champs avec un montant positif");
  const res = await fetch("/api/admin/set-tokens", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ userId, amount: parseInt(amount, 10) }) });
  const data = await res.json();
  if (!res.ok) return alert(data.error || "Erreur");
  alert("Jetons ajoutes");
  loadPlayerList();
}
function logout() { location.href = "/api/logout"; }
init();
</script>
</body></html>`;
