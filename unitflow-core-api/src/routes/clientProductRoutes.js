const express = require("express");
const router = express.Router();

const authMiddleware = require("../middlewares/authMiddleware");
const permissionMiddleware = require("../middlewares/permissionMiddleware");
const factoryAccessMiddleware = require("../middlewares/factoryAccessMiddleware");
const { validate } = require("../middlewares/validateRequest");
const clientProductController = require("../controllers/clientProductController");

const clientProductValidation = validate({
  params: {
    clientId: { required: true, type: "string" },
    productId: { type: "string" }
  },
  body: {
    product_id: { type: "string" },
    default_price: { type: "number", min: 0 }
  }
});

router.use(authMiddleware);
router.use(factoryAccessMiddleware);
router.post("/:clientId/products", clientProductValidation, permissionMiddleware(["client_products.create"]), clientProductController.addClientProduct);
router.delete("/:clientId/products/:productId", clientProductValidation, permissionMiddleware(["client_products.delete"]), clientProductController.removeClientProduct);

module.exports = router;
