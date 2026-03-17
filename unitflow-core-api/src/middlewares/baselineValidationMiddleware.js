function isValidDate(value) {
  if (!value) return true;
  const d = new Date(value);
  return !Number.isNaN(d.getTime());
}

module.exports = function baselineValidationMiddleware(req, res, next) {
  const errors = [];

  for (const [key, value] of Object.entries(req.params || {})) {
    if ((/id$/i.test(key) || /Id$/.test(key)) && !String(value || "").trim()) {
      errors.push({ field: `params.${key}`, message: "must be a non-empty identifier" });
    }
  }

  for (const key of ["page", "page_size", "limit"]) {
    if (req.query?.[key] !== undefined) {
      const num = Number(req.query[key]);
      if (!Number.isInteger(num) || num < 1) {
        errors.push({ field: `query.${key}`, message: "must be a positive integer" });
      }
    }
  }

  for (const key of ["date_from", "date_to", "as_of", "issue_date", "due_date", "paid_at", "order_date"]) {
    if (req.query?.[key] !== undefined && !isValidDate(req.query[key])) {
      errors.push({ field: `query.${key}`, message: "must be a valid date/time value" });
    }
    if (req.body?.[key] !== undefined && !isValidDate(req.body[key])) {
      errors.push({ field: `body.${key}`, message: "must be a valid date/time value" });
    }
  }

  for (const key of ["email", "SMTP_FROM_EMAIL"]) {
    if (req.body?.[key] !== undefined) {
      const email = String(req.body[key] || "").trim();
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        errors.push({ field: `body.${key}`, message: "must be a valid email address" });
      }
    }
  }

  if (errors.length) {
    return res.status(400).json({ message: "Request validation failed", errors });
  }

  return next();
};
