const express = require("express");
const {
  SUPPORTED_SERVICES,
  listClients,
  createClient,
  updateClient,
  deleteClient
} = require("./clientStore");
const { getConfiguredProjects } = require("./dbClients");
const {
  getResolverStats,
  resolveProjectWebhook,
  resolveProjectWebhookAny,
  refreshRoutingIndex
} = require("./projectResolver");

const router = express.Router();

router.get("/clients", (_req, res) => {
  res.status(200).json({
    services: SUPPORTED_SERVICES,
    data: listClients()
  });
});

router.post("/clients", (req, res) => {
  try {
    const client = createClient(req.body);
    res.status(201).json(client);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

router.put("/clients/:id", (req, res) => {
  try {
    const client = updateClient(req.params.id, req.body);
    res.status(200).json(client);
  } catch (error) {
    if (error.message === "Client not found") {
      return res.status(404).json({ error: error.message });
    }
    return res.status(400).json({ error: error.message });
  }
});

router.delete("/clients/:id", (req, res) => {
  const deleted = deleteClient(req.params.id);
  if (!deleted) {
    return res.status(404).json({ error: "Client not found" });
  }

  return res.status(204).send();
});

router.get("/routing/projects", (_req, res) => {
  res.status(200).json({
    configuredProjects: getConfiguredProjects(),
    resolver: getResolverStats()
  });
});

router.get("/routing/debug", (req, res) => {
  const platform = String(req.query.platform || "").trim();
  const receiverId = String(req.query.receiverId || "").trim();
  const receiverIds = String(req.query.receiverIds || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  const idsToTry = receiverIds.length > 0 ? receiverIds : receiverId ? [receiverId] : [];
  const resolved =
    platform && idsToTry.length > 0 ? resolveProjectWebhookAny(platform, idsToTry) : null;

  res.status(200).json({
    resolver: getResolverStats(),
    input: {
      platform,
      receiverId,
      receiverIds: idsToTry
    },
    resolved: resolved || null
  });
});

router.post("/routing/refresh", async (_req, res) => {
  try {
    await refreshRoutingIndex();
    res.status(200).json({
      resolver: getResolverStats()
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
