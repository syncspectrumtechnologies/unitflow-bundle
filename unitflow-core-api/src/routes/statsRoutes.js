const express = require("express");
const router = express.Router();

const authMiddleware = require("../middlewares/authMiddleware");
const permissionMiddleware = require("../middlewares/permissionMiddleware");
const { commonQueryValidation } = require("../middlewares/validateRequest");
const statsController = require("../controllers/statsController");

router.use(authMiddleware);
router.get("/", commonQueryValidation, permissionMiddleware(["stats.view"]), statsController.getCompanyStats);

module.exports = router;
