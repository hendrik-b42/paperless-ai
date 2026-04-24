// models/document.js
//
// Façade. The original 876-line god-object has been split into six
// domain modules plus a shared db.js. This file re-exports every method
// so existing call-sites (`require('./models/document')`) keep working
// unchanged.

const { closeDatabase } = require('./db');

module.exports = {
  closeDatabase,
  ...require('./documents'),
  ...require('./history'),
  ...require('./metrics'),
  ...require('./users'),
  ...require('./stats'),
  ...require('./optimizer'),
};
