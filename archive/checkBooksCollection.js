// checkBooksCollection.js
const admin = require("firebase-admin");

const serviceAccount = require("../firebase-key.json"); // path to your key

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

const db = admin.firestore();

(async () => {
  const snapshot = await db.collection("booksCollection").get();
  console.log("Found docs:", snapshot.size);

  snapshot.forEach((doc) => {
    console.log(doc.id, doc.data());
  });
})();