const fs = require("fs");
const path = require("path");

const LOG_FILE = path.join(__dirname, "access.log");
const MAX_LOG_SIZE = 5 * 1024 * 1024; // 5 MB → ruota

function rotateIfNeeded() {
  try {
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > MAX_LOG_SIZE) {
      fs.renameSync(LOG_FILE, LOG_FILE + ".old");
    }
  } catch {}
}

function getIp(req) {
  return (
    req.headers["x-forwarded-for"]?.split(",")[0].trim() ||
    req.socket.remoteAddress ||
    "?"
  ).replace(/^::ffff:/, "");
}

function log(req, event, extra = "") {
  rotateIfNeeded();
  const ts = new Date().toISOString();
  const ip = getIp(req);
  const ua = (req.headers["user-agent"] || "?").slice(0, 100).replace(/\s+/g, " ");
  const userObj = req.session?.user;
  const user = typeof userObj === "string" ? userObj
             : userObj?.username ? `${userObj.username}#${userObj.id}`
             : "-";
  const line = `${ts} | ${event.padEnd(14)} | ip=${ip.padEnd(15)} | user=${user.padEnd(20).slice(0, 40)} | ${extra} | ua="${ua}"\n`;

  fs.appendFile(LOG_FILE, line, () => {});
  console.log(line.trim());
}

function getRecentLogs(maxLines = 100) {
  try {
    if (!fs.existsSync(LOG_FILE)) return [];
    const data = fs.readFileSync(LOG_FILE, "utf8");
    const lines = data.trim().split("\n");
    return lines.slice(-maxLines).reverse();
  } catch {
    return [];
  }
}

module.exports = { log, getIp, getRecentLogs };
