const express = require("express");

const {
  validateWebhookVerification,
  validateMetaSignature
} = require("./verifier");
const { isKnownVerifyToken } = require("./clientStore");
const { isKnownProjectVerifyToken } = require("./dbClients");
const { enqueueWebhookJob } = require("./queue");
const { createTraceId, logInfo, logWarn } = require("./logger");

const router = express.Router();

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const META_LEADS_VERIFY_TOKEN = String(process.env.META_LEADS_VERIFY_TOKEN || "").trim();
function collectAppSecrets() {
  const csvSecrets = String(process.env.APP_SECRETS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  const singleSecrets = [
    process.env.APP_SECRET,
    process.env.META_APP_SECRET,
    process.env.META_LEADS_APP_SECRET,
    process.env.INSTAGRAM_APP_SECRET,
    process.env.FACEBOOK_APP_SECRET,
    process.env.WHATSAPP_APP_SECRET
  ]
    .map((value) => String(value || "").trim())
    .filter(Boolean);

  return [...new Set([...singleSecrets, ...csvSecrets])];
}

const APP_SECRETS = collectAppSecrets();

router.get("/meta/webhook", (req, res) => {
  const providedToken = req.query["hub.verify_token"];
  const isTokenValid =
    (VERIFY_TOKEN && providedToken === VERIFY_TOKEN) ||
    (META_LEADS_VERIFY_TOKEN && providedToken === META_LEADS_VERIFY_TOKEN) ||
    isKnownVerifyToken(providedToken) ||
    isKnownProjectVerifyToken(providedToken);

  const result = validateWebhookVerification(req.query, isTokenValid ? providedToken : VERIFY_TOKEN);
  if (!result.ok) {
    console.warn(`[verify] failed: ${result.reason}`);
    return res.status(403).send("Forbidden");
  }

  return res.status(200).send(result.challenge);
});

router.post("/meta/webhook", (req, res) => {
  const traceId = req.get("x-request-id") || createTraceId();
  const signature256 = req.get("x-hub-signature-256");
  const signatureSha1 = req.get("x-hub-signature");
  const rawBody = req.body;

  logInfo(traceId, "[webhook] received POST /meta/webhook", {
    hasSha256: Boolean(signature256),
    hasSha1: Boolean(signatureSha1),
    contentLength: req.get("content-length") || null,
    contentType: req.get("content-type") || null
  });

  const isSignatureValid = APP_SECRETS.some((secret) =>
    validateMetaSignature(rawBody, signature256, signatureSha1, secret)
  );
  if (!isSignatureValid) {
    logWarn(traceId, "[webhook] signature validation failed", {
      hasSha256: Boolean(signature256),
      hasSha1: Boolean(signatureSha1),
      configuredAppSecrets: APP_SECRETS.length
    });
    return res.status(401).send("Invalid signature");
  }

  let payload;
  try {
    payload = JSON.parse(rawBody.toString("utf8"));
  } catch (error) {
    logWarn(traceId, "[webhook] invalid JSON payload");
    return res.status(400).send("Invalid JSON");
  }

  const entryCount = Array.isArray(payload?.entry) ? payload.entry.length : 0;
  logInfo(traceId, "[webhook] payload parsed successfully", {
    object: payload?.object || null,
    entryCount
  });

  // Acknowledge immediately, then process asynchronously.
  res.status(200).send("EVENT_RECEIVED");

  logInfo(traceId, "[webhook] acknowledged to Meta, queueing async processing");
  enqueueWebhookJob(payload, req.headers, traceId);

  return undefined;
});

module.exports = router;
