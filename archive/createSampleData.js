/**
 * createSampleData.js
 *
 * Usage: node createSampleData.js
 *
 * This script initializes a connection to Firestore via the Admin SDK
 * and writes sample documents into a collection named "booksCollection".
 */

// 1. Import the Firebase Admin SDK
const admin = require("firebase-admin");

// 2. Load your service account JSON
//    Replace './serviceAccountKey.json' with the correct path to your key file
const serviceAccount = require("../firebase-key.json"); 

// 3. Initialize the Firebase app (if not already initialized)
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

// 4. Get a reference to Firestore
const db = admin.firestore();

// 5. Create an array of sample data
// Each object in this array will become one document in "booksCollection"
const sampleData = [
  {
    book: "Book A",
    chapter: "Chapter 1",
    subChapter: "Section 1.1",
    summary: "This is the summary for Book A, Chapter 1, Section 1.1",
  },
  {
    book: "Book A",
    chapter: "Chapter 1",
    subChapter: "Section 1.2",
    summary: "This is the summary for Book A, Chapter 1, Section 1.2",
  },
  {
    book: "Book A",
    chapter: "Chapter 2",
    subChapter: "Section 2.1",
    summary: "This is the summary for Book A, Chapter 2, Section 2.1",
  },
  {
    book: "Book B",
    chapter: "Introduction",
    subChapter: "Preface",
    summary: "Preface text for Book B.",
  },
  {
    book: "Book B",
    chapter: "Introduction",
    subChapter: "Overview",
    summary: "Overview text for Book B's introduction.",
  },
  {
    book: "Book B",
    chapter: "Chapter X",
    subChapter: "Topic X.1",
    summary: "Details for Book B, Chapter X, Topic X.1",
  },
];

// 6. A simple async function to add these documents
async function addSampleData() {
  try {
    console.log("Adding sample documents to 'booksCollection'...");

    // For each item in sampleData, add a doc
    for (const doc of sampleData) {
      await db.collection("booksCollection").add(doc);
    }

    console.log("✅ Successfully added sample data to Firestore!");
    process.exit(0); // Exit the script successfully
  } catch (error) {
    console.error("❌ Error adding sample data:", error);
    process.exit(1); // Exit with an error code
  }
}

// 7. Run the function
addSampleData();