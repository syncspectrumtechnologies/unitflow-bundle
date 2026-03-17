const express = require("express");
const router = express.Router();

const authMiddleware = require("../middlewares/authMiddleware");
const factoryAccessMiddleware = require("../middlewares/factoryAccessMiddleware");
const permissionMiddleware = require("../middlewares/permissionMiddleware");
const { validate, commonQueryValidation } = require("../middlewares/validateRequest");
const productionController = require("../controllers/productionController");

const idValidation = validate({ params: { id: { type: "string" } } });
const productionValidation = validate({
  body: {
    product_id: { required: true, type: "string" },
    quantity: { required: true, type: "number", min: 0.01 },
    produced_at: { type: "date" },
    remarks: { type: "string" }
  }
});

router.use(authMiddleware);
router.use(factoryAccessMiddleware);
router.post("/", productionValidation, permissionMiddleware(["production.create"]), productionController.createProduction);
router.get("/", commonQueryValidation, permissionMiddleware(["production.view"]), productionController.getProduction);
router.put("/:id", idValidation, productionValidation, permissionMiddleware(["production.update"]), productionController.updateProduction);

module.exports = router;
