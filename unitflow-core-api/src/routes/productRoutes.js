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
    tax_class_id: { type: "string" },
    sku: { type: "string" },
    unit: { required: true, type: "string" },
    price: { type: "number", min: 0 },
    hsn_sac_code: { type: "string" },
    gst_rate: { type: "number", min: 0 },
    cess_rate: { type: "number", min: 0 },
    tracking_mode: { type: "enum", values: ["NONE", "BARCODE_ONLY", "SERIAL_ONLY", "BATCH_ONLY", "BATCH_EXPIRY", "SERIAL_BATCH", "SERIAL_BATCH_EXPIRY"] },
    shelf_life_days: { type: "integer", min: 0 },
    pack_size: { type: "string" },
    description: { type: "string" },
    primary_barcode: { type: "string" }
  }
});
const productUpdateValidation = validate({
  body: {
    name: { type: "string", minLength: 1 },
    category_id: { type: "string" },
    tax_class_id: { type: "string" },
    sku: { type: "string" },
    unit: { type: "string" },
    price: { type: "number", min: 0 },
    hsn_sac_code: { type: "string" },
    gst_rate: { type: "number", min: 0 },
    cess_rate: { type: "number", min: 0 },
    tracking_mode: { type: "enum", values: ["NONE", "BARCODE_ONLY", "SERIAL_ONLY", "BATCH_ONLY", "BATCH_EXPIRY", "SERIAL_BATCH", "SERIAL_BATCH_EXPIRY"] },
    shelf_life_days: { type: "integer", min: 0 },
    pack_size: { type: "string" },
    description: { type: "string" },
    is_active: { type: "boolean" }
  }
});
const idValidation = validate({ params: { id: { required: true, type: "string" } } });
const barcodeValidation = validate({ params: { id: { required: true, type: "string" } }, body: { code: { required: true, type: "string", minLength: 1 }, alias_type: { type: "string" }, is_primary: { type: "boolean" } } });
const barcodeIdValidation = validate({ params: { id: { required: true, type: "string" }, barcodeId: { required: true, type: "string" } } });

router.use(authMiddleware);
router.post("/", productValidation, permissionMiddleware(["products.create"]), productController.createProduct);
router.get("/", commonQueryValidation, permissionMiddleware(["products.view"]), productController.getProducts);
router.get("/:id", idValidation, permissionMiddleware(["products.view"]), productController.getProductById);
router.put("/:id", idValidation, productUpdateValidation, permissionMiddleware(["products.update"]), productController.updateProduct);
router.delete("/:id", idValidation, permissionMiddleware(["products.delete"]), productController.deleteProduct);
router.post("/:id/barcodes", barcodeValidation, permissionMiddleware(["products.update"]), productController.addProductBarcode);
router.delete("/:id/barcodes/:barcodeId", barcodeIdValidation, permissionMiddleware(["products.update"]), productController.removeProductBarcode);

module.exports = router;
