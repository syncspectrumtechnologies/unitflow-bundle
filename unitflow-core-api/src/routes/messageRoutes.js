const express = require("express");
const router = express.Router();

const authMiddleware = require("../middlewares/authMiddleware");
const permissionMiddleware = require("../middlewares/permissionMiddleware");
const idempotencyMiddleware = require("../middlewares/idempotencyMiddleware");
const { validate, commonQueryValidation } = require("../middlewares/validateRequest");
const messageController = require("../controllers/messageController");

const campaignValidation = validate({
  body: {
    name: { required: true, type: "string", minLength: 1 },
    channel: { required: true, type: "enum", values: ["EMAIL", "WHATSAPP"] },
    template_id: { type: "string" },
    purpose: { type: "string" },
    factory_id: { type: "string" },
    recipients: { type: "array" },
    filter: { type: "object" }
  }
});
const campaignIdValidation = validate({ params: { id: { required: true, type: "string" } } });

router.use(authMiddleware);
router.post("/campaigns", campaignValidation, permissionMiddleware(["messages.campaigns.create"]), messageController.createCampaign);
router.post("/campaigns/from-filter", campaignValidation, permissionMiddleware(["messages.campaigns.create"]), messageController.createCampaignFromFilter);
router.post("/campaigns/promotional", campaignValidation, permissionMiddleware(["messages.campaigns.create"]), messageController.createPromotionalCampaign);
router.post("/campaigns/:id/dispatch", campaignIdValidation, idempotencyMiddleware(), permissionMiddleware(["messages.campaigns.dispatch"]), messageController.dispatchCampaign);
router.get("/campaigns/:id/status", campaignIdValidation, permissionMiddleware(["messages.outbox.view"]), messageController.getCampaignStatus);
router.get("/outbox", commonQueryValidation, permissionMiddleware(["messages.outbox.view"]), messageController.getOutbox);

module.exports = router;
