const express = require("express");
const router = express.Router();

const authMiddleware = require("../middlewares/authMiddleware");
const permissionMiddleware = require("../middlewares/permissionMiddleware");
const { validate, commonQueryValidation } = require("../middlewares/validateRequest");
const taxClassController = require("../controllers/taxClassController");

const idValidation = validate({ params: { id: { required: true, type: "string" } } });
const mutationValidation = validate({
  body: {
    name: { type: "string" },
    description: { type: "string" },
    gst_rate: { type: "number", min: 0, max: 100 },
    cess_rate: { type: "number", min: 0, max: 100 }
  }
});

router.use(authMiddleware);
router.get("/", commonQueryValidation, permissionMiddleware(["products.view"]), taxClassController.listTaxClasses);
router.get("/:id", idValidation, permissionMiddleware(["products.view"]), taxClassController.getTaxClassById);
router.post("/", mutationValidation, permissionMiddleware(["products.create"]), taxClassController.createTaxClass);
router.put("/:id", idValidation, mutationValidation, permissionMiddleware(["products.update"]), taxClassController.updateTaxClass);

module.exports = router;
