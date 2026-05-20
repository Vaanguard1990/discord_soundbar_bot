require("dotenv").config();

const sodium = require("libsodium-wrappers");
const fs = require("fs");
const http = require("http");
const https = require("https");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const session = require("express-session");
const rateLimit = require("express-rate-limit");
const multer = require("multer");
const { Client, GatewayIntentBits, ChannelType } = require("discord.js");

const { SoundManagerRegistry, SOUNDS_BASE } = require("./soundManager");
const ServerConfig = require("./serverConfig");
const DiscordOAuth = require("./discordOAuth");
const { log, getRecentLogs } = require("./accessLog");

// ─── Config validation ─────────────────────────────────────────────────────
const required = [
  "DISCORD_TOKEN", "CLIENT_ID", "CLIENT_SECRET", "PUBLIC_URL",
  "OWNER_ID", "SESSION_SECRET"
];
for (const v of required) {
  if (!process.env[v]) {
    console.error(`❌ Variabile d'ambiente mancante: ${v}`);
    process.exit(1);
  }
}

const PORT = parseInt(process.env.PORT || "3000", 10);
const SESSION_DAYS = parseInt(process.env.SESSION_DAYS || "7", 10);
const OWNER_ID = process.env.OWNER_ID;
const PUBLIC_URL = process.env.PUBLIC_URL.replace(/\/+$/, "");

