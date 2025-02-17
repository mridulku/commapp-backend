/*****************************************************
 * importQuizzes.js
 * Run: `node importQuizzes.js`
 *
 * Prerequisites:
 *   npm install csv-parser firebase-admin
 *****************************************************/
const fs = require("fs");
const csv = require("csv-parser");
const admin = require("firebase-admin");

// 1) Initialize Firebase Admin
const firebaseServiceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT;

// 2. Parse it into an object
const serviceAccount = JSON.parse(firebaseServiceAccountJson);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});
const db = admin.firestore();

// 2) Path to your CSV file
const CSV_FILE_PATH = "./quiz.csv";

// We'll store { [subChapterId]: [] of question objects }
const quizzesMap = {};

fs.createReadStream(CSV_FILE_PATH)
  .pipe(csv())
  .on("data", (row) => {
    /* 
      Each `row` should have columns:
      {
        subChapterId,
        questionText,
        option1,
        option2,
        option3,
        option4,
        correctAnswerIndex,
        explanation
      }
    */
    const {
      subChapterId,
      questionText,
      option1,
      option2,
      option3,
      option4,
      correctAnswerIndex,
      explanation,
    } = row;

    if (!quizzesMap[subChapterId]) {
      quizzesMap[subChapterId] = [];
    }

    // Build a question object
    const questionObj = {
      questionText,
      options: [option1, option2, option3, option4],
      correctAnswerIndex: parseInt(correctAnswerIndex, 10) || 0,
      explanation,
    };

    quizzesMap[subChapterId].push(questionObj);
  })
  .on("end", async () => {
    console.log("CSV file successfully processed. Now importing to Firestore...");

    try {
      // For each subChapterId, create or overwrite a doc in quizzes_demo
      // docId can be something like <subChapterId> or auto-generated
      // We'll choose to make the docId the same as subChapterId for convenience
      for (const subChapterId of Object.keys(quizzesMap)) {
        const questionsArray = quizzesMap[subChapterId];

        // We'll create a doc in "quizzes_demo" with docId = subChapterId
        await db.collection("quizzes_demo").doc(subChapterId).set({
          subChapterId,
          questions: questionsArray,
          createdAt: new Date(),
        });

        console.log(
          `Imported ${questionsArray.length} questions for subChapterId=${subChapterId}.`
        );
      }
      console.log("All quiz data imported successfully!");
    } catch (error) {
      console.error("Error importing data to Firestore:", error);
    }
  });