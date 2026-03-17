const express = require("express");
const router = express.Router();

const authMiddleware = require("../middlewares/authMiddleware");
const permissionMiddleware = require("../middlewares/permissionMiddleware");
const { validate, commonQueryValidation } = require("../middlewares/validateRequest");
const factoryController = require("../controllers/factoryController");

const factoryValidation = validate({
  body: {
    name: { required: true, type: "string", minLength: 1 },
    code: { type: "string" },
    address: { type: "string" },
    is_active: { type: "boolean" }
  }
});
const idValidation = validate({ params: { id: { required: true, type: "string" } } });

router.use(authMiddleware);
router.get("/", commonQueryValidation, permissionMiddleware(["factories.view"]), factoryController.getFactories);
router.post("/", factoryValidation, permissionMiddleware(["factories.create"]), factoryController.createFactory);
router.put("/:id", idValidation, factoryValidation, permissionMiddleware(["factories.update"]), factoryController.updateFactory);

module.exports = router;
