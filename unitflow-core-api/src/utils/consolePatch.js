const logger = require("./logger");

function patch(method, level) {
  const original = console[method].bind(console);
  console[method] = (...args) => {
    const message = args
      .map((arg) => {
        if (typeof arg === "string") return arg;
        try {
          return JSON.stringify(arg);
        } catch {
          return String(arg);
        }
      })
      .join(" ");

    logger[level](message);
    return original(...args);
  };
}

patch("log", "info");
patch("info", "info");
patch("warn", "warn");
patch("error", "error");
