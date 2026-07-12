const { createProjectDbClients, getConfiguredProjects } = require("./dbClients");

const PROJECT_INTEGRATIONS_COLLECTION = String(
  process.env.PROJECT_INTEGRATIONS_COLLECTION || "socialintegrations"
).trim();
const PROJECT_RESOLVER_REFRESH_MS = Number(process.env.PROJECT_RESOLVER_REFRESH_MS || 60000);

const SUPPORTED_PLATFORMS = ["instagram", "facebook", "whatsapp", "meta_leads"];

let refreshTimer = null;
let projectDbClients = [];
let routingIndex = new Map();
let resolverStats = {
  enabled: false,
  projectCount: 0,
  routeCount: 0,
  projects: [],
  lastRefreshAt: null,
  lastRefreshError: null
};

function buildRouteKey(platform, receiverId) {
  return `${platform}:${receiverId}`;
}

function isStatusConnected(status) {
  return String(status || "").toLowerCase() === "connected";
}

function parseTimestamp(value) {
  if (!value) {
    return 0;
  }
  if (value instanceof Date) {
    return value.getTime();
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function getIntegrationConnectedAt(doc) {
  const candidates = [
    doc?.connectedAt,
    doc?.lastConnectedAt,
    doc?.updatedAt,
    doc?.credentials?.connectedAt
  ];

  for (const candidate of candidates) {
    const timestamp = parseTimestamp(candidate);
    if (timestamp > 0) {
      return timestamp;
    }
  }

  const id = doc?._id;
  if (id && typeof id.getTimestamp === "function") {
    return id.getTimestamp().getTime();
  }

  return 0;
}

function createRouteRecord({
  platform,
  receiverId,
  projectId,
  forwardUrl,
  integrationId,
  matchedField,
  connectedAt
}) {
  return {
    platform,
    receiverId,
    projectId,
    forwardUrl,
    integrationId,
    matchedField,
    connectedAt: connectedAt || 0
  };
}

function readReceiverIds(platform, integrationDoc) {
  const credentials = integrationDoc?.credentials || {};

  if (platform === "instagram") {
    const instagramAccountId = String(credentials.instagramAccountId || "").trim();
    return instagramAccountId ? [{ receiverId: instagramAccountId, matchedField: "credentials.instagramAccountId" }] : [];
  }

  if (platform === "facebook") {
    const entries = [];
    const facebookPageId = String(credentials.facebookPageId || credentials.pageId || "").trim();
    if (facebookPageId) {
      entries.push({ receiverId: facebookPageId, matchedField: "credentials.facebookPageId" });
      if (!Number.isNaN(Number(facebookPageId))) {
        const normalized = String(Number(facebookPageId));
        if (normalized !== facebookPageId) {
          entries.push({ receiverId: normalized, matchedField: "credentials.facebookPageId" });
        }
      }
    }
    return entries;
  }

  if (platform === "whatsapp") {
    const entries = [];
    const rawPhoneNumberId = credentials.phoneNumberId;
    if (rawPhoneNumberId != null && String(rawPhoneNumberId).trim() !== "") {
      const phoneNumberIdStr = String(rawPhoneNumberId).trim();
      entries.push({
        receiverId: phoneNumberIdStr,
        matchedField: "credentials.phoneNumberId"
      });
      // Legacy rows may store phoneNumberId as a BSON number — index canonical string form too.
      if (!Number.isNaN(Number(phoneNumberIdStr))) {
        const normalized = String(Number(phoneNumberIdStr));
        if (normalized !== phoneNumberIdStr) {
          entries.push({
            receiverId: normalized,
            matchedField: "credentials.phoneNumberId"
          });
        }
      }
    }

    const wabaId = String(credentials.wabaId || "").trim();
    if (wabaId) {
      entries.push({ receiverId: wabaId, matchedField: "credentials.wabaId" });
    }

    return entries;
  }

  if (platform === "meta_leads") {
    const facebookPageId = String(credentials.facebookPageId || "").trim();
    return facebookPageId ? [{ receiverId: facebookPageId, matchedField: "credentials.facebookPageId" }] : [];
  }

  return [];
}

async function buildRoutingIndex() {
  const nextIndex = new Map();
  const routesByProject = new Map();

  for (const project of projectDbClients) {
    routesByProject.set(project.projectId, { instagram: 0, facebook: 0, whatsapp: 0, meta_leads: 0 });
    const db = project.client.db();
    const collection = db.collection(PROJECT_INTEGRATIONS_COLLECTION);

    for (const platform of SUPPORTED_PLATFORMS) {
      const docs = await collection
        .find(
          { platform, status: { $in: ["connected", "error"] } },
          {
            projection: {
              credentials: 1,
              status: 1,
              updatedAt: 1,
              connectedAt: 1,
              lastConnectedAt: 1
            }
          }
        )
        .toArray();

      docs.forEach((doc) => {
        const status = String(doc.status || "").toLowerCase();
        if (status !== "connected" && status !== "error") {
          return;
        }

        const connectedAt = getIntegrationConnectedAt(doc);
        const receiverEntries = readReceiverIds(platform, doc);
        receiverEntries.forEach(({ receiverId, matchedField }) => {
          const routeKey = buildRouteKey(platform, receiverId);
          const forwardUrl = project.backendWebhookUrls[platform];
          if (!forwardUrl) {
            return;
          }

          const candidate = createRouteRecord({
            platform,
            receiverId,
            projectId: project.projectId,
            forwardUrl,
            integrationId: String(doc._id || ""),
            matchedField,
            connectedAt
          });

          if (nextIndex.has(routeKey)) {
            const existing = nextIndex.get(routeKey);
            if (candidate.connectedAt > existing.connectedAt) {
              console.warn(
                `[resolver] duplicate receiver mapping detected for ${routeKey}; using most recent connection project=${candidate.projectId}, replacing project=${existing.projectId}`
              );
              nextIndex.set(routeKey, candidate);
            } else {
              console.warn(
                `[resolver] duplicate receiver mapping detected for ${routeKey}; keeping project=${existing.projectId}, skipping project=${candidate.projectId}`
              );
            }
            return;
          }

          nextIndex.set(routeKey, candidate);
        });

        // Facebook integrations may carry a linked Instagram account id — index for IG routing too.
        if (platform === "facebook") {
          const igId = String(doc?.credentials?.instagramAccountId || "").trim();
          const igForwardUrl = project.backendWebhookUrls.instagram;
          if (igId && igForwardUrl) {
            const igRouteKey = buildRouteKey("instagram", igId);
            const igCandidate = createRouteRecord({
              platform: "instagram",
              receiverId: igId,
              projectId: project.projectId,
              forwardUrl: igForwardUrl,
              integrationId: String(doc._id || ""),
              matchedField: "credentials.instagramAccountId (from facebook integration)",
              connectedAt
            });
            if (!nextIndex.has(igRouteKey)) {
              nextIndex.set(igRouteKey, igCandidate);
            }
          }
        }
      });
    }
  }

  routesByProject.forEach((_counts, projectId) => {
    routesByProject.set(projectId, { instagram: 0, facebook: 0, whatsapp: 0, meta_leads: 0 });
  });

  nextIndex.forEach((route) => {
    const projectRoutes = routesByProject.get(route.projectId);
    if (projectRoutes) {
      projectRoutes[route.platform] += 1;
    }
  });

  routingIndex = nextIndex;
  resolverStats = {
    ...resolverStats,
    routeCount: routingIndex.size,
    projectCount: projectDbClients.length,
    projects: projectDbClients.map((project) => {
      const routeCounts = routesByProject.get(project.projectId) || {
        instagram: 0,
        facebook: 0,
        whatsapp: 0,
        meta_leads: 0
      };
      return {
        projectId: project.projectId,
        routeCounts,
        totalRoutes:
          routeCounts.instagram +
          routeCounts.facebook +
          routeCounts.whatsapp +
          routeCounts.meta_leads,
        backendWebhookUrls: {
          instagram: Boolean(project.backendWebhookUrls.instagram),
          facebook: Boolean(project.backendWebhookUrls.facebook),
          whatsapp: Boolean(project.backendWebhookUrls.whatsapp),
          meta_leads: Boolean(project.backendWebhookUrls.meta_leads)
        }
      };
    }),
    lastRefreshAt: new Date().toISOString(),
    lastRefreshError: null
  };
}

async function refreshRoutingIndex() {
  try {
    await buildRoutingIndex();
  } catch (error) {
    resolverStats = {
      ...resolverStats,
      lastRefreshError: error.message
    };
    console.error("[resolver] failed to refresh routing index", error.message);
  }
}

async function initProjectResolver() {
  projectDbClients = createProjectDbClients();
  resolverStats.enabled = projectDbClients.length > 0;

  if (projectDbClients.length === 0) {
    console.warn("[resolver] no project databases configured; resolver disabled");
    return;
  }

  const configuredProjects = getConfiguredProjects();
  console.info(
    `[resolver] loading ${configuredProjects.length} project database(s): ${configuredProjects
      .map((project) => project.projectId)
      .join(", ")}`
  );
  configuredProjects.forEach((project) => {
    console.info(`[resolver] project=${project.projectId} downstream webhooks configured`, {
      instagram: Boolean(project.backendWebhookUrls.instagram),
      facebook: Boolean(project.backendWebhookUrls.facebook),
      whatsapp: Boolean(project.backendWebhookUrls.whatsapp),
      meta_leads: Boolean(project.backendWebhookUrls.meta_leads),
      verifyTokenConfigured: project.verifyTokenConfigured
    });
  });

  await Promise.all(projectDbClients.map((project) => project.client.connect()));
  await refreshRoutingIndex();

  console.info("[resolver] initial routing index built", {
    projectCount: resolverStats.projectCount,
    routeCount: resolverStats.routeCount,
    projects: resolverStats.projects
  });

  refreshTimer = setInterval(() => {
    refreshRoutingIndex().catch((error) => {
      console.error("[resolver] refresh timer error", error.message);
    });
  }, PROJECT_RESOLVER_REFRESH_MS);
}

function resolveProjectWebhook(platform, receiverId) {
  if (!platform || !receiverId) {
    return null;
  }
  return routingIndex.get(buildRouteKey(platform, receiverId)) || null;
}

/** Try multiple receiver IDs (e.g. WhatsApp phone_number_id then WABA entry id). */
function resolveProjectWebhookAny(platform, receiverIds) {
  const ids = Array.isArray(receiverIds) ? receiverIds : [receiverIds];
  for (const receiverId of ids) {
    const resolved = resolveProjectWebhook(platform, receiverId);
    if (resolved) {
      return { ...resolved, matchedReceiverId: receiverId };
    }
  }
  return null;
}

function getResolverStats() {
  return {
    ...resolverStats,
    refreshIntervalMs: PROJECT_RESOLVER_REFRESH_MS,
    collection: PROJECT_INTEGRATIONS_COLLECTION
  };
}

async function shutdownProjectResolver() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
  await Promise.all(projectDbClients.map((project) => project.client.close()));
}

module.exports = {
  initProjectResolver,
  shutdownProjectResolver,
  resolveProjectWebhook,
  resolveProjectWebhookAny,
  getResolverStats,
  refreshRoutingIndex,
  getConfiguredProjects
};
