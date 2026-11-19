export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Déconnexion
    if (url.pathname === "/api/logout") {
      return new Response(null, {
        status: 302,
        headers: {
          Location: "/",
          "Set-Cookie": "session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0"
        }
      });
    }

    // Connexion Discord
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
        if (!tokenRes.ok || !token.access_token) {
          return new Response("Token error: " + JSON.stringify(token), { status: 400 });
        }

        const userRes = await fetch("https://discord.com/api/users/@me", {
          headers: { Authorization: "Bearer " + token.access_token }
        });
        const user = await userRes.json();

        if (!user.id) return new Response("Discord user error", { status: 400 });

        const guildRes = await fetch("https://discord.com/api/users/@me/guilds", {
          headers: { Authorization: "Bearer " + token.access_token }
        });
        const guilds = await guildRes.json();

        if (!Array.isArray(guilds)) {
          return new Response("Guilds error: " + JSON.stringify(guilds), { status: 400 });
        }

        if (!guilds.some(g => g.id === env.GUILD_ID)) {
          return new Response("Not in server", { status: 403 });
        }

        await env.DB.prepare(
          "INSERT INTO users (discord_id, username, avatar, balance) VALUES (?, ?, ?, 50000) ON CONFLICT(discord_id) DO UPDATE SET username = ?, avatar = ?"
        ).bind(user.id, user.username, user.avatar, user.username, user.avatar).run();

        return new Response(null, {
          status: 302,
          headers: {
            Location: "/",
            "Set-Cookie": "session=" + user.id + "; Path=/; HttpOnly; Secure; SameSite=Lax"
          }
        });
      } catch (e) {
        return new Response("Callback error: " + e.message, { status: 500 });
      }
    }

    // Informations du joueur
    if (url.pathname === "/api/me") {
      const cookie = request.headers.get("Cookie") || "";
      const session = cookie.match(/session=([^;]+)/)?.[1];

      if (!session) return new Response("Unauthorized", { status: 401 });

      const user = await env.DB.prepare(
        "SELECT * FROM users WHERE discord_id = ?"
      ).bind(session).first();

      return Response.json(user || {});
    }

    // Tickets disponibles
    if (url.pathname === "/api/tickets") {
      const tickets = await env.DB.prepare(
        "SELECT * FROM ticket_configs WHERE enabled = 1"
      ).all();

      return Response.json(tickets.results || []);
    }

    // Classement
    if (url.pathname === "/api/leaderboard") {
      const leaders = await env.DB.prepare(
        "SELECT username, balance, total_won FROM users ORDER BY total_won DESC LIMIT 10"
      ).all();

      return Response.json(leaders.results || []);
    }

    // Administration : liste des joueurs
    if (url.pathname === "/api/admin/players") {
      const cookie = request.headers.get("Cookie") || "";
      const session = cookie.match(/session=([^;]+)/)?.[1];

      if (!session || session !== env.ADMIN_DISCORD_ID) {
        return new Response("Forbidden", { status: 403 });
      }

      const players = await env.DB.prepare(
        "SELECT discord_id, username, balance FROM users ORDER BY balance DESC"
      ).all();

      return Response.json(players.results || []);
    }

    // Boutique Discord
    if (url.pathname === "/api/discord-shop") {
      const items = await env.DB.prepare(
        "SELECT * FROM discord_shop WHERE stock > 0"
      ).all();

      return Response.json(items.results || []);
    }

    // Achat boutique Discord et création du ticket
    if (url.pathname === "/api/buy-discord" && request.method === "POST") {
      const cookie = request.headers.get("Cookie") || "";
      const session = cookie.match(/session=([^;]+)/)?.[1];

      if (!session) return new Response("Unauthorized", { status: 401 });

      let body;
      try {
        body = await request.json();
      } catch {
        return Response.json({ error: "Requête invalide" }, { status: 400 });
      }

      const itemId = Number(body.id);

      if (!Number.isInteger(itemId) || itemId <= 0) {
        return Response.json({ error: "Article invalide" }, { status: 400 });
      }

      if (!env.DISCORD_BOT_TOKEN || !env.GUILD_ID) {
        return Response.json({ error: "Configuration Discord manquante" }, { status: 500 });
      }

      const item = await env.DB.prepare(
        "SELECT * FROM discord_shop WHERE id = ? AND stock > 0"
      ).bind(itemId).first();

      if (!item) {
        return Response.json({ error: "Article indisponible" }, { status: 400 });
      }

      const user = await env.DB.prepare(
        "SELECT * FROM users WHERE discord_id = ?"
      ).bind(session).first();

      if (!user) {
        return Response.json({ error: "Utilisateur introuvable" }, { status: 404 });
      }

      // Retrait du stock
      const stockUpdate = await env.DB.prepare(
        "UPDATE discord_shop SET stock = stock - 1 WHERE id = ? AND stock > 0"
      ).bind(itemId).run();

      if (!stockUpdate.meta || stockUpdate.meta.changes !== 1) {
        return Response.json({ error: "Article épuisé" }, { status: 400 });
      }

      // Débit des jetons
      const debit = await env.DB.prepare(
        "UPDATE users SET balance = balance - ? WHERE discord_id = ? AND balance >= ?"
      ).bind(item.price, session, item.price).run();

      if (!debit.meta || debit.meta.changes !== 1) {
        await env.DB.prepare(
          "UPDATE discord_shop SET stock = stock + 1 WHERE id = ?"
        ).bind(itemId).run();

        return Response.json({ error: "Pas assez de jetons" }, { status: 400 });
      }

      // Permissions du ticket
      const staffRole = env.STAFF_ROLE_ID || "1555283320508780757";
      const botId = "1572922433822924830";

      const overwrites = [
        {
          id: env.GUILD_ID,
          type: 0,
          deny: "1024"
        },
        {
          id: session,
          type: 1,
          allow: "68608"
        },
        {
          id: staffRole,
          type: 0,
          allow: "68608"
        },
        {
          id: botId,
          type: 1,
          allow: "68608"
        }
      ];

      const safeName = String(user.username || "membre")
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9-]/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 40) || "membre";

      // Création du salon Discord
      let ticketRes;

      try {
        ticketRes = await fetch(
          "https://discord.com/api/v10/guilds/" + env.GUILD_ID + "/channels",
          {
            method: "POST",
            headers: {
              "Authorization": "Bot " + env.DISCORD_BOT_TOKEN,
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              name: "ticket-" + safeName,
              type: 0,
              parent_id: "1571511806340497598",
              permission_overwrites: overwrites
            })
          }
        );
      } catch (e) {
        await env.DB.prepare(
          "UPDATE users SET balance = balance + ? WHERE discord_id = ?"
        ).bind(item.price, session).run();

        await env.DB.prepare(
          "UPDATE discord_shop SET stock = stock + 1 WHERE id = ?"
        ).bind(itemId).run();

        return Response.json({
          error: "Erreur de connexion à Discord : " + e.message
        }, { status: 502 });
      }

      if (!ticketRes.ok) {
        const error = await ticketRes.text();

        await env.DB.prepare(
          "UPDATE users SET balance = balance + ? WHERE discord_id = ?"
        ).bind(item.price, session).run();

        await env.DB.prepare(
          "UPDATE discord_shop SET stock = stock + 1 WHERE id = ?"
        ).bind(itemId).run();

        return Response.json({
          error: "Impossible de créer le ticket",
          details: error
        }, { status: 502 });
      }

      const ticket = await ticketRes.json();

      // Message détaillé de la commande
      const orderDate = new Date().toLocaleString("fr-FR", {
        timeZone: "Europe/Paris"
      });

      let messageRes;

      try {
        messageRes = await fetch(
          "https://discord.com/api/v10/channels/" + ticket.id + "/messages",
          {
            method: "POST",
            headers: {
              "Authorization": "Bot " + env.DISCORD_BOT_TOKEN,
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              content:
                "🎫 **Nouvelle commande AKIHARA !**\n" +
                "<@" + session + "> <@&" + staffRole + ">",
              embeds: [
                {
                  title: "📦 Détails de la commande",
                  color: 0x7c3aed,
                  fields: [
                    {
                      name: "🛍️ Article commandé",
                      value: String(item.name),
                      inline: false
                    },
                    {
                      name: "💰 Prix payé",
                      value: Number(item.price).toLocaleString("fr-FR") + " jetons 🪙",
                      inline: true
                    },
                    {
                      name: "👤 Client",
                      value: String(user.username),
                      inline: true
                    },
                    {
                      name: "🆔 Identifiant Discord",
                      value: session,
                      inline: false
                    },
                    {
                      name: "📅 Date de la commande",
                      value: orderDate,
                      inline: false
                    },
                    {
                      name: "🟠 Statut",
                      value: "En attente de traitement",
                      inline: false
                    }
                  ],
                  footer: {
                    text: "AKIHARA • Système de commandes"
                  },
                  timestamp: new Date().toISOString()
                }
              ],
              allowed_mentions: {
                parse: [],
                users: [session],
                roles: [staffRole]
              }
            })
          }
        );
      } catch (e) {
        console.error("Erreur envoi message ticket:", e.message);
      }

      if (messageRes && !messageRes.ok) {
        console.error(
          "Erreur Discord message:",
