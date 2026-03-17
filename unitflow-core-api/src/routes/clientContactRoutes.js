const express = require("express");
const router = express.Router();

const authMiddleware = require("../middlewares/authMiddleware");
const permissionMiddleware = require("../middlewares/permissionMiddleware");
const factoryAccessMiddleware = require("../middlewares/factoryAccessMiddleware");
const { validate } = require("../middlewares/validateRequest");
const clientContactController = require("../controllers/clientContactController");

const clientAndContactIdValidation = validate({
  params: {
    clientId: { required: true, type: "string" },
    contactId: { type: "string" }
  }
});
const contactValidation = validate({
  body: {
    name: { required: true, type: "string", minLength: 1 },
    email: { type: "email" },
    phone: { type: "string" },
    designation: { type: "string" }
  }
});

router.use(authMiddleware);
router.use(factoryAccessMiddleware);
router.get("/:clientId/contacts", clientAndContactIdValidation, permissionMiddleware(["client_contacts.view"]), clientContactController.getContactsByClient);
router.post("/:clientId/contacts", clientAndContactIdValidation, contactValidation, permissionMiddleware(["client_contacts.create"]), clientContactController.createContact);
router.put("/:clientId/contacts/:contactId", clientAndContactIdValidation, contactValidation, permissionMiddleware(["client_contacts.update"]), clientContactController.updateContact);
router.delete("/:clientId/contacts/:contactId", clientAndContactIdValidation, permissionMiddleware(["client_contacts.delete"]), clientContactController.deleteContact);

module.exports = router;
