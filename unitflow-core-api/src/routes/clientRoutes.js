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
    notes: { type: "string" }
  }
});
const clientIdValidation = validate({ params: { clientId: { required: true, type: "string" } } });
const inactiveValidation = validate({ query: { days: { type: "integer", min: 1 } } });

router.use(authMiddleware);
router.post("/", factoryAccessMiddleware, clientValidation, permissionMiddleware(["clients.create"]), clientController.createClient);
router.get("/", factoryAccessMiddleware, commonQueryValidation, permissionMiddleware(["clients.view"]), clientController.getClients);
router.get("/inactive", factoryAccessMiddleware, commonQueryValidation, inactiveValidation, permissionMiddleware(["clients.view"]), clientController.getInactiveClients);
router.get("/:clientId", factoryAccessMiddleware, clientIdValidation, permissionMiddleware(["clients.view"]), clientController.getClientById);
router.put("/:clientId", factoryAccessMiddleware, clientIdValidation, clientValidation, permissionMiddleware(["clients.update"]), clientController.updateClient);
router.delete("/:clientId", factoryAccessMiddleware, clientIdValidation, permissionMiddleware(["clients.delete"]), clientController.deleteClient);
router.get("/:clientId/orders", factoryAccessMiddleware, clientIdValidation, commonQueryValidation, permissionMiddleware(["clients.view"]), clientController.getClientOrderHistory);
router.get("/:clientId/products", factoryAccessMiddleware, clientIdValidation, permissionMiddleware(["clients.view"]), clientController.getClientProducts);
router.get("/:clientId/slip.pdf", factoryAccessMiddleware, clientIdValidation, permissionMiddleware(["clients.view"]), clientController.getClientSlipPdf);
router.post("/:clientId/letter.pdf", factoryAccessMiddleware, clientIdValidation, permissionMiddleware(["clients.view"]), clientController.generateClientLetterPdf);
router.post("/:clientId/re-engage", factoryAccessMiddleware, clientIdValidation, permissionMiddleware(["clients.update"]), clientController.reEngageClient);

module.exports = router;
