require("dotenv").config();
const admin = require("firebase-admin");

// 1) Parse the Firebase service account JSON from the environment variable
const firebaseServiceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT;
if (!firebaseServiceAccountJson) {
  console.error("FIREBASE_SERVICE_ACCOUNT env variable not found.");
  process.exit(1);
}

let serviceAccount;
try {
  serviceAccount = JSON.parse(firebaseServiceAccountJson);
} catch (error) {
  console.error("Error parsing FIREBASE_SERVICE_ACCOUNT JSON:", error);
  process.exit(1);
}

// 2) Initialize Firebase Admin
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

// 3) Define the document ID and data
const docId = "Hv1dsxLiZHVmCtXd2FRy";
const docData = {
  promptText: `You are a helpful assistant. Given the following text content, extract and summarize the most important points from the text and then list exactly three key things to remember. Your response must be returned as valid JSON following the structure below. Do not include any markdown formatting, additional commentary, or extra fields—only the JSON output.

Expected JSON Format:
{
  "importantPoints": [
    "Important point 1",
    "Important point 2",
    "Important point 3",
    "... (as many as found)"
  ],
  "threeThingsToRemember": [
    "Remember point 1",
    "Remember point 2",
    "Remember point 3"
  ]
}

Ensure that:
- The "importantPoints" field is an array of strings.
- The "threeThingsToRemember" field is an array containing exactly three strings.`,
  UIconfig: {
    renderType: "list",
    fields: [
      {
        field: "importantPoints",
        label: "Important Points",
        component: "list",
        style: {
          backgroundColor: "#f9f9f9",
          padding: "8px",
          border: "1px solid #ccc",
          marginBottom: "1rem",
        },
      },
      {
        field: "threeThingsToRemember",
        label: "Three Things To Remember",
        component: "list",
        style: {
          backgroundColor: "#f0f0f0",
          padding: "8px",
          border: "1px solid #aaa",
        },
      },
    ],
  },
  templateId: docId,
  name: "ReviseApply - Important Points and Three Reminders",
  description:
    "This template expects GPT to output a JSON object containing an array of important points and an array with exactly three things to remember.",
};

async function main() {
  try {
    // 4) Write (merge) the document into Firestore
    await db.collection("prompts").doc(docId).set(docData, { merge: true });
    console.log(`Document '${docId}' successfully written!`);
  } catch (err) {
    console.error("Error writing document:", err);
    process.exit(1);
  }
}

main();