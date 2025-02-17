const admin = require("firebase-admin");

const firebaseServiceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT;

// 2. Parse it into an object
const serviceAccount = JSON.parse(firebaseServiceAccountJson);

// Initialize Firebase Admin
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore(); // Firestore database instance

module.exports = db; // Export Firestore instance
