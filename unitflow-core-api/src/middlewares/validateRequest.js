function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function pushError(errors, field, message) {
  errors.push({ field, message });
}

function applyRule(containerName, source, field, rule, errors) {
  const value = source?.[field];
  const label = `${containerName}.${field}`;
  const exists = value !== undefined && value !== null && !(typeof value === "string" && value.trim() === "");

  if (rule.required && !exists) {
    pushError(errors, label, "is required");
    return;
  }

  if (!exists) return;

  if (rule.type === "string" && typeof value !== "string") pushError(errors, label, "must be a string");
  if (rule.type === "number") {
    const num = Number(value);
    if (!Number.isFinite(num)) pushError(errors, label, "must be a number");
    if (Number.isFinite(num) && rule.min !== undefined && num < rule.min) pushError(errors, label, `must be >= ${rule.min}`);
  }
  if (rule.type === "integer") {
    const num = Number(value);
    if (!Number.isInteger(num)) pushError(errors, label, "must be an integer");
    if (Number.isInteger(num) && rule.min !== undefined && num < rule.min) pushError(errors, label, `must be >= ${rule.min}`);
  }
  if (rule.type === "boolean" && typeof value !== "boolean") pushError(errors, label, "must be a boolean");
  if (rule.type === "array" && !Array.isArray(value)) pushError(errors, label, "must be an array");
  if (rule.type === "object" && !isObject(value)) pushError(errors, label, "must be an object");
  if (rule.type === "date") {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) pushError(errors, label, "must be a valid date/time value");
  }
  if (rule.type === "email") {
    const normalized = String(value).trim();
    const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized);
    if (!emailOk) pushError(errors, label, "must be a valid email address");
  }
  if (rule.type === "enum") {
    if (!rule.values.includes(value)) pushError(errors, label, `must be one of: ${rule.values.join(", ")}`);
  }
  if (typeof value === "string" && rule.minLength && value.trim().length < rule.minLength) {
    pushError(errors, label, `must be at least ${rule.minLength} characters`);
  }
  if (Array.isArray(value) && rule.minItems && value.length < rule.minItems) {
    pushError(errors, label, `must contain at least ${rule.minItems} item(s)`);
  }
}

function validate(schema = {}) {
  return (req, res, next) => {
    const errors = [];
    for (const [containerName, rules] of Object.entries(schema)) {
      const source = req[containerName] || {};
      for (const [field, rule] of Object.entries(rules || {})) {
        applyRule(containerName, source, field, rule, errors);
      }
    }

    if (typeof schema.custom === "function") {
      const extra = schema.custom(req) || [];
      extra.forEach((item) => errors.push(item));
    }

    if (errors.length) {
      return res.status(400).json({
        message: "Request validation failed",
        errors
      });
    }

    return next();
  };
}

const commonQueryValidation = validate({
  query: {
    page: { type: "integer", min: 1 },
    page_size: { type: "integer", min: 1 },
    limit: { type: "integer", min: 1 },
    date_from: { type: "date" },
    date_to: { type: "date" },
    as_of: { type: "date" }
  }
});

module.exports = {
  validate,
  commonQueryValidation
};
