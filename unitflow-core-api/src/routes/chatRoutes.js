const express = require("express");
const router = express.Router();

const authMiddleware = require("../middlewares/authMiddleware");
const { validate, commonQueryValidation } = require("../middlewares/validateRequest");
const chatController = require("../controllers/chatController");

const userIdValidation = validate({ params: { userId: { required: true, type: "string" } } });
const conversationValidation = validate({ params: { conversationId: { required: true, type: "string" } } });
const sendMessageValidation = validate({
  params: { conversationId: { required: true, type: "string" } },
  body: { content: { required: true, type: "string", minLength: 1 } }
});

router.get("/conversations", authMiddleware, commonQueryValidation, chatController.listConversations);
router.post("/direct/:userId", authMiddleware, userIdValidation, chatController.createOrFindDirect);
router.get("/conversations/:conversationId/messages", authMiddleware, conversationValidation, commonQueryValidation, chatController.getMessages);
router.post("/conversations/:conversationId/messages", authMiddleware, sendMessageValidation, chatController.sendMessage);
router.post("/conversations/:conversationId/read", authMiddleware, conversationValidation, chatController.markConversationRead);

module.exports = router;
