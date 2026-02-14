function createLogger(ns) {
  const prefix = ns ? `[${ns}]` : '';
  return {
    info: (...args) => console.log(prefix, ...args),
    warn: (...args) => console.warn(prefix, ...args),
    error: (...args) => console.error(prefix, ...args),
    debug: (...args) => {
      if (process.env.DEBUG) console.debug(prefix, ...args);
    }
  };
}

module.exports = createLogger;
