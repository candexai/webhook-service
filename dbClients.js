const { MongoClient } = require("mongodb");

let cachedProjectConfigs = [];

function buildWebhookUrlsFromIndexedEnv(index) {
  const directJson = String(process.env[`PROJECT_BACKEND_WEBHOOK_URLS_${index}`] || "").trim();
  if (directJson) {
    try {
      const parsed = JSON.parse(directJson);
      return {
        instagram: String(parsed.instagram || "").trim(),
        facebook: String(parsed.facebook || "").trim(),
        whatsapp: String(parsed.whatsapp || "").trim(),
        meta_leads: String(parsed.meta_leads || "").trim()
      };
    } catch (error) {
      throw new Error(`PROJECT_BACKEND_WEBHOOK_URLS_${index} must be valid JSON`);
    }
  }

  const instagram = String(process.env[`INSTAGRAM_WEBHOOK_URL_${index}`] || "").trim();
  const facebook = String(process.env[`FACEBOOK_WEBHOOK_URL_${index}`] || "").trim();
  const whatsapp = String(process.env[`WHATSAPP_WEBHOOK_URL_${index}`] || "").trim();
  const meta_leads = String(process.env[`META_LEADS_WEBHOOK_URL_${index}`] || "").trim();
  if (instagram || facebook || whatsapp || meta_leads) {
    return { instagram, facebook, whatsapp, meta_leads };
  }

  const baseUrl = String(process.env[`PROJECT_BACKEND_BASE_URL_${index}`] || "").trim();
  if (!baseUrl) {
    return { instagram: "", facebook: "", whatsapp: "", meta_leads: "" };
  }

  return {
    instagram: `${baseUrl}/api/v1/webhooks/instagram`,
    facebook: `${baseUrl}/api/v1/social-integrations/messenger/webhook`,
    whatsapp: `${baseUrl}/api/v1/social-integrations/whatsapp/webhook`,
    meta_leads: `${baseUrl}/api/v1/social-integrations/meta-leads/webhook`
  };
}

function parseIndexedProjectConfig() {
  const indexedKeys = Object.keys(process.env)
    .map((key) => key.match(/^MONGODB_URI_(\d+)$/))
    .filter(Boolean)
    .map((match) => Number(match[1]))
    .sort((a, b) => a - b);

  return indexedKeys.map((index) => {
    const mongoUri = String(process.env[`MONGODB_URI_${index}`] || "").trim();
    const projectId = String(process.env[`PROJECT_ID_${index}`] || `project-${index}`).trim();
    if (!mongoUri) {
      throw new Error(`MONGODB_URI_${index} is empty`);
    }

    const verifyToken = String(process.env[`PROJECT_VERIFY_TOKEN_${index}`] || "").trim();
    const metaLeadsVerifyToken = String(
      process.env[`PROJECT_META_LEADS_VERIFY_TOKEN_${index}`] || verifyToken
    ).trim();

    return {
      projectId,
      mongoUri,
      verifyToken,
      metaLeadsVerifyToken,
      backendWebhookUrls: buildWebhookUrlsFromIndexedEnv(index)
    };
  });
}

function assertUniqueProjectIds(configs) {
  const seen = new Set();
  configs.forEach((config) => {
    if (seen.has(config.projectId)) {
      throw new Error(`Duplicate projectId detected: ${config.projectId}`);
    }
    seen.add(config.projectId);
  });
}

function cacheProjectConfigs(configs) {
  assertUniqueProjectIds(configs);
  cachedProjectConfigs = configs;
  return configs;
}

function parseProjectDbsConfig() {
  const raw = String(process.env.PROJECT_DBS_JSON || "").trim();
  if (!raw) {
    return cacheProjectConfigs(parseIndexedProjectConfig());
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error("PROJECT_DBS_JSON must be valid JSON");
  }

  if (!Array.isArray(parsed)) {
    throw new Error("PROJECT_DBS_JSON must be an array");
  }

  const configs = parsed.map((item) => {
    const projectId = String(item.projectId || "").trim();
    const mongoUri = String(item.mongoUri || "").trim();
    const backendWebhookUrls = item.backendWebhookUrls || {};

    if (!projectId || !mongoUri) {
      throw new Error("Each PROJECT_DBS_JSON item requires projectId and mongoUri");
    }

    const verifyToken = String(item.verifyToken || "").trim();
    const metaLeadsVerifyToken = String(item.metaLeadsVerifyToken || verifyToken).trim();

    return {
      projectId,
      mongoUri,
      verifyToken,
      metaLeadsVerifyToken,
      backendWebhookUrls: {
        instagram: String(backendWebhookUrls.instagram || "").trim(),
        facebook: String(backendWebhookUrls.facebook || "").trim(),
        whatsapp: String(backendWebhookUrls.whatsapp || "").trim(),
        meta_leads: String(backendWebhookUrls.meta_leads || "").trim()
      }
    };
  });

  return cacheProjectConfigs(configs);
}

function isKnownProjectVerifyToken(token) {
  const verifyToken = String(token || "").trim();
  if (!verifyToken) {
    return false;
  }

  return cachedProjectConfigs.some((config) => {
    if (config.verifyToken && config.verifyToken === verifyToken) {
      return true;
    }
    if (config.metaLeadsVerifyToken && config.metaLeadsVerifyToken === verifyToken) {
      return true;
    }
    return false;
  });
}

function getConfiguredProjects() {
  return cachedProjectConfigs.map((config) => ({
    projectId: config.projectId,
    verifyTokenConfigured: Boolean(config.verifyToken),
    metaLeadsVerifyTokenConfigured: Boolean(config.metaLeadsVerifyToken),
    backendWebhookUrls: {
      instagram: config.backendWebhookUrls.instagram || null,
      facebook: config.backendWebhookUrls.facebook || null,
      whatsapp: config.backendWebhookUrls.whatsapp || null,
      meta_leads: config.backendWebhookUrls.meta_leads || null
    }
  }));
}

function createProjectDbClients() {
  const configs = parseProjectDbsConfig();
  return configs.map((config) => {
    const client = new MongoClient(config.mongoUri, {
      maxPoolSize: 5
    });
    return { ...config, client };
  });
}

module.exports = {
  parseProjectDbsConfig,
  createProjectDbClients,
  isKnownProjectVerifyToken,
  getConfiguredProjects
};
