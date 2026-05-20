const fs = require("fs");
const path = require("path");

const CONFIG_FILE = path.join(__dirname, "config", "servers.json");

/**
 * Struttura:
 * {
 *   "<guildId>": {
 *     "name": "Nome server",
 *     "allowedUsers": ["userId1", "userId2"],
 *     "allowAllMembers": false
 *   }
 * }
 */
class ServerConfig {
  constructor() {
    this.ensureFile();
    this.data = this.load();
  }

  ensureFile() {
    const dir = path.dirname(CONFIG_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(CONFIG_FILE)) {
      fs.writeFileSync(CONFIG_FILE, "{}", "utf8");
    }
  }

  load() {
    try {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
    } catch {
      return {};
    }
  }

  save() {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(this.data, null, 2), "utf8");
  }

  getServer(guildId) {
    return this.data[guildId] || null;
  }

  setServer(guildId, config) {
    this.data[guildId] = {
      name: config.name || "?",
      allowedUsers: config.allowedUsers || [],
      allowAllMembers: !!config.allowAllMembers,
    };
    this.save();
  }

  /**
   * L'utente può accedere a questo server?
   * - Se il server non è configurato → no
   * - Se allowAllMembers=true → sì (assumendo che sia già verificato come membro)
   * - Altrimenti userId deve essere in allowedUsers
   */
  userCanAccess(guildId, userId) {
    const s = this.data[guildId];
    if (!s) return false;
    if (s.allowAllMembers) return true;
    return s.allowedUsers.includes(userId);
  }

  getAllConfigured() {
    return Object.entries(this.data).map(([id, cfg]) => ({
      guildId: id,
      name: cfg.name,
      allowedUsers: cfg.allowedUsers,
      allowAllMembers: cfg.allowAllMembers,
    }));
  }

  removeServer(guildId) {
    delete this.data[guildId];
    this.save();
  }

  addUser(guildId, userId) {
    const s = this.data[guildId];
    if (!s) return false;
    if (!s.allowedUsers.includes(userId)) {
      s.allowedUsers.push(userId);
      this.save();
    }
    return true;
  }

  removeUser(guildId, userId) {
    const s = this.data[guildId];
    if (!s) return false;
    s.allowedUsers = s.allowedUsers.filter((u) => u !== userId);
    this.save();
    return true;
  }

  toggleAllMembers(guildId, value) {
    const s = this.data[guildId];
    if (!s) return false;
    s.allowAllMembers = !!value;
    this.save();
    return true;
  }
}

module.exports = ServerConfig;
