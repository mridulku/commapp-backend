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

/**
 * We’ll store our new prompt document under a doc ID of your choosing.
 * This can be different from the promptKey if you like. 
 * For example, "quizAnalyzeDocId".
 */
const docId = "isPcKEjqcuGzSjK3qmBx";

// 3) Define the data for this new prompt document
// Note the "promptKey" is the field your server code will query by.
const docData = {
  promptKey: "quizAnalyze",
  promptText: `You are a helpful assistant. Based on the text content provided, generate exactly 5 multiple-choice questions with 4 possible options each. Return them as valid JSON, following the structure below. Your response must ONLY contain valid JSON and nothing else. Do not include any markdown or extra commentary.

The JSON format should look like this:
{
  "quizQuestions": [
    {
      "question": "...",
      "options": ["...", "...", "...", "..."],
      "correctAnswerIndex": 0
    },
    ...
    // total 5 questions
  ]
}

Guidelines:
- Each question must have exactly 4 answer options.
- Provide the correctAnswerIndex (0-based) to indicate the correct option.
- Do not add additional fields.
- Only return JSON that matches this shape.
`,
  UIconfig: {
    fields: [
      {
        component: "quiz",
        field: "quizQuestions",
        label: "Answer the following questions",
      },
    ],
  },
  name: "QuizAnalyze - 5 multiple-choice questions",
  description:
    "This template expects GPT to output exactly 5 multiple-choice questions in an array called 'quizQuestions', each with 'question', 'options', and 'correctAnswerIndex'.",
};

async function main() {
  try {
    // 4) Write (merge) the document into Firestore
    await db.collection("prompts").doc(docId).set(docData, { merge: true });
    console.log(`Document '${docId}' successfully written/updated!`);
  } catch (err) {
    console.error("Error writing document:", err);
    process.exit(1);
  }
}

main();