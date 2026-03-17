const express = require("express");
const router = express.Router();

const authMiddleware = require("../middlewares/authMiddleware");
const factoryAccessMiddleware = require("../middlewares/factoryAccessMiddleware");
const permissionMiddleware = require("../middlewares/permissionMiddleware");
const { validate, commonQueryValidation } = require("../middlewares/validateRequest");

const purchaseController = require("../controllers/purchaseController");

const idParamValidation = validate({ params: { id: { required: true, type: "string" } } });
const purchaseValidation = validate({
  body: {
    purchase_no: { required: true, type: "string", minLength: 1 },
    purchase_date: { type: "date" },
    vendor_name: { required: true, type: "string", minLength: 1 },
    vendor_email: { type: "email" },
    vendor_phone: { type: "string" },
    vendor_address: { type: "string" },
    items: { required: true, type: "array", minItems: 1 },
    charges: { type: "array" },
    notes: { type: "string" }
  }
});
const purchaseStatusValidation = validate({
  params: { id: { required: true, type: "string" } },
  body: {
    status: { required: true, type: "enum", values: ["DRAFT", "ORDERED", "RECEIVED", "CANCELLED", "CLOSED"] },
    note: { type: "string" }
  }
});

router.use(authMiddleware);
router.use(factoryAccessMiddleware);
router.get("/", commonQueryValidation, permissionMiddleware(["purchases.view"]), purchaseController.getPurchases);
router.get("/:id", idParamValidation, permissionMiddleware(["purchases.view"]), purchaseController.getPurchaseById);
router.post("/", purchaseValidation, permissionMiddleware(["purchases.create"]), purchaseController.createPurchase);
router.put("/:id", idParamValidation, purchaseValidation, permissionMiddleware(["purchases.update"]), purchaseController.updatePurchase);
router.put("/:id/status", purchaseStatusValidation, permissionMiddleware(["purchases.status"]), purchaseController.updatePurchaseStatus);
router.get("/:id/pdf", idParamValidation, permissionMiddleware(["purchases.pdf"]), purchaseController.getPurchasePdf);

module.exports = router;
