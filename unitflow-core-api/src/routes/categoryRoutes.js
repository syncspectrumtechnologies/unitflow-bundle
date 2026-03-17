const express = require("express");
const router = express.Router();

const authMiddleware = require("../middlewares/authMiddleware");
const permissionMiddleware = require("../middlewares/permissionMiddleware");
const { validate, commonQueryValidation } = require("../middlewares/validateRequest");
const categoryController = require("../controllers/categoryController");

const categoryValidation = validate({
  body: {
    name: { required: true, type: "string", minLength: 1 },
    description: { type: "string" }
  }
});
const idValidation = validate({ params: { id: { required: true, type: "string" } } });

router.use(authMiddleware);
router.post("/", categoryValidation, permissionMiddleware(["categories.create"]), categoryController.createCategory);
router.get("/", commonQueryValidation, permissionMiddleware(["categories.view"]), categoryController.getCategories);
router.get("/:id", idValidation, permissionMiddleware(["categories.view"]), categoryController.getCategoryById);
router.put("/:id", idValidation, categoryValidation, permissionMiddleware(["categories.update"]), categoryController.updateCategory);
router.delete("/:id", idValidation, permissionMiddleware(["categories.delete"]), categoryController.deleteCategory);

module.exports = router;
