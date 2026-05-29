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

function createRouteRecord({ platform, receiverId, projectId, forwardUrl, integrationId, matchedField }) {
  return {
    platform,
    receiverId,
    projectId,
    forwardUrl,
    integrationId,
    matchedField
  };
}

function readReceiverIds(platform, integrationDoc) {
  const credentials = integrationDoc?.credentials || {};

  if (platform === "instagram") {
    const instagramAccountId = String(credentials.instagramAccountId || "").trim();
    return instagramAccountId ? [{ receiverId: instagramAccountId, matchedField: "credentials.instagramAccountId" }] : [];
  }

  if (platform === "facebook") {
    const facebookPageId = String(credentials.facebookPageId || "").trim();
    return facebookPageId ? [{ receiverId: facebookPageId, matchedField: "credentials.facebookPageId" }] : [];
  }

  if (platform === "whatsapp") {
    const phoneNumberId = String(credentials.phoneNumberId || "").trim();
    return phoneNumberId ? [{ receiverId: phoneNumberId, matchedField: "credentials.phoneNumberId" }] : [];
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
        .find({ platform, status: "connected" }, { projection: { credentials: 1, status: 1 } })
        .toArray();

      docs.forEach((doc) => {
        if (!isStatusConnected(doc.status)) {
          return;
        }

        const receiverEntries = readReceiverIds(platform, doc);
        receiverEntries.forEach(({ receiverId, matchedField }) => {
          const routeKey = buildRouteKey(platform, receiverId);
          if (nextIndex.has(routeKey)) {
            const existing = nextIndex.get(routeKey);
            console.warn(
              `[resolver] duplicate receiver mapping detected for ${routeKey}; keeping first project=${existing.projectId}, skipping project=${project.projectId}`
            );
            return;
          }

          const forwardUrl = project.backendWebhookUrls[platform];
          if (!forwardUrl) {
            return;
          }

          nextIndex.set(
            routeKey,
            createRouteRecord({
              platform,
              receiverId,
              projectId: project.projectId,
              forwardUrl,
              integrationId: String(doc._id || ""),
              matchedField
            })
          );

          const projectRoutes = routesByProject.get(project.projectId);
          if (projectRoutes) {
            projectRoutes[platform] += 1;
          }
        });
      });
    }
  }

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
  getResolverStats,
  refreshRoutingIndex,
  getConfiguredProjects
};
