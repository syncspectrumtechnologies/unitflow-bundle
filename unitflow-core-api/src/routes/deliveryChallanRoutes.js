const express = require("express");
const router = express.Router();

const authMiddleware = require("../middlewares/authMiddleware");
const factoryAccessMiddleware = require("../middlewares/factoryAccessMiddleware");
const permissionMiddleware = require("../middlewares/permissionMiddleware");
const { validate, commonQueryValidation } = require("../middlewares/validateRequest");
const deliveryChallanController = require("../controllers/deliveryChallanController");

const idValidation = validate({ params: { id: { required: true, type: "string" } } });
const mutationValidation = validate({
  body: {
    client_id: { type: "string" },
    order_id: { type: "string" },
    sales_company_id: { type: "string" },
    challan_no: { type: "string" },
    kind: { type: "enum", values: ["OUTWARD", "INWARD", "JOB_WORK", "RETURNABLE", "NON_RETURNABLE"] },
    reason: { type: "enum", values: ["SALE", "RETURN", "JOB_WORK", "SAMPLE", "OTHER"] },
    status: { type: "enum", values: ["DRAFT", "ISSUED", "CLOSED", "CANCELLED"] },
    issue_date: { type: "date" },
    place_of_supply_state: { type: "string" },
    place_of_supply_code: { type: "string" },
    notes: { type: "string" },
    items: { type: "array" }
  },
  custom(req) {
    if (["POST", "PUT"].includes(req.method) && req.body?.items !== undefined) {
      if (!Array.isArray(req.body.items) || req.body.items.length === 0) {
        return [{ field: "body.items", message: "must contain at least 1 item" }];
      }
    }
    return [];
  }
});
const statusValidation = validate({ params: { id: { required: true, type: "string" } }, body: { status: { required: true, type: "enum", values: ["DRAFT", "ISSUED", "CLOSED", "CANCELLED"] } } });

router.use(authMiddleware);
router.use(factoryAccessMiddleware);

router.get("/", commonQueryValidation, permissionMiddleware(["orders.view"]), deliveryChallanController.getDeliveryChallans);
router.get("/:id", idValidation, permissionMiddleware(["orders.view"]), deliveryChallanController.getDeliveryChallanById);
router.post("/", mutationValidation, permissionMiddleware(["orders.create"]), deliveryChallanController.createDeliveryChallan);
router.put("/:id", idValidation, mutationValidation, permissionMiddleware(["orders.update"]), deliveryChallanController.updateDeliveryChallan);
router.put("/:id/status", statusValidation, permissionMiddleware(["orders.status"]), deliveryChallanController.updateDeliveryChallanStatus);
router.get("/:id/pdf", idValidation, permissionMiddleware(["orders.view"]), deliveryChallanController.getDeliveryChallanPdf);

module.exports = router;
