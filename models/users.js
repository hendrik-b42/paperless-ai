// models/users.js
//
// Local user accounts (single-admin scheme). Passwords are pre-hashed
// by the caller; this module just persists them.

const { db, insertUser } = require('./db');

module.exports = {
  async addUser(username, password) {
    try {
      // Lösche alle vorhandenen Benutzer
      const deleteResult = db.prepare('DELETE FROM users').run();
      console.log(`[DEBUG] ${deleteResult.changes} existing users deleted`);
  
      // Füge den neuen Benutzer hinzu
      const result = insertUser.run(username, password);
      if (result.changes > 0) {
        console.log(`[DEBUG] User ${username} added`);
        return true;
      }
      return false;
    } catch (error) {
      console.error('[ERROR] adding user:', error);
      return false;
    }
  },

  async getUser(username) {
    try {
      return db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    } catch (error) {
      console.error('[ERROR] getting user:', error);
      return [];
    }
  },

  async getUsers() {
    try {
      return db.prepare('SELECT * FROM users').all();
    } catch (error) {
      console.error('[ERROR] getting users:', error);
      return [];
    }
  },

};
