const express = require("express");
const router = express.Router();

const adminController = require("../controllers/adminController");
const { validate, commonQueryValidation } = require("../middlewares/validateRequest");

const authMod = require("../middlewares/authMiddleware");
const permMod = require("../middlewares/permissionMiddleware");

function pickFn(mod, candidates, label) {
  for (const k of candidates) {
    if (typeof mod?.[k] === "function") return mod[k];
  }
  if (typeof mod === "function") return mod;
  throw new Error(`${label}: could not resolve function export. Available keys: ${Object.keys(mod || {}).join(", ")}`);
}

const requireAuth = pickFn(authMod, ["requireAuth", "authMiddleware", "auth"], "authMiddleware");

let requirePermission = null;
if (typeof permMod === "function") {
  if (permMod.length <= 1) requirePermission = permMod;
} else {
  requirePermission =
    (typeof permMod.requirePermission === "function" && permMod.requirePermission) ||
    (typeof permMod.permissionMiddleware === "function" && permMod.permissionMiddleware) ||
    null;
}

if (typeof requirePermission !== "function") {
  throw new Error(
    `permissionMiddleware: expected a permission factory function. Exports found: ${Object.keys(permMod || {}).join(", ")}`
  );
}

function assertFn(fn, name) {
  if (typeof fn !== "function") throw new Error(`adminRoutes: handler "${name}" is not a function (got ${typeof fn})`);
}

[
  "getUsers",
  "getUserAssignments",
  "createUser",
  "disableUser",
  "enableUser",
  "getOnlineUsers",
  "resetUserPassword",
  "getRoles",
  "createRole",
  "assignRole",
  "removeRole",
  "assignFactory",
  "removeFactory",
  "grantUserPermissions",
  "revokeUserPermission",
  "grantRolePermissions",
  "revokeRolePermission"
].forEach((key) => assertFn(adminController[key], `adminController.${key}`));

const userIdValidation = validate({ params: { userId: { required: true, type: "string" } } });
const roleIdValidation = validate({ params: { roleId: { required: true, type: "string" } } });
const userCreateValidation = validate({
  body: {
    name: { required: true, type: "string", minLength: 1 },
    email: { required: true, type: "email" },
    password: { required: true, type: "string", minLength: 6 },
    is_admin: { type: "boolean" }
  }
});
const passwordResetValidation = validate({
  params: { userId: { required: true, type: "string" } },
  custom(req) {
    const value = req.body?.new_password || req.body?.password;
    if (!value || String(value).length < 6) {
      return [{ field: "body.new_password", message: "new_password or password must be at least 6 characters" }];
    }
    return [];
  }
});
const createRoleValidation = validate({
  body: {
    name: { required: true, type: "string", minLength: 1 },
    description: { type: "string" }
  }
});
const assignRoleValidation = validate({
  params: { userId: { required: true, type: "string" } },
  body: { role_id: { required: true, type: "string" } }
});
const removeRoleValidation = validate({ params: { userId: { required: true, type: "string" }, roleId: { required: true, type: "string" } } });
const assignFactoryValidation = validate({
  params: { userId: { required: true, type: "string" } },
  body: { factory_id: { required: true, type: "string" } }
});
const removeFactoryValidation = validate({ params: { userId: { required: true, type: "string" }, factoryId: { required: true, type: "string" } } });
const permissionGrantValidation = validate({
  body: { permission_keys: { required: true, type: "array", minItems: 1 } },
  params: { userId: { type: "string" }, roleId: { type: "string" } }
});
const permissionRevokeValidation = validate({
  params: {
    userId: { type: "string" },
    roleId: { type: "string" },
    permissionKey: { required: true, type: "string" }
  }
});

router.get("/users", requireAuth, commonQueryValidation, requirePermission("admin.access"), adminController.getUsers);
router.get("/users/assignments", requireAuth, commonQueryValidation, requirePermission("admin.access"), adminController.getUserAssignments);
router.post("/users", requireAuth, userCreateValidation, requirePermission("admin.access"), adminController.createUser);
router.put("/users/:userId/disable", requireAuth, userIdValidation, requirePermission("admin.access"), adminController.disableUser);
router.put("/users/:userId/enable", requireAuth, userIdValidation, requirePermission("admin.access"), adminController.enableUser);
router.put("/users/:userId/password", requireAuth, passwordResetValidation, requirePermission("admin.access"), adminController.resetUserPassword);
router.get("/users/online", requireAuth, requirePermission("admin.access"), adminController.getOnlineUsers);
router.get("/roles", requireAuth, requirePermission("admin.access"), adminController.getRoles);
router.post("/roles", requireAuth, createRoleValidation, requirePermission("admin.access"), adminController.createRole);
router.post("/users/:userId/roles", requireAuth, assignRoleValidation, requirePermission("admin.access"), adminController.assignRole);
router.delete("/users/:userId/roles/:roleId", requireAuth, removeRoleValidation, requirePermission("admin.access"), adminController.removeRole);
router.post("/users/:userId/factories", requireAuth, assignFactoryValidation, requirePermission("admin.access"), adminController.assignFactory);
router.delete("/users/:userId/factories/:factoryId", requireAuth, removeFactoryValidation, requirePermission("admin.access"), adminController.removeFactory);
router.post("/users/:userId/permissions", requireAuth, permissionGrantValidation, requirePermission("admin.access"), adminController.grantUserPermissions);
router.delete("/users/:userId/permissions/:permissionKey", requireAuth, permissionRevokeValidation, requirePermission("admin.access"), adminController.revokeUserPermission);
router.post("/roles/:roleId/permissions", requireAuth, permissionGrantValidation, requirePermission("admin.access"), adminController.grantRolePermissions);
router.delete("/roles/:roleId/permissions/:permissionKey", requireAuth, permissionRevokeValidation, requirePermission("admin.access"), adminController.revokeRolePermission);

module.exports = router;
