const express = require("express");
const router = express.Router();

const authMiddleware = require("../middlewares/authMiddleware");
const factoryAccessMiddleware = require("../middlewares/factoryAccessMiddleware");
const permissionMiddleware = require("../middlewares/permissionMiddleware");
const { validate, commonQueryValidation } = require("../middlewares/validateRequest");
const inventoryMovementController = require("../controllers/inventoryMovementController");

const movementValidation = validate({
  body: {
    product_id: { required: true, type: "string" },
    quantity: { required: true, type: "number", min: 0.01 },
    remarks: { type: "string" },
    date: { type: "date" },
    movement_date: { type: "date" }
  }
});

router.use(authMiddleware);
router.use(factoryAccessMiddleware);
router.get("/stock", commonQueryValidation, permissionMiddleware(["inventory.view"]), inventoryMovementController.getStock);
router.get("/stock-summary", commonQueryValidation, permissionMiddleware(["inventory.view"]), inventoryMovementController.getStockSummary);
router.get("/movements", commonQueryValidation, permissionMiddleware(["inventory.view"]), inventoryMovementController.getMovements);
router.post("/movements/in", movementValidation, permissionMiddleware(["inventory.create"]), inventoryMovementController.createIn);
router.post("/movements/out", movementValidation, permissionMiddleware(["inventory.create"]), inventoryMovementController.createOut);
router.post("/movements/adjustment", movementValidation, permissionMiddleware(["inventory.update"]), inventoryMovementController.createAdjustment);

module.exports = router;
