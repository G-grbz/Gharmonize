'use strict';

const fs = require('node:fs');

// Scoped to temp@0.9.4: its generated paths are literals, and its only option
// is maxBusyTries. Do not use this as a general glob-enabled rimraf replacement.
function optionsFor(options = {}) {
  const retries = options.maxBusyTries ?? 0;
  if (!Number.isInteger(retries) || retries < 0) {
    throw new TypeError('maxBusyTries must be a non-negative integer');
  }
  return { recursive: true, force: true, maxRetries: retries, retryDelay: 100 };
}

function cleanup(target, options, callback) {
  if (typeof options === 'function') {
    callback = options;
    options = undefined;
  }
  if (typeof callback !== 'function') throw new TypeError('A cleanup callback is required');
  fs.rm(target, optionsFor(options), callback);
}

cleanup.sync = function cleanupSync(target, options) {
  fs.rmSync(target, optionsFor(options));
};

module.exports = cleanup;
