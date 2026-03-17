const express = require("express");
const router = express.Router();

const authMiddleware = require("../middlewares/authMiddleware");
const factoryAccessMiddleware = require("../middlewares/factoryAccessMiddleware");
const permissionMiddleware = require("../middlewares/permissionMiddleware");
const idempotencyMiddleware = require("../middlewares/idempotencyMiddleware");
const { validate, commonQueryValidation } = require("../middlewares/validateRequest");

const paymentController = require("../controllers/paymentController");

const createPaymentValidation = validate({
  body: {
    client_id: { type: "string" },
    order_id: { type: "string" },
    amount: { required: true, type: "number", min: 0.01 },
    method: { required: true, type: "enum", values: ["CASH", "BANK_TRANSFER", "UPI", "CHEQUE", "CARD", "OTHER"] },
    paid_at: { type: "date" },
    note: { type: "string" },
    allocations: { type: "array" }
  }
});

router.use(authMiddleware);
router.use(factoryAccessMiddleware);

router.get("/", commonQueryValidation, permissionMiddleware(["payments.view"]), paymentController.getPayments);
router.post("/", createPaymentValidation, idempotencyMiddleware(), permissionMiddleware(["payments.create"]), paymentController.createPayment);

module.exports = router;
