const express = require("express");
const router = express.Router();

const authMiddleware = require("../middlewares/authMiddleware");
const permissionMiddleware = require("../middlewares/permissionMiddleware");
const { validate, commonQueryValidation } = require("../middlewares/validateRequest");
const broadcastController = require("../controllers/broadcastController");

const broadcastValidation = validate({
  body: {
    targetType: { required: true, type: "enum", values: ["ALL", "ROLES", "USERS"] },
    body: { required: true, type: "string", minLength: 1 },
    roleIds: { type: "array" },
    userIds: { type: "array" }
  }
});
const broadcastIdValidation = validate({ params: { broadcastId: { required: true, type: "string" } } });

router.get("/", authMiddleware, commonQueryValidation, broadcastController.listForMe);
router.get("/admin/recent", authMiddleware, commonQueryValidation, permissionMiddleware(["admin.access"]), broadcastController.listRecentForAdmin);
router.post("/", authMiddleware, broadcastValidation, permissionMiddleware(["admin.access"]), broadcastController.create);
router.post("/:broadcastId/seen", authMiddleware, broadcastIdValidation, broadcastController.markSeen);

module.exports = router;