sodium.ready.then(() => {
  console.log("🔐 Sodium pronto");

  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
  });

  const registry = new SoundManagerRegistry();
  const serverConfig = new ServerConfig();
  const oauth = new DiscordOAuth({
    clientId: process.env.CLIENT_ID,
    clientSecret: process.env.CLIENT_SECRET,
    redirectUri: `${PUBLIC_URL}/api/oauth/callback`,
  });

  const app = express();
  app.set("trust proxy", 1);
  app.use(express.json({
    limit: "5mb",
    verify: (req, res, buf) => { req.rawBody = buf; },
  }));

  // ─── HTTPS detection ─────────────────────────────────────────────────────
  const SSL_CERT = process.env.SSL_CERT || "/etc/letsencrypt/live/DOMAIN/fullchain.pem";
  const SSL_KEY  = process.env.SSL_KEY  || "/etc/letsencrypt/live/DOMAIN/privkey.pem";
  const httpsEnabled = fs.existsSync(SSL_CERT) && fs.existsSync(SSL_KEY);

  // ─── Sessioni ────────────────────────────────────────────────────────────
  app.use(session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    name: "sb.sid",
    cookie: {
      httpOnly: true,
      secure: httpsEnabled,
      sameSite: "lax",
      maxAge: SESSION_DAYS * 24 * 60 * 60 * 1000,
    },
  }));

  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
  });

  // ══════════════════════════════════════════════════════════════════════════
  // ROUTE PUBBLICHE
  // ══════════════════════════════════════════════════════════════════════════

  app.get("/login", (req, res) => {
    if (req.session?.user) return res.redirect("/");
    res.sendFile(path.join(__dirname, "public", "login.html"));
  });

  // Step 1: redirect a Discord
  app.get("/api/oauth/start", loginLimiter, (req, res) => {
    const state = crypto.randomBytes(16).toString("hex");
    req.session.oauthState = state;
    res.redirect(oauth.getAuthUrl(state));
  });

  // Step 2: callback da Discord con il code
  app.get("/api/oauth/callback", loginLimiter, async (req, res) => {
    const { code, state, error } = req.query;

    if (error) {
      log(req, "OAUTH_DENIED", `error=${error}`);
      return res.redirect("/login?err=denied");
    }
    if (!code || !state || state !== req.session.oauthState) {
      log(req, "OAUTH_BAD_STATE", "");
      return res.redirect("/login?err=state");
    }
    delete req.session.oauthState;

    try {
      const tokenData = await oauth.exchangeCode(code);
      const user = await oauth.getUser(tokenData.access_token);
      const guilds = await oauth.getUserGuilds(tokenData.access_token);

      req.session.user = {
        id: user.id,
        username: user.username,
        globalName: user.global_name || user.username,
        avatar: user.avatar,
        // Salvo gli ID delle guild dell'utente per autorizzazione runtime
        guildIds: guilds.map((g) => g.id),
        loginAt: Date.now(),
      };
      log(req, "LOGIN_OK", `user=${user.username}#${user.id}`);
      res.redirect("/");
    } catch (err) {
      console.error("OAuth error:", err.message);
      log(req, "OAUTH_ERROR", err.message);
      res.redirect("/login?err=oauth");
    }
  });

  app.post("/api/logout", (req, res) => {
    log(req, "LOGOUT", req.session?.user?.id || "-");
    req.session.destroy(() => {
      res.clearCookie("sb.sid");
      res.json({ ok: true });
    });
  });

  // ─── GitHub Webhook ──────────────────────────────────────────────────────
  const { createWebhookHandler } = require("./webhook");
  const webhookLimiter = rateLimit({
    windowMs: 60 * 1000, max: 30,
    standardHeaders: true, legacyHeaders: false,
  });
  app.post("/api/webhook", webhookLimiter,
    createWebhookHandler(() => process.env.WEBHOOK_SECRET, log)
  );

  // ══════════════════════════════════════════════════════════════════════════
  // MIDDLEWARE DI AUTENTICAZIONE E AUTORIZZAZIONE
  // ══════════════════════════════════════════════════════════════════════════

  function requireAuth(req, res, next) {
    if (req.session?.user) return next();
    if (req.path.startsWith("/api/")) {
      return res.status(401).json({ error: "Non autenticato" });
    }
    res.redirect("/login");
  }

  function requireOwner(req, res, next) {
    if (req.session?.user?.id === OWNER_ID) return next();
    res.status(403).json({ error: "Solo il proprietario del bot può farlo" });
  }

  // Carica `req.guildId` da body/query/params e verifica che l'utente:
  // 1. sia membro di quel server (guildIds dalla sessione)
  // 2. sia autorizzato dal serverConfig
  // 3. il bot sia effettivamente in quel server
  function requireGuildAccess(req, res, next) {
    const guildId = req.body?.guildId || req.query?.guildId;
    if (!guildId) return res.status(400).json({ error: "guildId mancante" });

    const user = req.session.user;
    const isOwner = user.id === OWNER_ID;

    // L'owner bypassa i controlli utente (ma deve comunque avere il bot nel server)
    if (!isOwner) {
      if (!user.guildIds.includes(guildId)) {
        return res.status(403).json({ error: "Non sei membro di quel server Discord" });
      }
      if (!serverConfig.userCanAccess(guildId, user.id)) {
        return res.status(403).json({ error: "Non sei autorizzato su questo server" });
      }
    }

    const guild = client.guilds.cache.get(guildId);
    if (!guild) return res.status(404).json({ error: "Il bot non è in quel server" });

    req.guildId = guildId;
    req.guild = guild;
    next();
  }

  // ══════════════════════════════════════════════════════════════════════════
  // DA QUI IN POI: AUTENTICAZIONE RICHIESTA
  // ══════════════════════════════════════════════════════════════════════════

  app.use(requireAuth);
  app.use(express.static(path.join(__dirname, "public")));

  // Info utente corrente + lista server usabili (intersezione tra server utente e server bot)
  app.get("/api/me", (req, res) => {
    const u = req.session.user;
    const botGuilds = [...client.guilds.cache.values()];
    const isOwner = u.id === OWNER_ID;

    // Server che l'utente può controllare:
    // - il bot deve essere presente
    // - l'utente deve essere membro (dal token Discord), OPPURE essere l'owner
    // - l'utente deve essere autorizzato dal serverConfig, OPPURE essere l'owner
    const accessible = botGuilds
      .filter((g) => isOwner || u.guildIds.includes(g.id))
      .filter((g) => isOwner || serverConfig.userCanAccess(g.id, u.id))
      .map((g) => ({ id: g.id, name: g.name, iconURL: g.iconURL() }));

    res.json({
      user: {
        id: u.id,
        username: u.username,
        globalName: u.globalName,
        avatar: u.avatar,
        isOwner,
      },
      accessibleGuilds: accessible,
      instance: process.env.INSTANCE_NAME || "",
    });
  });

  // ─── API operative (per-server) ──────────────────────────────────────────
  app.get("/api/status", requireGuildAccess, (req, res) => {
    const manager = registry.get(req.guildId);
    const voiceChannels = req.guild.channels.cache
      .filter((c) => c.type === ChannelType.GuildVoice)
      .map((c) => ({ id: c.id, name: c.name, members: c.members.size }))
      .sort((a, b) => a.name.localeCompare(b.name, "it"));

    res.json({
      ...manager.getStatus(),
      guildId: req.guildId,
      guildName: req.guild.name,
      sounds: manager.getSoundNames(),
      channels: voiceChannels,
    });
  });

  app.post("/api/join", requireGuildAccess, async (req, res) => {
    const { channelId } = req.body;
    const channel = req.guild.channels.cache.get(channelId);
    if (!channel) return res.status(404).json({ error: "Canale non trovato" });

    const manager = registry.get(req.guildId);
    try {
      await manager.join(channel);
      log(req, "VOICE_JOIN", `guild=${req.guild.name} channel="${channel.name}"`);
      res.json({ ok: true, channel: { id: channel.id, name: channel.name } });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/play", requireGuildAccess, async (req, res) => {
    const { sound } = req.body;
    const manager = registry.get(req.guildId);
    try {
      await manager.play(sound);
      log(req, "PLAY", `guild=${req.guild.name} sound="${sound}"`);
      res.json({ ok: true, playing: sound });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/stop", requireGuildAccess, (req, res) => {
    registry.get(req.guildId).stop();
    log(req, "STOP", `guild=${req.guild.name}`);
    res.json({ ok: true });
  });

  app.post("/api/disconnect", requireGuildAccess, (req, res) => {
    registry.get(req.guildId).disconnect();
    log(req, "VOICE_LEAVE", `guild=${req.guild.name}`);
    res.json({ ok: true });
  });

  app.post("/api/reload", requireGuildAccess, (req, res) => {
    const manager = registry.get(req.guildId);
    const count = manager.loadSounds();
    log(req, "RELOAD_SOUNDS", `guild=${req.guild.name} count=${count}`);
    res.json({ ok: true, count, sounds: manager.getSoundNames() });
  });

  // ─── Gestione suoni: upload / delete / rename / list ─────────────────────
  const SUPPORTED_EXT = [".mp3", ".wav", ".ogg", ".flac"];
  const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
  const uploader = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_FILE_SIZE, files: 10 },
  });

  function sanitizeFilename(name) {
    return String(name || "")
      .replace(/[\0\/\\]/g, "")
      .replace(/^\.+/, "")
      .trim()
      .slice(0, 200);
  }

  app.get("/api/sounds/list", requireGuildAccess, (req, res) => {
    const dir = path.join(SOUNDS_BASE, req.guildId);
    if (!fs.existsSync(dir)) return res.json({ files: [] });
    const files = fs.readdirSync(dir)
      .filter((f) => SUPPORTED_EXT.includes(path.extname(f).toLowerCase()))
      .map((f) => {
        const fp = path.join(dir, f);
        const stat = fs.statSync(fp);
        return { name: f, size: stat.size, mtime: stat.mtime };
      })
      .sort((a, b) => a.name.localeCompare(b.name, "it"));
    res.json({ files });
  });

  app.post("/api/sounds/upload", requireGuildAccess, uploader.array("files", 10), (req, res) => {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: "Nessun file caricato" });
    }
    const dir = path.join(SOUNDS_BASE, req.guildId);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const results = [];
    for (const file of req.files) {
      const originalName = sanitizeFilename(file.originalname);
      const ext = path.extname(originalName).toLowerCase();

      if (!SUPPORTED_EXT.includes(ext)) {
        results.push({ file: originalName, ok: false, error: `Estensione non supportata (${ext})` });
        continue;
      }
      const destPath = path.join(dir, originalName);
      if (fs.existsSync(destPath)) {
        results.push({ file: originalName, ok: false, error: "File già presente con lo stesso nome" });
        continue;
      }
      try {
        fs.writeFileSync(destPath, file.buffer);
        results.push({ file: originalName, ok: true, size: file.size });
      } catch (err) {
        results.push({ file: originalName, ok: false, error: err.message });
      }
    }

    registry.get(req.guildId).loadSounds();
    const uploaded = results.filter((r) => r.ok).length;
    const failed = results.filter((r) => !r.ok).length;
    log(req, "SOUNDS_UPLOAD", `guild=${req.guild.name} ok=${uploaded} fail=${failed}`);
    res.json({ ok: true, results, uploaded, failed });
  });

  app.post("/api/sounds/delete", requireGuildAccess, (req, res) => {
    const { filename } = req.body;
    if (!filename) return res.status(400).json({ error: "filename mancante" });

    const cleaned = sanitizeFilename(filename);
    const dir = path.resolve(SOUNDS_BASE, req.guildId);
    const target = path.resolve(path.join(dir, cleaned));
    if (!target.startsWith(dir + path.sep)) return res.status(400).json({ error: "Path non valido" });
    if (!fs.existsSync(target)) return res.status(404).json({ error: "File non trovato" });

    try {
      fs.unlinkSync(target);
      registry.get(req.guildId).loadSounds();
      log(req, "SOUND_DELETE", `guild=${req.guild.name} file="${cleaned}"`);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/sounds/rename", requireGuildAccess, (req, res) => {
    const { oldName, newName } = req.body;
    if (!oldName || !newName) return res.status(400).json({ error: "oldName/newName mancanti" });

    const oldClean = sanitizeFilename(oldName);
    const newClean = sanitizeFilename(newName);
    const dir = path.resolve(SOUNDS_BASE, req.guildId);
    const oldPath = path.resolve(path.join(dir, oldClean));
    const newPath = path.resolve(path.join(dir, newClean));
    if (!oldPath.startsWith(dir + path.sep) || !newPath.startsWith(dir + path.sep)) {
      return res.status(400).json({ error: "Path non valido" });
    }
    const ext = path.extname(newClean).toLowerCase();
    if (!SUPPORTED_EXT.includes(ext)) {
      return res.status(400).json({ error: `Estensione non supportata (${ext})` });
    }
    if (!fs.existsSync(oldPath)) return res.status(404).json({ error: "File originale non trovato" });
    if (fs.existsSync(newPath)) return res.status(409).json({ error: "Esiste già un file con quel nome" });

    try {
      fs.renameSync(oldPath, newPath);
      registry.get(req.guildId).loadSounds();
      log(req, "SOUND_RENAME", `guild=${req.guild.name} "${oldClean}" → "${newClean}"`);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Handler errori multer
  app.use((err, req, res, next) => {
    if (err instanceof multer.MulterError) {
      if (err.code === "LIMIT_FILE_SIZE") {
        return res.status(413).json({ error: `File troppo grande (max ${MAX_FILE_SIZE / 1024 / 1024} MB)` });
      }
      return res.status(400).json({ error: err.message });
    }
    next(err);
  });

  // ─── Admin API (solo OWNER) ──────────────────────────────────────────────
  app.get("/api/admin/servers", requireOwner, (req, res) => {
    // Lista TUTTI i server dove il bot è presente, con config attuale
    const botGuilds = [...client.guilds.cache.values()];
    const result = botGuilds.map((g) => {
      const cfg = serverConfig.getServer(g.id);
      return {
        id: g.id,
        name: g.name,
        iconURL: g.iconURL(),
        memberCount: g.memberCount,
        configured: !!cfg,
        allowedUsers: cfg?.allowedUsers || [],
        allowAllMembers: cfg?.allowAllMembers || false,
      };
    });
    res.json({ servers: result });
  });

  app.post("/api/admin/server/:guildId/configure", requireOwner, (req, res) => {
    const { guildId } = req.params;
    const { allowedUsers = [], allowAllMembers = false } = req.body;
    const guild = client.guilds.cache.get(guildId);
    if (!guild) return res.status(404).json({ error: "Server non trovato" });

    serverConfig.setServer(guildId, {
      name: guild.name,
      allowedUsers: allowedUsers.filter((u) => /^\d{17,20}$/.test(u)),
      allowAllMembers: !!allowAllMembers,
    });
    log(req, "ADMIN_CONFIG", `guild=${guild.name}`);
    res.json({ ok: true });
  });

  app.post("/api/admin/server/:guildId/user/add", requireOwner, (req, res) => {
    const { guildId } = req.params;
    const { userId } = req.body;
    if (!/^\d{17,20}$/.test(userId)) return res.status(400).json({ error: "userId non valido" });
    serverConfig.addUser(guildId, userId);
    log(req, "ADMIN_ADD_USER", `guild=${guildId} user=${userId}`);
    res.json({ ok: true });
  });

  app.post("/api/admin/server/:guildId/user/remove", requireOwner, (req, res) => {
    const { guildId } = req.params;
    const { userId } = req.body;
    serverConfig.removeUser(guildId, userId);
    log(req, "ADMIN_REM_USER", `guild=${guildId} user=${userId}`);
    res.json({ ok: true });
  });

  app.get("/api/admin/logs", requireOwner, (req, res) => {
    res.json({ logs: getRecentLogs(300) });
  });

  // ─── Discord Bot ─────────────────────────────────────────────────────────
  client.once("clientReady", () => {
    console.log(`✅ Bot online come ${client.user.tag}`);
    console.log(`   Presente in ${client.guilds.cache.size} server:`);
    for (const g of client.guilds.cache.values()) {
      console.log(`   - ${g.name} (${g.id})`);
    }
    client.user.setActivity("🎛️ Soundboard", { type: 3 });
  });

  // ─── Server HTTP/HTTPS ───────────────────────────────────────────────────
  // Porte configurabili da .env:
  //   HTTPS_PORT (default 443)   — porta su cui ascoltare HTTPS
  //   HTTP_REDIRECT_PORT (default 80) — porta del redirect HTTP→HTTPS, "off" per disabilitare
  // Per il container di test serve impostare HTTPS_PORT=8443 e HTTP_REDIRECT_PORT=off
  const HTTPS_PORT = parseInt(process.env.HTTPS_PORT || "443", 10);
  const HTTP_REDIRECT_PORT = process.env.HTTP_REDIRECT_PORT === "off" ? null
                           : parseInt(process.env.HTTP_REDIRECT_PORT || "80", 10);
  const INSTANCE_NAME = process.env.INSTANCE_NAME || "";

  if (httpsEnabled) {
    const credentials = {
      cert: fs.readFileSync(SSL_CERT),
      key: fs.readFileSync(SSL_KEY),
    };
    https.createServer(credentials, app).listen(HTTPS_PORT, () => {
      const tag = INSTANCE_NAME ? `[${INSTANCE_NAME}] ` : "";
      const portTxt = HTTPS_PORT === 443 ? "" : `:${HTTPS_PORT}`;
      console.log(`🔒 ${tag}HTTPS attivo su ${PUBLIC_URL}`);
    });
    if (HTTP_REDIRECT_PORT) {
      http.createServer((req, res) => {
        const host = (req.headers.host || "").split(":")[0];
        const portSuffix = HTTPS_PORT === 443 ? "" : `:${HTTPS_PORT}`;
        res.writeHead(301, { Location: `https://${host}${portSuffix}${req.url}` });
        res.end();
      }).listen(HTTP_REDIRECT_PORT, () => {
        console.log(`↪️  Redirect HTTP:${HTTP_REDIRECT_PORT} → HTTPS:${HTTPS_PORT}`);
      });
    }
  } else {
    app.listen(PORT, () => {
      const tag = INSTANCE_NAME ? `[${INSTANCE_NAME}] ` : "";
      console.log(`🌐 ${tag}HTTP su http://localhost:${PORT}`);
    });
  }

  client.login(process.env.DISCORD_TOKEN);
});
