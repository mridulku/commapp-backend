/**
 * createExamConfig.js
 *
 * Usage: node createExamConfig.js
 *
 * This script initializes a connection to Firestore via the Admin SDK
 * using the environment variable FIREBASE_SERVICE_ACCOUNT (which must
 * contain the entire JSON for your service account key), and writes
 * a doc "general" under the "examConfigs" collection.
 */

// 1. Import the Firebase Admin SDK
const admin = require("firebase-admin");

// 2. Load your service account JSON from environment variable
const firebaseServiceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT;
if (!firebaseServiceAccountJson) {
  console.error("❌ FIREBASE_SERVICE_ACCOUNT env var is not set.");
  process.exit(1);
}

// 3. Parse it into an object
let serviceAccount;
try {
  serviceAccount = JSON.parse(firebaseServiceAccountJson);
} catch (error) {
  console.error("❌ FIREBASE_SERVICE_ACCOUNT could not be parsed as valid JSON:", error);
  process.exit(1);
}

// 4. Initialize the Firebase app (if not already initialized)
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

// 5. Get a reference to Firestore
const db = admin.firestore();

// 6. The data we want to store for our "general" exam config
const examConfigData = {
  // Stages used in the "general" framework
  stages: ["none", "remember", "understand", "apply", "analyze"],

  // PlanTypes mapping planType => { startStage, finalStage }
  planTypes: {
    "none-basic": {
      startStage: "remember",
      finalStage: "understand",
    },
    "none-moderate": {
      startStage: "remember",
      finalStage: "apply",
    },
    "none-advanced": {
      startStage: "remember",
      finalStage: "analyze",
    },
    "some-basic": {
      startStage: "understand",
      finalStage: "understand",
    },
    "some-moderate": {
      startStage: "understand",
      finalStage: "apply",
    },
    "some-advanced": {
      startStage: "understand",
      finalStage: "analyze",
    },
    "strong-basic": {
      startStage: "apply",
      finalStage: "apply",
    },
    "strong-moderate": {
      startStage: "apply",
      finalStage: "apply",
    },
    "strong-advanced": {
      startStage: "apply",
      finalStage: "analyze",
    },
  },

  // (Optional) Add more fields if you want, e.g. defaultWpm, defaultQuizTime, etc.
  // defaultWpm: 200,
  // defaultQuizTime: 5
};

// 7. A simple async function to add/update this document
async function createExamConfig() {
  try {
    console.log("Creating or updating examConfigs/general...");

    // Write (or update) the doc
    await db.collection("examConfigs").doc("general").set(examConfigData);

    console.log("✅ Successfully created/updated examConfigs/general!");
    process.exit(0); // Exit the script successfully
  } catch (error) {
    console.error("❌ Error creating exam config:", error);
    process.exit(1); // Exit with an error code
  }
}

// 8. Run the function
createExamConfig();