const axios = require("axios");

const { resolveProjectWebhookAny } = require("./projectResolver");
const { logError, logInfo, logWarn } = require("./logger");

const INTERNAL_SECRET = String(process.env.INTERNAL_SECRET || "").trim();
const REQUEST_TIMEOUT_MS = Number(process.env.FORWARD_TIMEOUT_MS || 8000);
const MAX_FORWARD_ATTEMPTS = Number(process.env.FORWARD_MAX_ATTEMPTS || 3);
const PLACEHOLDER_INTERNAL_SECRET = "REPLACE_WITH_INTERNAL_SHARED_SECRET";

function assertInternalSecretConfigured() {
  if (!INTERNAL_SECRET || INTERNAL_SECRET === PLACEHOLDER_INTERNAL_SECRET) {
    throw new Error(
      "INTERNAL_SECRET is not configured. Set the same strong shared secret in webhook gateway and downstream backend."
    );
  }
}

function entryHasLeadgenChange(entry) {
  const changes = Array.isArray(entry?.changes) ? entry.changes : [];
  return changes.some((change) => String(change?.field || "").toLowerCase() === "leadgen");
}

function getRouteContext(payload, entry) {
  const objectType = String(payload?.object || "").toLowerCase();

  if (objectType === "instagram") {
    const receiverId = entry?.id ? String(entry.id) : null;
    return receiverId ? { platform: "instagram", receiverId, eventType: "instagram" } : null;
  }

  if (objectType === "whatsapp_business_account") {
    const phoneNumberId = entry?.changes?.[0]?.value?.metadata?.phone_number_id;
    const wabaId = entry?.id;
    const receiverIds = [];
    if (phoneNumberId) {
      receiverIds.push(String(phoneNumberId));
    }
    // Fallback: Meta WABA webhooks also include the WABA id on entry.id
    if (wabaId) {
      receiverIds.push(String(wabaId));
    }
    if (receiverIds.length === 0) {
      return null;
    }
    return { platform: "whatsapp", receiverIds, eventType: "whatsapp" };
  }

  if (objectType === "page") {
    const receiverId = entry?.id ? String(entry.id) : null;
    if (!receiverId) {
      return null;
    }

    // Meta Lead Ads — must route to meta-leads webhook, not Messenger.
    if (entryHasLeadgenChange(entry)) {
      return { platform: "meta_leads", receiverId, eventType: "leadgen" };
    }

    // Messenger / page messaging events (unchanged).
    if (Array.isArray(entry?.messaging) && entry.messaging.length > 0) {
      return { platform: "facebook", receiverId, eventType: "messaging" };
    }

    const isInstagramScoped = Boolean(entry?.changes?.[0]?.value?.instagram_account_id);
    if (isInstagramScoped) {
      return { platform: "instagram", receiverId, eventType: "instagram_change" };
    }

    return { platform: "facebook", receiverId, eventType: "page" };
  }

  return null;
}

function collectEventSummary(payload, entry) {
  const objectType = String(payload?.object || "").toLowerCase();
  const messagingEvents = Array.isArray(entry?.messaging) ? entry.messaging : [];
  const changes = Array.isArray(entry?.changes) ? entry.changes : [];
  const firstMessaging = messagingEvents[0] || {};
  const firstMessage = firstMessaging?.message || {};

  return {
    object: payload?.object || null,
    entryId: entry?.id ? String(entry.id) : null,
    entryTime: entry?.time || null,
    messagingCount: messagingEvents.length,
    changesCount: changes.length,
    senderId: firstMessaging?.sender?.id ? String(firstMessaging.sender.id) : null,
    recipientId: firstMessaging?.recipient?.id ? String(firstMessaging.recipient.id) : null,
    mid: firstMessage?.mid || null,
    textPreview: typeof firstMessage?.text === "string" ? firstMessage.text.slice(0, 100) : null,
    isFacebookPageEvent: objectType === "page",
    hasLeadgenChange: entryHasLeadgenChange(entry)
  };
}

async function forwardWithRetry(mapping, body, originalHeaders, traceId) {
  assertInternalSecretConfigured();

  const outgoingHeaders = {
    "Content-Type": "application/json",
    "x-client-id": mapping.client_id,
    "x-internal-secret": INTERNAL_SECRET
  };

  if (originalHeaders["x-request-id"]) {
    outgoingHeaders["x-request-id"] = originalHeaders["x-request-id"];
  }

  let lastError = null;

  for (let attempt = 1; attempt <= MAX_FORWARD_ATTEMPTS; attempt += 1) {
    try {
      logInfo(traceId, "[forward] sending event to downstream", {
        clientId: mapping.client_id,
        forwardUrl: mapping.forward_url,
        attempt,
        maxAttempts: MAX_FORWARD_ATTEMPTS
      });
      await axios.post(mapping.forward_url, body, {
        headers: outgoingHeaders,
        timeout: REQUEST_TIMEOUT_MS
      });
      logInfo(traceId, "[forward] downstream accepted event", {
        clientId: mapping.client_id,
        forwardUrl: mapping.forward_url,
        attempt
      });
      return;
    } catch (error) {
      lastError = error;
      logError(traceId, "[forward] downstream request failed", {
        clientId: mapping.client_id,
        forwardUrl: mapping.forward_url,
        attempt,
        maxAttempts: MAX_FORWARD_ATTEMPTS,
        error: error.message
      });
    }
  }

  throw lastError;
}

async function processWebhookPayload(payload, requestHeaders, traceId) {
  const entries = Array.isArray(payload?.entry) ? payload.entry : [];

  if (entries.length === 0) {
    logWarn(traceId, "[webhook] payload has no entry array");
    return;
  }

  logInfo(traceId, "[webhook] processing payload entries", {
    object: payload?.object || null,
    entryCount: entries.length
  });

  const tasks = entries.map(async (entry, index) => {
    logInfo(traceId, "[webhook] evaluating entry", {
      entryIndex: index,
      summary: collectEventSummary(payload, entry)
    });

    const routeContext = getRouteContext(payload, entry);
    if (!routeContext) {
      logWarn(traceId, "[webhook] could not derive route context from payload entry", {
        entryIndex: index,
        summary: collectEventSummary(payload, entry)
      });
      return;
    }

    const resolved = resolveProjectWebhookAny(
      routeContext.platform,
      routeContext.receiverIds || [routeContext.receiverId]
    );
    if (!resolved) {
      logWarn(traceId, "[webhook] no routing target found", {
        platform: routeContext.platform,
        receiverIds: routeContext.receiverIds || [routeContext.receiverId],
        entryIndex: index
      });
      return;
    }

    logInfo(traceId, "[webhook] resolved project route", {
      projectId: resolved.projectId,
      platform: routeContext.platform,
      receiverId: resolved.matchedReceiverId,
      receiverIdsTried: routeContext.receiverIds || [routeContext.receiverId],
      eventType: routeContext.eventType || null,
      forwardUrl: resolved.forwardUrl,
      entryIndex: index
    });

    await forwardWithRetry(
      {
        client_id: resolved.projectId,
        forward_url: resolved.forwardUrl
      },
      payload,
      requestHeaders,
      traceId
    );
  });

  const results = await Promise.allSettled(tasks);
  results.forEach((result) => {
    if (result.status === "rejected") {
      logError(traceId, "[webhook] async processing failed", {
        error: result.reason?.message || "Unknown async processing failure"
      });
    }
  });
}

module.exports = {
  processWebhookPayload
};
