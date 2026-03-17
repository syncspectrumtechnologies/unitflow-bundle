const router = require("express").Router();
const authController = require("../controllers/authController");
const authMiddleware = require("../middlewares/authMiddleware");
const { validate } = require("../middlewares/validateRequest");

const loginValidation = validate({
  body: {
    email: { required: true, type: "email" },
    password: { required: true, type: "string", minLength: 6 }
  }
});

const requestOtpValidation = validate({
  body: {
    email: { required: true, type: "email" }
  }
});

const resetPasswordValidation = validate({
  body: {
    email: { required: true, type: "email" },
    otp: { required: true, type: "string", minLength: 4 }
  },
  custom(req) {
    const nextPassword = req.body?.new_password || req.body?.password;
    if (!nextPassword || String(nextPassword).length < 6) {
      return [{ field: "body.new_password", message: "new_password or password must be at least 6 characters" }];
    }
    return [];
  }
});

router.post("/login", loginValidation, authController.login);
router.get("/me", authMiddleware, authController.me);
router.post("/forgot-password/request-otp", requestOtpValidation, authController.requestPasswordResetOtp);
router.post("/forgot-password/reset", resetPasswordValidation, authController.resetOwnPasswordWithOtp);

module.exports = router;
