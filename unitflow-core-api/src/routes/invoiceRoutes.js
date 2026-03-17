const express = require("express");
const router = express.Router();

const authMiddleware = require("../middlewares/authMiddleware");
const factoryAccessMiddleware = require("../middlewares/factoryAccessMiddleware");
const permissionMiddleware = require("../middlewares/permissionMiddleware");
const idempotencyMiddleware = require("../middlewares/idempotencyMiddleware");
const { validate, commonQueryValidation } = require("../middlewares/validateRequest");

const invoiceController = require("../controllers/invoiceController");

const idParamValidation = validate({ params: { id: { required: true, type: "string" } } });
const statusValidation = validate({
  params: { id: { required: true, type: "string" } },
  body: {
    status: { required: true, type: "enum", values: ["DRAFT", "PENDING", "SENT", "PARTIALLY_PAID", "PAID", "OVERDUE", "VOID"] },
    note: { type: "string" }
  }
});
const createInvoiceValidation = validate({
  body: {
    client_id: { type: "string" },
    order_id: { type: "string" },
    kind: { type: "enum", values: ["PROFORMA", "TAX_INVOICE", "CREDIT_NOTE", "DEBIT_NOTE"] },
    issue_date: { type: "date" },
    due_date: { type: "date" },
    notes: { type: "string" },
    items: { type: "array" },
    charges: { type: "array" }
  },
  custom(req) {
    const hasOrderId = !!req.body?.order_id;
    if (!hasOrderId && !req.body?.client_id) return [{ field: "body.client_id", message: "is required when order_id is not provided" }];
    if (!hasOrderId && (!Array.isArray(req.body?.items) || req.body.items.length === 0)) {
      return [{ field: "body.items", message: "must contain at least 1 item when order_id is not provided" }];
    }
    return [];
  }
});

router.use(authMiddleware);
router.use(factoryAccessMiddleware);

router.get("/", commonQueryValidation, permissionMiddleware(["invoices.view"]), invoiceController.getInvoices);
router.get("/:id", idParamValidation, permissionMiddleware(["invoices.view"]), invoiceController.getInvoiceById);
router.post("/", createInvoiceValidation, idempotencyMiddleware(), permissionMiddleware(["invoices.create"]), invoiceController.createInvoice);
router.put("/:id", idParamValidation, createInvoiceValidation, permissionMiddleware(["invoices.update"]), invoiceController.updateInvoice);
router.put("/:id/status", statusValidation, permissionMiddleware(["invoices.status"]), invoiceController.updateInvoiceStatus);
router.get("/:id/pdf", idParamValidation, permissionMiddleware(["invoices.pdf.view"]), invoiceController.getInvoicePdf);
router.post("/:id/send", idParamValidation, permissionMiddleware(["invoices.send"]), invoiceController.sendInvoicePdf);
router.post("/:id/remind", idParamValidation, permissionMiddleware(["invoices.remind"]), invoiceController.sendInvoiceReminder);

module.exports = router;
