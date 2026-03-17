const jwt = require("jsonwebtoken");
const crypto = require("crypto");

/**
 * Create a cryptographically-random JWT ID (jti).
 */
function newJti() {
  return crypto.randomBytes(16).toString("hex");
}

/**
 * Signs a JWT and injects a `jti` so sessions can be tracked/revoked.
 * Returns: { token, jti, expiresIn }
 */
exports.signToken = (payload) => {
  const jti = newJti();
  // Default to a long-lived session for ERP day-long usage.
  // Can be overridden via env (e.g. "8h", "12h", "1d").
  const expiresIn = process.env.JWT_EXPIRES_IN || "12h";

  const token = jwt.sign(
    { ...payload, jti },
    process.env.JWT_SECRET,
    { expiresIn }
  );

  return { token, jti, expiresIn };
};

exports.verifyToken = (token) => jwt.verify(token, process.env.JWT_SECRET);
exports.decodeToken = (token) => jwt.decode(token);
