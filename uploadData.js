const admin = require("firebase-admin");
const csv = require("csv-parser");
const fs = require("fs");

const firebaseServiceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT;

// 2. Parse it into an object
const serviceAccount = JSON.parse(firebaseServiceAccountJson);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();
const csvFilePath = "./content.csv"; // Update with your actual file path

async function uploadData() {
  const categoriesMap = new Map();
  const booksMap = new Map();
  const chaptersMap = new Map();

  const results = [];

  fs.createReadStream(csvFilePath, { encoding: "utf-8" })
    .pipe(csv())
    .on("data", (row) => {
      console.log("Row Data:", row); // Debugging

      // Fix column names (handling "Book " issue)
      let Category = row["Category"]?.trim() || "Unknown Category";
      let Book = row["Book "]?.trim() || "Unknown Book"; // Fixes "Book " issue
      let Chapter = row["Chapter"]?.trim() || "Unknown Chapter";
      let Subchapter = row["Suchapter"]?.trim();
      let Summary = row["Summary"]?.trim();

      // Handle '-' values
      if (Subchapter === "-") Subchapter = null;
      if (Summary === "-") Summary = null;

      // Ensure essential fields exist (but don't require Subchapter)
      if (!Category || !Book || !Chapter) {
        console.warn("Skipping row due to missing essential values:", row);
        return;
      }

      results.push({ Category, Book, Chapter, Subchapter, Summary });
    })
    .on("end", async () => {
      console.log("CSV File read successfully.");

      const batch = db.batch();

      for (const row of results) {
        let { Category, Book, Chapter, Subchapter, Summary } = row;

        // Check if category exists, else create
        if (!categoriesMap.has(Category)) {
          const categoryRef = db.collection("categories_demo").doc();
          batch.set(categoryRef, { name: Category });
          categoriesMap.set(Category, categoryRef.id);
        }

        const categoryId = categoriesMap.get(Category);

        // Check if book exists, else create
        const bookKey = `${Category}-${Book}`;
        if (!booksMap.has(bookKey)) {
          const bookRef = db.collection("books_demo").doc();
          batch.set(bookRef, { name: Book, categoryId });
          booksMap.set(bookKey, bookRef.id);
        }

        const bookId = booksMap.get(bookKey);

        // Check if chapter exists, else create
        const chapterKey = `${Book}-${Chapter}`;
        if (!chaptersMap.has(chapterKey)) {
          const chapterRef = db.collection("chapters_demo").doc();
          batch.set(chapterRef, { name: Chapter, bookId });
          chaptersMap.set(chapterKey, chapterRef.id);
        }

        const chapterId = chaptersMap.get(chapterKey);

        // If Subchapter exists (not null), create subchapter
        if (Subchapter) {
          const subchapterRef = db.collection("subchapters_demo").doc();
          batch.set(subchapterRef, {
            name: Subchapter,
            chapterId,
            summary: Summary || "No summary available",
          });
        }
      }

      await batch.commit();
      console.log("Data successfully uploaded to Firestore.");
    });
}

uploadData();