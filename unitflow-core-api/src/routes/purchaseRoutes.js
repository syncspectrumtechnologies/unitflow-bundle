const express = require("express");
const router = express.Router();

const authMiddleware = require("../middlewares/authMiddleware");
const factoryAccessMiddleware = require("../middlewares/factoryAccessMiddleware");
const permissionMiddleware = require("../middlewares/permissionMiddleware");
const { validate, commonQueryValidation } = require("../middlewares/validateRequest");

const purchaseController = require("../controllers/purchaseController");

const idParamValidation = validate({ params: { id: { required: true, type: "string" } } });
const receiptIdValidation = validate({ params: { receiptId: { required: true, type: "string" } } });
const returnIdValidation = validate({ params: { returnId: { required: true, type: "string" } } });
const purchaseValidation = validate({
  body: {
    purchase_no: { type: "string" },
    purchase_date: { type: "date" },
    status: { type: "enum", values: ["DRAFT", "ORDERED", "PARTIALLY_RECEIVED", "RECEIVED", "CANCELLED", "CLOSED"] },
    vendor_name: { required: true, type: "string", minLength: 1 },
    vendor_email: { type: "email" },
    vendor_phone: { type: "string" },
    vendor_address: { type: "string" },
    vendor_gstin: { type: "string" },
    vendor_gst_registration_type: { type: "enum", values: ["REGISTERED", "UNREGISTERED", "COMPOSITION", "EXPORT", "SEZ", "EXEMPT"] },
    vendor_state: { type: "string" },
    vendor_state_code: { type: "string" },
    items: { required: true, type: "array", minItems: 1 },
    charges: { type: "array" },
    notes: { type: "string" }
  }
});
const purchaseUpdateValidation = validate({
  body: {
    purchase_no: { type: "string" },
    purchase_date: { type: "date" },
    status: { type: "enum", values: ["DRAFT", "ORDERED", "PARTIALLY_RECEIVED", "RECEIVED", "CANCELLED", "CLOSED"] },
    vendor_name: { type: "string", minLength: 1 },
    vendor_email: { type: "email" },
    vendor_phone: { type: "string" },
    vendor_address: { type: "string" },
    vendor_gstin: { type: "string" },
    vendor_gst_registration_type: { type: "enum", values: ["REGISTERED", "UNREGISTERED", "COMPOSITION", "EXPORT", "SEZ", "EXEMPT"] },
    vendor_state: { type: "string" },
    vendor_state_code: { type: "string" },
    items: { type: "array" },
    charges: { type: "array" },
    notes: { type: "string" }
  }
});
const purchaseStatusValidation = validate({
  params: { id: { required: true, type: "string" } },
  body: {
    status: { required: true, type: "enum", values: ["DRAFT", "ORDERED", "PARTIALLY_RECEIVED", "RECEIVED", "CANCELLED", "CLOSED"] },
    note: { type: "string" }
  }
});
const receiptValidation = validate({
  params: { id: { required: true, type: "string" } },
  body: {
    receipt_no: { type: "string" },
    receipt_date: { type: "date" },
    status: { type: "enum", values: ["DRAFT", "APPROVED", "DISPATCHED", "COMPLETED", "CANCELLED"] },
    notes: { type: "string" },
    items: { required: true, type: "array", minItems: 1 }
  }
});
const supplierReturnValidation = validate({
  params: { id: { required: true, type: "string" } },
  body: {
    return_no: { type: "string" },
    debit_note_no: { type: "string" },
    return_date: { type: "date" },
    status: { type: "enum", values: ["DRAFT", "APPROVED", "DISPATCHED", "COMPLETED", "CANCELLED"] },
    reason_summary: { type: "string" },
    notes: { type: "string" },
    items: { required: true, type: "array", minItems: 1 }
  }
});

router.use(authMiddleware);
router.use(factoryAccessMiddleware);
router.get("/", commonQueryValidation, permissionMiddleware(["purchases.view"]), purchaseController.getPurchases);
router.get("/reports/pending-receive", commonQueryValidation, permissionMiddleware(["purchases.view"]), purchaseController.getPendingPurchaseReceiveReport);
router.get("/reports/supplier-performance", commonQueryValidation, permissionMiddleware(["purchases.view"]), purchaseController.getSupplierPerformanceReport);
router.get("/reports/variance", commonQueryValidation, permissionMiddleware(["purchases.view"]), purchaseController.getPurchaseVarianceReport);
router.get("/:id", idParamValidation, permissionMiddleware(["purchases.view"]), purchaseController.getPurchaseById);
router.post("/", purchaseValidation, permissionMiddleware(["purchases.create"]), purchaseController.createPurchase);
router.put("/:id", idParamValidation, purchaseUpdateValidation, permissionMiddleware(["purchases.update"]), purchaseController.updatePurchase);
router.put("/:id/status", purchaseStatusValidation, permissionMiddleware(["purchases.status"]), purchaseController.updatePurchaseStatus);
router.get("/:id/pdf", idParamValidation, permissionMiddleware(["purchases.pdf"]), purchaseController.getPurchasePdf);

router.get("/:id/receipts", idParamValidation, permissionMiddleware(["purchases.view"]), purchaseController.getPurchaseReceipts);
router.post("/:id/receipts", receiptValidation, permissionMiddleware(["purchases.update"]), purchaseController.createPurchaseReceipt);
router.get("/receipts/:receiptId", receiptIdValidation, permissionMiddleware(["purchases.view"]), purchaseController.getPurchaseReceiptById);

router.get("/:id/returns", idParamValidation, permissionMiddleware(["purchases.view"]), purchaseController.getSupplierReturns);
router.post("/:id/returns", supplierReturnValidation, permissionMiddleware(["purchases.update"]), purchaseController.createSupplierReturn);
router.get("/returns/:returnId", returnIdValidation, permissionMiddleware(["purchases.view"]), purchaseController.getSupplierReturnById);

module.exports = router;
