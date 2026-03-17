const express = require("express");
const router = express.Router();

const authMiddleware = require("../middlewares/authMiddleware");
const factoryAccessMiddleware = require("../middlewares/factoryAccessMiddleware");
const permissionMiddleware = require("../middlewares/permissionMiddleware");
const { validate, commonQueryValidation } = require("../middlewares/validateRequest");

const orderController = require("../controllers/orderController");

const orderMutationValidation = validate({
  body: {
    client_id: { type: "string" },
    sales_company_id: { type: "string" },
    order_date: { type: "date" },
    notes: { type: "string" },
    items: { type: "array" },
    charges: { type: "array" }
  },
  custom(req) {
    if (req.method === "POST" && (!Array.isArray(req.body?.items) || req.body.items.length === 0)) {
      return [{ field: "body.items", message: "must contain at least 1 item" }];
    }
    if (req.method === "POST" && !req.body?.client_id) {
      return [{ field: "body.client_id", message: "is required" }];
    }
    return [];
  }
});

const orderStatusValidation = validate({
  params: { id: { required: true, type: "string" } },
  body: {
    status: { required: true, type: "enum", values: ["DRAFT", "CONFIRMED", "PROCESSING", "DISPATCHED", "COMPLETED", "SHIPPED", "DELIVERED", "CANCELLED", "CLOSED", "dispatch", "complete", "DISPATCH", "COMPLETE"] },
    note: { type: "string" },
    allocations: { type: "array" },
    fulfillments: { type: "array" },
    items: { type: "array" }
  }
});

const idParamValidation = validate({ params: { id: { required: true, type: "string" } } });
const proformaPreviewValidation = validate({ body: { items: { required: true, type: "array", minItems: 1 } } });

router.use(authMiddleware);
router.use(factoryAccessMiddleware);

router.get("/", commonQueryValidation, permissionMiddleware(["orders.view"]), orderController.getOrders);
router.get("/recent", commonQueryValidation, permissionMiddleware(["orders.view"]), orderController.getRecentOrders);
router.get("/pending", commonQueryValidation, permissionMiddleware(["orders.view"]), orderController.getPendingOrders);
router.get("/:id", idParamValidation, permissionMiddleware(["orders.view"]), orderController.getOrderById);
router.post("/", orderMutationValidation, permissionMiddleware(["orders.create"]), orderController.createOrder);
router.put("/:id", idParamValidation, orderMutationValidation, permissionMiddleware(["orders.update"]), orderController.updateOrder);
router.put("/:id/status", orderStatusValidation, permissionMiddleware(["orders.status"]), orderController.updateOrderStatus);
router.put("/:id/cancel", idParamValidation, permissionMiddleware(["orders.cancel"]), orderController.cancelOrder);
router.get("/:id/label", idParamValidation, permissionMiddleware(["orders.label.view"]), orderController.getOrderLabelPdf);
router.get("/:id/proforma", idParamValidation, permissionMiddleware(["orders.view"]), orderController.getOrderProformaPdf);
router.get("/:id/proforma.pdf", idParamValidation, permissionMiddleware(["orders.view"]), orderController.getOrderProformaPdf);
router.post("/proforma/preview", proformaPreviewValidation, permissionMiddleware(["orders.view"]), orderController.proformaPreviewFromPayload);
router.post("/proforma/preview.pdf", proformaPreviewValidation, permissionMiddleware(["orders.view"]), orderController.proformaPreviewFromPayload);
router.get("/:id/label.pdf", idParamValidation, permissionMiddleware(["orders.label.view"]), orderController.getOrderLabelPdf);
router.post("/:id/send-label", idParamValidation, permissionMiddleware(["orders.label.send"]), orderController.sendOrderLabel);

module.exports = router;
