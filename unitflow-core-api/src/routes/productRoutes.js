const express = require("express");
const router = express.Router();

const authMiddleware = require("../middlewares/authMiddleware");
const permissionMiddleware = require("../middlewares/permissionMiddleware");
const { validate, commonQueryValidation } = require("../middlewares/validateRequest");
const productController = require("../controllers/productController");

const productValidation = validate({
  body: {
    name: { required: true, type: "string", minLength: 1 },
    category_id: { type: "string" },
    sku: { type: "string" },
    unit: { type: "string" },
    unit_price: { type: "number", min: 0 },
    price: { type: "number", min: 0 },
    description: { type: "string" }
  }
});
const idValidation = validate({ params: { id: { required: true, type: "string" } } });

router.use(authMiddleware);
router.post("/", productValidation, permissionMiddleware(["products.create"]), productController.createProduct);
router.get("/", commonQueryValidation, permissionMiddleware(["products.view"]), productController.getProducts);
router.get("/:id", idValidation, permissionMiddleware(["products.view"]), productController.getProductById);
router.put("/:id", idValidation, productValidation, permissionMiddleware(["products.update"]), productController.updateProduct);
router.delete("/:id", idValidation, permissionMiddleware(["products.delete"]), productController.deleteProduct);

module.exports = router;
