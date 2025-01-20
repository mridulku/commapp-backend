const admin = require("firebase-admin");

// Import the service account key
const serviceAccount = require("./firebase-key.json");

// Initialize Firebase Admin
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore(); // Firestore database instance

module.exports = db; // Export Firestore instance
