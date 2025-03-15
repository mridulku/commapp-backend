const admin = require('firebase-admin');
const serviceAccount = require('../firbase.js'); 
  // or use path+fs if you prefer

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();
module.exports = { admin, db };

async function main() {
  // We'll create/update the doc examConfigs/general
  const docRef = db.collection("examConfigs").doc("general");

  // The data we want to store
  const examConfigData = {
    stages: ["none", "remember", "understand", "apply", "analyze"],

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
      }
    },

    // Optionally add more fields for default times, e.g.:
    // defaultWpm: 200,
    // defaultQuizTime: 5
  };

  // Write (or update) the doc
  await docRef.set(examConfigData);
  console.log("Successfully created/updated examConfigs/general in Firestore.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Error creating exam config:", err);
    process.exit(1);
  });