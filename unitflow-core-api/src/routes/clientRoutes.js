const express = require("express");
const router = express.Router();

const authMiddleware = require("../middlewares/authMiddleware");
const permissionMiddleware = require("../middlewares/permissionMiddleware");
const factoryAccessMiddleware = require("../middlewares/factoryAccessMiddleware");
const { validate, commonQueryValidation } = require("../middlewares/validateRequest");
const clientController = require("../controllers/clientController");

const clientValidation = validate({
  body: {
    company_name: { required: true, type: "string", minLength: 1 },
    email: { type: "email" },
    phone: { type: "string" },
    address: { type: "string" },
    gstin: { type: "string" },
    gst_registration_type: { type: "enum", values: ["REGISTERED", "UNREGISTERED", "COMPOSITION", "EXPORT", "SEZ", "EXEMPT"] },
    state_code: { type: "string" },
    state: { type: "string" },
    city: { type: "string" },
    pincode: { type: "string" },
    notes: { type: "string" }
  }
});

const clientIdValidation = validate({
  params: { clientId: { required: true, type: "string" } }
});

const inactiveValidation = validate({
  query: { days: { type: "integer", min: 1 } }
});

router.use(authMiddleware);

// Client master is company-scoped, not factory-scoped
router.post("/", clientValidation, permissionMiddleware(["clients.create"]), clientController.createClient);
router.get("/", commonQueryValidation, permissionMiddleware(["clients.view"]), clientController.getClients);
router.get("/inactive", commonQueryValidation, inactiveValidation, permissionMiddleware(["clients.view"]), clientController.getInactiveClients);
router.get("/:clientId", clientIdValidation, permissionMiddleware(["clients.view"]), clientController.getClientById);
router.put("/:clientId", clientIdValidation, clientValidation, permissionMiddleware(["clients.update"]), clientController.updateClient);
router.delete("/:clientId", clientIdValidation, permissionMiddleware(["clients.delete"]), clientController.deleteClient);
router.get("/:clientId/products", clientIdValidation, permissionMiddleware(["clients.view"]), clientController.getClientProducts);
router.get("/:clientId/slip.pdf", clientIdValidation, permissionMiddleware(["clients.view"]), clientController.getClientSlipPdf);
router.post("/:clientId/letter.pdf", clientIdValidation, permissionMiddleware(["clients.view"]), clientController.generateClientLetterPdf);
router.post("/:clientId/re-engage", clientIdValidation, permissionMiddleware(["clients.update"]), clientController.reEngageClient);

// Order history can stay factory-aware because orders themselves are factory-scoped
router.get("/:clientId/orders", factoryAccessMiddleware, clientIdValidation, commonQueryValidation, permissionMiddleware(["clients.view"]), clientController.getClientOrderHistory);

module.exports = router;