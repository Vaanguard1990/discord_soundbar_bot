// Gestione webhook GitHub per auto-deploy
const crypto = require("crypto");
const { exec } = require("child_process");
const path = require("path");

const PROJECT_DIR = __dirname;

/**
 * Verifica la firma HMAC del webhook GitHub
 * GitHub firma il body con il secret e lo invia nell'header X-Hub-Signature-256
 */
function verifySignature(secret, signature, payload) {
  if (!signature) return false;
  const hmac = crypto.createHmac("sha256", secret);
  const digest = "sha256=" + hmac.update(payload).digest("hex");
  try {
    return crypto.timingSafeEqual(
      Buffer.from(digest),
      Buffer.from(signature)
    );
  } catch {
    return false;
  }
}

/**
 * Esegue lo script di deploy
 */
function runDeploy(callback) {
  const script = path.join(PROJECT_DIR, "deploy.sh");
  const cmd = `bash ${script}`;

  exec(cmd, { cwd: PROJECT_DIR, timeout: 120_000 }, (err, stdout, stderr) => {
    if (err) {
      callback({
        ok: false,
        error: err.message,
        stdout: stdout?.slice(-2000),
        stderr: stderr?.slice(-2000),
      });
    } else {
      callback({
        ok: true,
        stdout: stdout?.slice(-2000),
      });
    }
  });
}

/**
 * Handler Express per POST /api/webhook
 * Richiede `req.rawBody` (raw body buffer per la verifica HMAC)
 */
function createWebhookHandler(getSecret, log) {
  return (req, res) => {
    const secret = getSecret();
    if (!secret) {
      return res.status(503).json({ error: "Webhook non configurato" });
    }

    const signature = req.get("X-Hub-Signature-256");
    const event = req.get("X-GitHub-Event");
    const delivery = req.get("X-GitHub-Delivery");

    if (!verifySignature(secret, signature, req.rawBody)) {
      log(req, "WEBHOOK_REJECT", `delivery=${delivery} reason=bad_signature`);
      return res.status(401).json({ error: "Firma non valida" });
    }

    // Solo evento push del branch principale
    if (event === "ping") {
      log(req, "WEBHOOK_PING", `delivery=${delivery}`);
      return res.json({ ok: true, msg: "pong" });
    }

    if (event !== "push") {
      log(req, "WEBHOOK_SKIP", `event=${event}`);
      return res.json({ ok: true, msg: `ignorato evento ${event}` });
    }

    const ref = req.body?.ref || "";
    if (!ref.endsWith("/main") && !ref.endsWith("/master")) {
      log(req, "WEBHOOK_SKIP", `ref=${ref}`);
      return res.json({ ok: true, msg: `ignorato branch ${ref}` });
    }

    const commit = req.body?.head_commit?.id?.slice(0, 7) || "?";
    const author = req.body?.head_commit?.author?.name || "?";
    const msg = (req.body?.head_commit?.message || "").split("\n")[0].slice(0, 80);

    log(req, "WEBHOOK_DEPLOY", `commit=${commit} author="${author}" msg="${msg}"`);

    // Risposta immediata, deploy in background
    res.json({ ok: true, msg: "Deploy avviato", commit });

    // Esecuzione deploy
    runDeploy((result) => {
      if (result.ok) {
        log(req, "DEPLOY_OK", `commit=${commit}`);
        console.log(`✅ Deploy ${commit} completato\n${result.stdout}`);
      } else {
        log(req, "DEPLOY_FAIL", `commit=${commit} err="${result.error}"`);
        console.error(`❌ Deploy ${commit} fallito\n${result.stderr || result.stdout}`);
      }
    });
  };
}

module.exports = { createWebhookHandler, verifySignature };
