module.exports = function notFoundHandler(req, res) {
  return res.status(404).json({
    message: "Route not found",
    request_id: req.request_id || null
  });
};
