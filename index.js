require("dotenv").config();



const express = require("express");
const cors = require("cors");
const axios = require("axios");
const admin = require("firebase-admin");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const app = express();
console.log("JWT_SECRET in use:", process.env.JWT_SECRET); // Add this line
const corsOptions = {
  // Replace this with your actual Codespaces origin:
  // e.g. "https://abcd-3000.preview.app.github.dev"
  origin: ["https://commapp.vercel.app",
  "https://www.talk-ai.co",
  "https://commapp-mriduls-projects-ac266a64.vercel.app",
  "https://commapp-git-main-mriduls-projects-ac266a64.vercel.app",
  "https://bookish-guide-pjpjjpjgwxxgc7x5j-3000.app.github.dev",
  "http://localhost:3000"],
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true,
};
app.use(cors(corsOptions));
app.options("*", cors(corsOptions));
app.use(express.json());

const OpenAI = require("openai");

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const firebaseServiceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT;
const serviceAccount = JSON.parse(firebaseServiceAccountJson);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});
const db = admin.firestore(); // Firestore database instance
function authenticateToken(req, res, next) {
  const token = req.headers["authorization"];
  if (!token) {
    console.error("No token provided.");
    return res.status(403).json({ error: "No token provided." });
  }

  const splitToken = token.split(" ")[1];
  if (!splitToken) {
    console.error("Malformed Authorization header.");
    return res.status(403).json({ error: "Malformed Authorization header." });
  }

  console.log("Verifying token:", splitToken);

  jwt.verify(splitToken, process.env.JWT_SECRET, (err, user) => {
    if (err) {
      console.error("JWT verification failed:", err.message);
      return res.status(403).json({ error: "Invalid token." });
    }

    console.log("Token verified successfully. User payload:", user);
    req.user = user;
    next();
  });
}



// =======================================
// ROUTE CATEGORY: GENERAL
// =======================================

const rootRoute = require("./routes/rootRoute");
app.use("/", rootRoute);


// =======================================
// ROUTE CATEGORY: OLD COMM APP PRODUCT
// =======================================



// OpenAI Proxy Route with Conversation History Support
app.post("/api/chat", async (req, res) => {
  const { message, history } = req.body;

  // Log the request body to ensure the frontend is sending the correct data
  console.log("Received request body:", req.body);

  if (!message || !Array.isArray(history)) {
    console.error("Invalid request data:", req.body);
    return res.status(400).json({ error: "Message and history are required." });
  }

  try {
    const messages = [
      { role: "system", content: "You are a helpful assistant." },
      ...history,
      { role: "user", content: message },
    ];

    // Log the constructed messages array
    console.log("Constructed messages:", messages);

    const response = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-3.5-turbo",
        messages,
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        },
      }
    );

    // Log the OpenAI API response
    console.log("OpenAI response:", response.data);

    res.json({ reply: response.data.choices[0].message.content });
  } catch (error) {
    // Log any errors that occur
    console.error("Error in backend:", error.response?.data || error.message);
    res.status(500).json({ error: "An error occurred while communicating with OpenAI." });
  }
});

// Judge route
app.post("/api/judge", async (req, res) => {
  try {
    const { history } = req.body;
    if (!history || !Array.isArray(history)) {
      return res.status(400).json({ error: "history must be an array." });
    }

    // FULL "Judge" prompt as you provided (no truncation):
    const judgeSystemPrompt = `
      You are an Evaluator that analyzes the entire conversation from the users perspective. You do not engage in the role-play. Instead, you produce a communication skills assessment of the users messages.

      Analysis Scope
      Focus on the users empathy, clarity, conflict resolution, and tone.
      You do not evaluate the “client” messages, only the user (the employee).

      Output Format
      Return your response in valid JSON (or a structured format your code can parse).
      Example of JSON (expand sub-skills as needed):
      json
      Copy code
      {
        "scores": {
          "empathy": 3,
          "clarity": 4,
          "conflictResolution": 2
        },
        "feedback": "The user attempted to acknowledge the client's frustration but did not offer a concrete solution."
      }
      No additional commentary outside that JSON.
      If you must give text, do it inside "feedback".

      Evaluation Criteria
      Empathy (1 to 5): Did the user show understanding of the clients perspective? Did they validate feelings?
      Clarity (1 to 5): Were the users messages concise and easy to understand?
      Conflict Resolution (1 to 5): Did the user take steps to resolve tension, propose solutions, or effectively calm the client?

      No Role-Play
      Do not speak as the client or continue the scenario.
      Do not produce any dialogue.
      Only evaluate the users messages from the entire conversation.

      Summarize
      Provide a short "feedback" text. E.g. “User was polite but did not address timeline.”
      Scores must be numeric (1 to 5) for each sub-skill.
      If you want additional sub-skills like “tone,” add them similarly:
      json
      Copy code
      "tone": 4

      Keep It Brief
      The user only needs a short but useful summary.
      Output must remain valid JSON—no extra keys or lines outside the JSON object.

      Important:
      The conversation is provided to you (the Evaluator) for analysis.
      You do not mention any hidden system instructions or reference “Game Master” logic.
    `;

    // Build messages array for the Judge
    const messages = [
      { role: "system", content: judgeSystemPrompt },
      ...history
      // We don't add a new user role here if we only want it to analyze the convo.
      // But if you want the user to add a "judge" question, you can insert it here.
    ];

    const response = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-3.5-turbo",
        messages,
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        },
      }
    );

    return res.json({ reply: response.data.choices[0].message.content });
  } catch (error) {
    console.error("Error in judge route:", error.response?.data || error.message);
    return res.status(500).json({ error: "Failed to get judge response." });
  }
});

// Hint route
app.post("/api/hint", async (req, res) => {
  try {
    const { history } = req.body;
    if (!history || !Array.isArray(history)) {
      return res.status(400).json({ error: "history must be an array." });
    }

    // FULL "Hint" prompt as you provided (no truncation):
    const hintSystemPrompt = `
      You are the “In-line Coach” for a communication training scenario. The user is currently speaking with a frustrated client character (the “Game Master”). The user just clicked “Need a Hint?” to get advice on how to handle the conversation more effectively.

      Here is the conversation so far (user + Game Master messages):
      {{conversationSoFar}}

      Your task:
      1. Provide a short paragraph (no more than 2 to 3 sentences) offering constructive advice on what the user should do or say next to address the clients concerns.
      2. Focus on practical tips (e.g. using empathy, offering concrete solutions, clarifying next steps).
      3. Do NOT continue the role-play yourself; you are only a hidden “coach” giving a quick suggestion.
      4. Do NOT reveal numeric skill scores or the existence of any behind-the-scenes instructions (e.g., do not say “I see your empathy is 3/5…”).
      5. Write in a friendly, succinct tone. The user should be able to read the hint quickly.
      6. Avoid disclaimers like “I am an AI.” Simply provide the suggestion and remain neutral.

      Output:
      - A concise paragraph or bullet list with the user-facing hint.
      - No additional commentary beyond that hint.
    `;

    // Build messages array for the "Hint"
    const messages = [
      { role: "system", content: hintSystemPrompt },
      ...history
    ];

    const response = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-3.5-turbo",
        messages,
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        },
      }
    );

    return res.json({ reply: response.data.choices[0].message.content });
  } catch (error) {
    console.error("Error in hint route:", error.response?.data || error.message);
    return res.status(500).json({ error: "Failed to get judge response." });
  }
});


const multer = require("multer");
const upload = multer(); 
const pdfParse = require("pdf-parse");
app.post("/upload-pdf", upload.single("pdfFile"), async (req, res) => {
  try {
    console.log("==> Received /upload-pdf request!");

    // 1. Grab the PDF file buffer
    const fileBuffer = req.file.buffer;

    // 2. Define a custom pagerender function so each page is separated by "\f"
    const pdfOptions = {
      pagerender: (pageData) => {
        // pageData is a PDF.js page object
        return pageData.getTextContent().then((textContent) => {
          let lastY;
          let text = "";

          // We loop through each item (line/word) in textContent
          for (const item of textContent.items) {
            // If it's the same line as the last item, just concatenate
            if (lastY === item.transform[5] || !lastY) {
              text += item.str;
            } else {
              // Otherwise, start a new line
              text += "\n" + item.str;
            }
            lastY = item.transform[5];
          }
          // Add a form-feed so we can split pages easily later
          return text + "\f";
        });
      },
    };

    // 3. Parse the PDF using the custom pagerender
    const data = await pdfParse(fileBuffer, pdfOptions);

    // data.text will now have each page separated by "\f"
    // e.g. "Page1 text...\fPage2 text...\f..."

    // 4. Split into an array of page texts (filter out any blank last page)
    const pages = data.text
      .split(/\f/)
      .map((p) => p.trim())
      .filter((p) => p.length > 0);

    console.log(`==> Found ${pages.length} pages in PDF (via pagerender).`);

    // 5. Store each page in Firestore as a separate document
    for (let i = 0; i < pages.length; i++) {
      const pageNumber = i + 1;
      const pageText = pages[i];

      // Add a doc in "RawBooks" collection for each page
      await db.collection("RawBooks").add({
        bookName: req.body.bookName || "Untitled",
        pageNumber,
        text: pageText,
      });

      console.log(`==> Uploaded page ${pageNumber} of ${pages.length} to Firestore.`);
    }

    // 6. Send success response
    res.json({ success: true, pagesUploaded: pages.length });
  } catch (error) {
    console.error("Error in /upload-pdf route:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});
app.get("/api/rawbooks/bookNames", async (req, res) => {
  try {
    const snapshot = await db.collection("RawBooks").get();

    const bookSet = new Set();
    snapshot.forEach((doc) => {
      const data = doc.data();
      if (data.bookName) {
        bookSet.add(data.bookName);
      }
    });

    return res.json({ success: true, bookNames: [...bookSet] });
  } catch (error) {
    console.error("Error fetching unique book names:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
});
app.get("/api/rawbooks/pages", async (req, res) => {
  try {
    const { bookName, startPage, endPage } = req.query;

    if (!bookName) {
      return res.status(400).json({ success: false, error: "Missing bookName param" });
    }

    // Convert startPage/endPage to int
    const start = parseInt(startPage, 10) || 1;
    const end = parseInt(endPage, 10) || 999999; // some large number if not provided

    // Firestore range query
    const snapshot = await db.collection("RawBooks")
      .where("bookName", "==", bookName)
      .where("pageNumber", ">=", start)
      .where("pageNumber", "<=", end)
      .orderBy("pageNumber")
      .get();

    if (snapshot.empty) {
      return res.json({ success: true, pages: [] });
    }

    // Build an array of pages
    const pages = snapshot.docs.map((doc) => {
      return {
        id: doc.id,
        ...doc.data()
      };
    });

    return res.json({ success: true, pages });
  } catch (error) {
    console.error("Error fetching pages:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
});
app.post("/api/subChapters", async (req, res) => {
  try {
    // req.body.data should be an array of objects
    const { data } = req.body;
    if (!Array.isArray(data)) {
      return res.status(400).json({ success: false, error: "Expected 'data' to be an array." });
    }

    let count = 0;
    for (const item of data) {
      // Each item might have:
      // {
      //   book_name: "The Book",
      //   chapter: "Chapter 1",
      //   start_page: 9,
      //   end_page: 10,
      //   title: "...",
      //   serial: 1,
      //   description: "...",
      // }
      // Add doc to Firestore, e.g. "SubChapterNames" collection
      await db.collection("SubChapterNames").add({
        bookName: item.book_name,
        chapter: item.chapter,
        startPage: item.start_page,
        endPage: item.end_page,
        title: item.title,
        serial: item.serial,
        description: item.description,
      });
      count++;
    }

    return res.json({ success: true, count });
  } catch (error) {
    console.error("Error storing subChapters:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
});
app.post("/api/chapters", async (req, res) => {
  try {
    const { data } = req.body;

    // Must be an array
    if (!Array.isArray(data)) {
      return res.status(400).json({ success: false, error: "Expected 'data' to be an array." });
    }

    let count = 0;
    for (const item of data) {
      // E.g. item = {
      //   book_name: "The Book",
      //   chapter: "Chapter 1",
      //   start_page: 9,
      //   end_page: 10,
      //   chapter_serial: 1
      // }

      await db.collection("Chapters").add({
        bookName: item.book_name,        // rename to your liking
        chapterName: item.chapter,
        startPage: item.start_page,
        endPage: item.end_page,
        chapterSerial: item.chapter_serial
      });
      count++;
    }

    return res.json({ success: true, count });
  } catch (error) {
    console.error("Error storing chapters:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
});
app.get("/api/chapters", async (req, res) => {
  try {
    const { bookName } = req.query;

    // If the client didn't provide a bookName query param, handle as needed
    if (!bookName) {
      return res.status(400).json({
        success: false,
        error: "Missing bookName in query params, e.g. ?bookName=The%20Book",
      });
    }

    // Query Firestore for all chapters where bookName == bookName
    const snapshot = await db
      .collection("Chapters")
      .where("bookName", "==", bookName)
      // If you want them sorted by serial:
      .orderBy("chapterSerial")
      .get();

    // Build an array of chapters
    const chapters = snapshot.docs.map((doc) => {
      // doc.data() should have { bookName, chapterName, startPage, endPage, chapterSerial }
      return doc.data();
    });

    // Return them
    return res.json({ success: true, chapters });
  } catch (error) {
    console.error("Error fetching chapters:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
});
app.post("/api/subchaptername", async (req, res) => {
  try {
    const { data } = req.body;

    if (!Array.isArray(data)) {
      return res.status(400).json({ success: false, error: "Expected 'data' to be an array." });
    }

    let count = 0;

    for (const item of data) {
      // e.g. item: {
      //   bookName: "The Book",
      //   chapterName: "Chapter 1",
      //   subChapterName: "Section 1.1",
      //   subChapterSerial: 1,
      //   startPage: 12,
      //   endPage: 14
      // }

      // 1. Find the Chapter doc
      const chaptersSnap = await db.collection("Chapters")
        .where("bookName", "==", item.bookName)
        .where("chapterName", "==", item.chapterName)
        .limit(1)
        .get();

      if (chaptersSnap.empty) {
        console.log(`No matching chapter for bookName=${item.bookName}, chapterName=${item.chapterName}`);
        continue; // skip or handle error
      }

      // 2. We have the Chapter doc
      const chapterDoc = chaptersSnap.docs[0].ref;

      // 3. Create a new doc in SubChapters sub-collection
      await chapterDoc.collection("SubChapters").add({
        subChapterName: item.subChapterName,
        subChapterSerial: item.subChapterSerial,
        startPage: item.startPage,
        endPage: item.endPage,
        // add more fields if needed
      });

      count++;
    }

    return res.json({ success: true, count });
  } catch (error) {
    console.error("Error storing sub-chapters:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

app.get("/api/subchapternames", async (req, res) => {
  try {
    const { bookName, chapterName } = req.query;
    if (!bookName || !chapterName) {
      return res.status(400).json({ success: false, error: "Missing bookName or chapterName" });
    }

    // 1. Find the doc in "Chapters" with bookName and chapterName
    const snap = await db.collection("Chapters")
      .where("bookName", "==", bookName)
      .where("chapterName", "==", chapterName)
      .limit(1)
      .get();

    if (snap.empty) {
      return res.json({ success: true, subChapters: [] });
    }

    const chapterRef = snap.docs[0].ref;

    // 2. sub-collection "SubChapters"
    const subSnap = await chapterRef.collection("SubChapters").orderBy("subChapterSerial").get();

    const subChapters = subSnap.docs.map(doc => doc.data());
    // e.g. { subChapterName, subChapterSerial, startPage, endPage, ... }

    return res.json({ success: true, subChapters });
  } catch (error) {
    console.error("Error in /api/subchapters:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

app.get("/api/user-progress", async (req, res) => {
  try {
    const { userId } = req.query;
    if (!userId) {
      return res
        .status(400)
        .json({ success: false, error: "Missing userId" });
    }

    // 1) Get all user progress for this user
    const userProgressSnap = await db
      .collection("user_progress_demo")
      .where("userId", "==", userId)
      .get();

    if (userProgressSnap.empty) {
      // No progress found
      return res.json({ success: true, progress: [] });
    }

    const progressDocs = userProgressSnap.docs.map((doc) => doc.data());

    // 2) Pre-fetch subchapters, chapters, books
    const [subChaptersSnap, chaptersSnap, booksSnap] = await Promise.all([
      db.collection("subchapters_demo").get(),
      db.collection("chapters_demo").get(),
      db.collection("books_demo").get(),
    ]);

    const subChMap = {};
    subChaptersSnap.forEach((doc) => {
      subChMap[doc.id] = { ...doc.data(), firestoreId: doc.id };
    });

    const chaptersMap = {};
    chaptersSnap.forEach((doc) => {
      chaptersMap[doc.id] = { ...doc.data(), firestoreId: doc.id };
    });

    const booksMap = {};
    booksSnap.forEach((doc) => {
      booksMap[doc.id] = { ...doc.data(), firestoreId: doc.id };
    });

    // 3) Build the result
    const result = [];
    for (const pd of progressDocs) {
      const { userId, subChapterId, isDone } = pd;
      const subChDoc = subChMap[subChapterId];
      if (!subChDoc) continue;

      const chapterDoc = chaptersMap[subChDoc.chapterId];
      if (!chapterDoc) continue;

      const bookDoc = booksMap[chapterDoc.bookId];
      if (!bookDoc) continue;

      result.push({
        userId,
        bookName: bookDoc.name,
        chapterName: chapterDoc.name,
        subChapterName: subChDoc.name,
        isDone: isDone,
      });
    }

    return res.json({ success: true, progress: result });
  } catch (error) {
    console.error("Error in /api/user-progress:", error);
    return res
      .status(500)
      .json({ success: false, error: error.message });
  }
});

// =======================================
// ROUTE CATEGORY: LOGIN
// =======================================


app.post("/login", async (req, res) => {
  const { username, password } = req.body;

  try {
    // 1) Query Firestore for the user with the given username
    const usersSnapshot = await db
      .collection("users")
      .where("username", "==", username)
      .limit(1)
      .get();

    if (usersSnapshot.empty) {
      return res.status(401).json({ error: "Invalid username or password." });
    }

    const userDoc = usersSnapshot.docs[0];
    const userData = userDoc.data();

    // 2) Compare the provided password with the stored (hashed) password
    const isPasswordValid = await bcrypt.compare(password, userData.password);
    if (!isPasswordValid) {
      return res.status(401).json({ error: "Invalid username or password." });
    }

    // 3) Generate your existing JWT token for the server’s own logic if you want
    //    (You can skip this if you no longer need a separate token.)
    const token = jwt.sign(
      {
        id: userDoc.id,
        username: userData.username,
        role: userData.role,
      },
      process.env.JWT_SECRET,
      { expiresIn: "1h" }
    );

    // 4) Also create a Firebase Custom Token (using the Admin SDK)
    //    This is the important piece for letting the front end do signInWithCustomToken().
    const firebaseCustomToken = await admin
      .auth()
      .createCustomToken(userDoc.id, {
        username: userData.username,
        role: userData.role,
      });
    // The first param is the uid to assign in Firebase Auth
    // The second param is optional "additional claims"

    // 5) (Optional) Log a timestamp if desired
    await db.collection("loginTimestamps").add({
      userId: userDoc.id, // The doc ID of the user
      username: userData.username,
      timestamp: new Date(),
    });

    // 6) Send back success, your original token if you still want it, plus the new firebaseCustomToken
    res.json({
      success: true,
      token, // your existing JWT
      firebaseCustomToken, // new
      user: {
        username: userData.username,
        role: userData.role,
        onboardingComplete: userData.onboardingComplete || false,
        // any other fields you want
      },
    });
  } catch (error) {
    console.error("Error during login:", error);
    res.status(500).json({ error: "An error occurred during login." });
  }

  // For debugging: verify JWT_SECRET is present
  console.log("JWT_SECRET during signing:", process.env.JWT_SECRET);
});



// =======================================
// ROUTE CATEGORY: ONBOARDING
// =======================================



app.post("/complete-onboarding", authenticateToken, async (req, res) => {
  try {
    // We'll expect something like { answers: { question1: 3, question2: 5, ... } } in req.body
    const { answers } = req.body;

    // The token payload (req.user) should contain user.id or user.username
    // Assuming we stored user id in the token as: { id: userDoc.id, username, role }
    const userId = req.user.id;

    // Reference to the user's document
    const userDocRef = db.collection("users").doc(userId);

    // Update onboardingComplete and store answers
    await userDocRef.update({
      onboardingComplete: true,
      answers: answers || {},
    });

    return res.json({ success: true });
  } catch (error) {
    console.error("Error completing onboarding:", error);
    return res.status(500).json({ error: "Failed to complete onboarding" });
  }
});
app.post("/api/learnerpersona", authenticateToken, async (req, res) => {
  
  console.log("Inside learnerpersona route");

  
  try {
    const { category, answers } = req.body;
    const { id, username } = req.user || {};

    if (!id && !username) {
      return res.status(400).json({
        success: false,
        error: "No user identifier in token.",
      });
    }

    // Find user doc in Firestore
    let userDocId = null;
    const docRefById = db.collection("users").doc(id);
    const docSnapById = await docRefById.get();

    if (docSnapById.exists) {
      userDocId = id;
    } else {
      const snapshot = await db
        .collection("users")
        .where("username", "==", username)
        .get();

      if (snapshot.empty) {
        return res
          .status(404)
          .json({ success: false, error: "User not found in Firestore." });
      }

      userDocId = snapshot.docs[0].id;
    }

    // Mark onboardingComplete
    await db.collection("users").doc(userDocId).update({
      onboardingComplete: true,
    });

    // Create a record in "learnerPersonas"
    const newDocRef = await db.collection("learnerPersonas").add({
      userId: userDocId,
      category,
      answers,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return res.status(200).json({
      success: true,
      message: "User onboarding complete and form data stored.",
    });
  } catch (error) {
    console.error("Error in /api/learnerpersona route:", error);
    return res.status(500).json({
      success: false,
      error: error.message || "Internal server error",
    });
  }
});


app.get("/api/learner-personas", async (req, res) => {
  try {
    const userId = req.query.userId;
    if (!userId) {
      return res.status(400).json({
        success: false,
        error: "Missing userId in query params.",
      });
    }

    // Query the 'learnerPersonas' collection for a doc with the given userId.
    const snapshot = await admin
      .firestore()
      .collection("learnerPersonas") // Make sure this matches your actual Firestore collection name exactly (case-sensitive).
      .where("userId", "==", userId)
      .limit(1)
      .get();

    // If no doc found for this user, we default isOnboarded => false.
    if (snapshot.empty) {
      return res.json({
        success: true,
        data: { isOnboarded: false },
      });
    }

    // Grab the first matching doc (limit(1)).
    const doc = snapshot.docs[0];
    const data = doc.data() || {};

    // Use double-bang (!!) to ensure we end up with a strict boolean.
    // If data.isOnboarded is truthy, isOnboarded is true; otherwise false.
    const isOnboarded = !!data.isOnboarded;

    return res.json({
      success: true,
      data: { isOnboarded },
    });
  } catch (err) {
    console.error("Error fetching learnerPersona:", err);
    return res.status(500).json({
      success: false,
      error: "Server error fetching learnerPersona.",
    });
  }
});


app.post("/onboardingassessment", authenticateToken, async (req, res) => {
  try {
    const assessmentData = req.body;
    // attach userId from the token
    assessmentData.userId = req.user.id || null;

    // Save to Firestore (or your DB)
    const docRef = await db.collection("onboardingAssessments").add(assessmentData);

    return res.status(200).json({
      success: true,
      message: "Assessment data saved successfully!",
      docId: docRef.id,
    });
  } catch (error) {
    console.error("Error saving assessment data:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to save assessment data",
      error: error.message,
    });
  }
});


// =======================================
// ROUTE CATEGORY: WIDGET ONBOARDING
// =======================================

app.get("/api/learner-goal", async (req, res) => {
  try {
    const { userId } = req.query;
    if (!userId) {
      return res.status(400).json({
        success: false,
        error: "Missing userId query parameter.",
      });
    }

    // We'll query the collection e.g. "learner_personas" for docs where userId == ...
    const snapshot = await db
      .collection("learnerPersonas") // or your actual collection name
      .where("userId", "==", userId)
      .limit(1)
      .get();

    if (snapshot.empty) {
      // No doc for this user
      return res.json({
        success: true,
        data: null, // or { preparationGoal: null }
      });
    }

    // Grab the first doc
    const doc = snapshot.docs[0];
    const docData = doc.data();

    // "answers" is a map, we want answers.preparationGoal
    const preparationGoal = docData.answers?.preparationGoal || null;

    return res.json({
      success: true,
      data: {
        preparationGoal,
      },
    });
  } catch (error) {
    console.error("Error fetching learner goal:", error);
    return res.status(500).json({
      success: false,
      error: error.message || "Internal server error",
    });
  }
});
app.get("/api/reading-speed", async (req, res) => {
  try {
    const { userId } = req.query;
    if (!userId) {
      return res.status(400).json({
        success: false,
        error: "Missing userId query parameter.",
      });
    }

    // We'll query "onboarding_assessments" for the user
    const snapshot = await db
      .collection("onboardingAssessments") // or your actual collection name
      .where("userId", "==", userId)
      .limit(1)
      .get();

    if (snapshot.empty) {
      return res.json({
        success: true,
        data: null,
      });
    }

    const doc = snapshot.docs[0];
    const docData = doc.data();

    // The field is named readingTimeSec (the total # of seconds?)
    // Possibly you'd convert it to WPM if you want, but let's just return it as is.
    const readingTimeSec = docData.readingTimeSec || null;

    return res.json({
      success: true,
      data: {
        readingTimeSec,
      },
    });
  } catch (error) {
    console.error("Error fetching reading speed:", error);
    return res.status(500).json({
      success: false,
      error: error.message || "Internal server error",
    });
  }
});
app.get("/api/has-read-first-subchapter", async (req, res) => {
  try {
    const { userId } = req.query;
    if (!userId) {
      return res.status(400).json({
        success: false,
        error: "Missing userId query parameter."
      });
    }

    // Query user_activities_demo where userId == ... AND eventType == "stopReading"
    // If we find at least one doc, user has read a subchapter
    const snapshot = await db
      .collection("user_activities_demo")
      .where("userId", "==", userId)
      .where("eventType", "==", "stopReading")
      .limit(1)
      .get();

    const hasReadFirstSubchapter = !snapshot.empty;

    return res.json({
      success: true,
      data: {
        hasReadFirstSubchapter
      }
    });
  } catch (error) {
    console.error("Error in /api/has-read-first-subchapter:", error);
    return res.status(500).json({
      success: false,
      error: error.message || "Internal server error"
    });
  }
});
app.get("/api/has-completed-quiz", async (req, res) => {
  try {
    const { userId } = req.query;
    if (!userId) {
      return res.status(400).json({
        success: false,
        error: "Missing userId query parameter."
      });
    }

    // Query user_activities_demo where userId == ... AND eventType == "quizCompleted"
    // If we find at least one doc, user has completed a quiz
    const snapshot = await db
      .collection("user_activities_demo")
      .where("userId", "==", userId)
      .where("eventType", "==", "quizCompleted")
      .limit(1)
      .get();

    const hasCompletedQuiz = !snapshot.empty;

    return res.json({
      success: true,
      data: {
        hasCompletedQuiz
      }
    });
  } catch (error) {
    console.error("Error in /api/has-completed-quiz:", error);
    return res.status(500).json({
      success: false,
      error: error.message || "Internal server error"
    });
  }
});



// =======================================
// ROUTE CATEGORY: BOOKS AGGREGATION
// =======================================


app.get("/api/categories", async (req, res) => {
  try {
    const snapshot = await db.collection("categories_demo").get();
    const categories = [];
    snapshot.forEach((doc) => {
      const data = doc.data();
      categories.push({
        categoryId: doc.id, // Firestore doc ID
        categoryName: data.name,
      });
    });
    // Sort alphabetically by categoryName
    categories.sort((a, b) => a.categoryName.localeCompare(b.categoryName));

    return res.json({ success: true, data: categories });
  } catch (error) {
    console.error("Error fetching categories:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
});
app.get("/api/books", async (req, res) => {
  try {
    // Extract categoryId and userId from query params
    const { categoryId, userId } = req.query;

    // 1) Build a query referencing "books_demo"
    let booksRef = db.collection("books_demo");

    // Filter by category if provided
    if (categoryId) {
      booksRef = booksRef.where("categoryId", "==", categoryId);
    }

    // Filter by userId if provided
    if (userId) {
      booksRef = booksRef.where("userId", "==", userId);
    }

    // Fetch the filtered books
    const booksSnap = await booksRef.get();

    // 2) Fetch all chapters
    const chaptersSnap = await db.collection("chapters_demo").get();

    // 3) Fetch all subChapters
    const subChaptersSnap = await db.collection("subchapters_demo").get();

    // 4) Possibly fetch "adaptive_demo" doc for user
    let adaptiveRef = db.collection("adaptive_demo").orderBy("createdAt", "desc").limit(1);
    if (userId) {
      adaptiveRef = adaptiveRef.where("userId", "==", userId);
    }
    const adaptiveSnap = await adaptiveRef.get();

    // 5) Fetch quiz data from "quizzes_demo" for this user (if userId is relevant).
    //    We store them in a map keyed by subChapterId => doc with the most recent createdAt.
    let quizzesRef = db.collection("quizzes_demo");
    if (userId) {
      quizzesRef = quizzesRef.where("userId", "==", userId);
    }
    const quizzesSnap = await quizzesRef.get();

    // We'll store for each subChap: { score, createdAt: ... }
    const quizzesMap = {}; 
    quizzesSnap.forEach((doc) => {
      const qData = doc.data();
      const scId = qData.subChapterId;
      // If there's more than one quiz doc for the same subChId, keep the one with the newest createdAt
      // We'll assume 'createdAt' is a Firestore Timestamp
      const docCreatedAt = qData.createdAt || doc.createTime; 
      // doc.createTime is a Firestore server field if 'createdAt' wasn't set, but better to store 'createdAt' in your quiz docs explicitly

      if (!quizzesMap[scId]) {
        // First time we see this subchapter
        quizzesMap[scId] = {
          quizScore: qData.score || null,
          createdAt: docCreatedAt
        };
      } else {
        // Compare timestamps
        const existing = quizzesMap[scId];
        if (docCreatedAt && existing.createdAt) {
          // Convert Firestore Timestamp to milliseconds
          const newMs = docCreatedAt.toMillis ? docCreatedAt.toMillis() : 0;
          const oldMs = existing.createdAt.toMillis ? existing.createdAt.toMillis() : 0;
          if (newMs > oldMs) {
            quizzesMap[scId] = {
              quizScore: qData.score || null,
              createdAt: docCreatedAt
            };
          }
        }
      }
    });

    // ------------------------------------
    // Build subChId => sessionLabel from adaptive_demo
    // ------------------------------------
    const subChIdToSession = {};
    if (!adaptiveSnap.empty) {
      const docData = adaptiveSnap.docs[0].data();
      const sessions = docData.sessions || [];
      sessions.forEach((sess) => {
        const label = sess.sessionLabel;
        (sess.subChapterIds || []).forEach((id) => {
          subChIdToSession[id] = label;
        });
      });
    }

    // ------------------------------------
    // Build quick maps for books & chapters
    // ------------------------------------
    const booksMap = {}; // key = doc.id for the book
    booksSnap.forEach((doc) => {
      const data = doc.data();
      booksMap[doc.id] = {
        bookId: doc.id,
        bookName: data.name,
        chapters: [],
      };
    });

    const chaptersMap = {}; // key = doc.id for the chapter
    chaptersSnap.forEach((doc) => {
      const data = doc.data();
      chaptersMap[doc.id] = {
        chapterId: doc.id,
        chapterName: data.name,
        bookId: data.bookId,
        subChapters: [],
      };
    });

    // ------------------------------------
    // Link subChapters to chapters
    // ------------------------------------
    subChaptersSnap.forEach((doc) => {
      const data = doc.data();
      const chapterId = data.chapterId;

      if (chaptersMap[chapterId]) {
        const subChapterId = doc.id;

        // Check if in adaptive plan
        const sessionLabel = subChIdToSession[subChapterId] || null;
        const isAdaptive = sessionLabel !== null;

        // Convert Firestore Timestamps to ISO strings
        let startTime = null;
        let endTime = null;
        if (data.readStartTime) {
          startTime = data.readStartTime.toDate().toISOString();
        }
        if (data.readEndTime) {
          endTime = data.readEndTime.toDate().toISOString();
        }

        // Find the quiz doc with the most recent createdAt for this subchapter
        let quizScore = null;
        if (quizzesMap[subChapterId]) {
          quizScore = quizzesMap[subChapterId].quizScore;
        }

        chaptersMap[chapterId].subChapters.push({
          subChapterId,
          subChapterName: data.name,
          summary: data.summary || "",
          proficiency: data.proficiency || null,
          readStartTime: startTime,
          readEndTime: endTime,
          adaptive: isAdaptive,
          session: sessionLabel,
          wordCount: data.wordCount
            ? data.wordCount
            : data.summary
              ? data.summary.trim().split(/\s+/).length
              : 0,

          quizScore,
        });
      }
    });

    // ------------------------------------
    // Now link chapters to their books
    // ------------------------------------
    Object.values(chaptersMap).forEach((chap) => {
      if (booksMap[chap.bookId]) {
        booksMap[chap.bookId].chapters.push({
          chapterName: chap.chapterName,
          subChapters: chap.subChapters,
        });
      }
    });

    // ------------------------------------
    // Convert booksMap to an array & do final sorting
    // ------------------------------------
    let booksArray = Object.values(booksMap);

    // Sort books by bookName
    booksArray.sort((a, b) => a.bookName.localeCompare(b.bookName));

    // Sort chapters & subchapters by name
    booksArray = booksArray.map((book) => {
      const sortedChapters = [...book.chapters].sort((c1, c2) =>
        c1.chapterName.localeCompare(c2.chapterName)
      );

      const newChapters = sortedChapters.map((c) => {
        const sortedSubs = [...c.subChapters].sort((s1, s2) =>
          s1.subChapterName.localeCompare(s2.subChapterName)
        );
        return {
          ...c,
          subChapters: sortedSubs,
        };
      });

      return {
        bookName: book.bookName,
        chapters: newChapters,
      };
    });

    // Finally return
    return res.json(booksArray);
  } catch (error) {
    console.error("Error fetching books:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
});
app.get("/api/books-aggregated", async (req, res) => {
  try {
    const { userId, categoryId } = req.query;
    if (!userId) {
      return res.status(400).json({ success: false, error: "Missing userId" });
    }

    // 1) Fetch the needed collections
    let booksRef = db.collection("books_demo");
    if (categoryId) {
      booksRef = booksRef.where("categoryId", "==", categoryId);
    }

    const [booksSnap, chaptersSnap, subChaptersSnap] = await Promise.all([
      booksRef.get(),                         // only books in that category if categoryId was given
      db.collection("chapters_demo").get(),   // all chapters
      db.collection("subchapters_demo").get() // all subchapters
    ]);

    // 2) Build base aggregator structures
    const booksMap = {}; // bookId -> aggregator
    booksSnap.forEach((doc) => {
      const d = doc.data();
      booksMap[doc.id] = {
        bookId: doc.id,
        bookName: d.name,
        chaptersMap: {},
        // We'll track totalWords, plus read/proficient
        totalWords: 0,
        totalWordsReadOrProficient: 0,
        totalWordsProficient: 0,
      };
    });

    const chaptersMap = {}; // chapterId -> aggregator
    chaptersSnap.forEach((doc) => {
      const d = doc.data();
      chaptersMap[doc.id] = {
        chapterId: doc.id,
        chapterName: d.name,
        bookId: d.bookId,
        subChaptersMap: {},
        totalWords: 0,
        totalWordsReadOrProficient: 0,
        totalWordsProficient: 0,
      };
    });

    // 3) Attach subchapters: sum "read" or "proficient"
    subChaptersSnap.forEach((doc) => {
      const d = doc.data();
      const subChapterId = doc.id;
      const chapterId = d.chapterId;
      if (!chaptersMap[chapterId]) return; // skip if chapter is not relevant

      // Compute word count from d.wordCount or d.summary
      const computedWordCount = d.wordCount
        ? d.wordCount
        : d.summary
        ? d.summary.trim().split(/\s+/).length
        : 0;

      // We read `d.proficiency`, which can be "read", "proficient", or undefined
      const proficiency = d.proficiency; // e.g. "read" or "proficient"

      let wordsReadOrProficient = 0;
      let wordsProficient = 0;

      // "read or proficient" => add entire wordCount
      if (proficiency === "read" || proficiency === "proficient") {
        wordsReadOrProficient = computedWordCount;
      }
      // "proficient" => add entire wordCount
      if (proficiency === "proficient") {
        wordsProficient = computedWordCount;
      }

      // Build the subchapter aggregator object
      chaptersMap[chapterId].subChaptersMap[subChapterId] = {
        subChapterId,
        subChapterName: d.name,
        proficiency: proficiency || null,  // so front end can see the raw status
        wordCount: computedWordCount,
        wordsReadOrProficient,
        wordsProficient,
      };

      // Update chapter-level totals
      chaptersMap[chapterId].totalWords += computedWordCount;
      chaptersMap[chapterId].totalWordsReadOrProficient += wordsReadOrProficient;
      chaptersMap[chapterId].totalWordsProficient += wordsProficient;
    });

    // 4) Attach chapters to relevant books, sum up at book level
    Object.values(chaptersMap).forEach((chap) => {
      const { bookId } = chap;
      if (!booksMap[bookId]) return; // skip if not matching a selected book

      // Accumulate chapter totals into book totals
      booksMap[bookId].totalWords += chap.totalWords;
      booksMap[bookId].totalWordsReadOrProficient += chap.totalWordsReadOrProficient;
      booksMap[bookId].totalWordsProficient += chap.totalWordsProficient;

      // Put the chapter aggregator into the book aggregator
      booksMap[bookId].chaptersMap[chap.chapterId] = chap;
    });

    // 5) Convert to final array, build the shape
    let finalBooksArr = Object.values(booksMap).map((bookObj) => {
      const {
        bookName,
        chaptersMap,
        totalWords,
        totalWordsReadOrProficient,
        totalWordsProficient,
      } = bookObj;

      const readingPct =
        totalWords > 0 ? (totalWordsReadOrProficient / totalWords) * 100 : 0;
      const proficientPct =
        totalWords > 0 ? (totalWordsProficient / totalWords) * 100 : 0;

      // Sort chapters by name
      const sortedChapters = Object.values(chaptersMap).sort((a, b) =>
        a.chapterName.localeCompare(b.chapterName)
      );

      // Build chapter array with subchapters
      const chaptersArr = sortedChapters.map((chap) => {
        // sort subChapters by name
        const sortedSubs = Object.values(chap.subChaptersMap).sort((s1, s2) =>
          s1.subChapterName.localeCompare(s2.subChapterName)
        );

        const chapterReadingPct =
          chap.totalWords > 0
            ? (chap.totalWordsReadOrProficient / chap.totalWords) * 100
            : 0;

        const chapterProficientPct =
          chap.totalWords > 0
            ? (chap.totalWordsProficient / chap.totalWords) * 100
            : 0;

        // subChapters array with new proficiency fields
        const subChaptersArr = sortedSubs.map((sub) => {
          // We can compute a sub-level reading and proficient percentage if we like
          const subReadingPct =
            sub.wordCount > 0
              ? (sub.wordsReadOrProficient / sub.wordCount) * 100
              : 0;
          const subProficientPct =
            sub.wordCount > 0
              ? (sub.wordsProficient / sub.wordCount) * 100
              : 0;

          return {
            subChapterId: sub.subChapterId,
            subChapterName: sub.subChapterName,
            proficiency: sub.proficiency, // "read" or "proficient" or null
            wordCount: sub.wordCount,
            wordsReadOrProficient: sub.wordsReadOrProficient,
            wordsProficient: sub.wordsProficient,
            readingPercentage: subReadingPct,
            proficientPercentage: subProficientPct,
          };
        });

        return {
          chapterName: chap.chapterName,
          totalWords: chap.totalWords,
          totalWordsReadOrProficient: chap.totalWordsReadOrProficient,
          totalWordsProficient: chap.totalWordsProficient,
          readingPercentage: chapterReadingPct,
          proficientPercentage: chapterProficientPct,
          subChapters: subChaptersArr,
        };
      });

      return {
        bookName,
        totalWords,
        totalWordsReadOrProficient,
        totalWordsProficient,
        readingPercentage: readingPct,
        proficientPercentage: proficientPct,
        chapters: chaptersArr,
      };
    });

    // 6) sort books by name
    finalBooksArr.sort((a, b) => a.bookName.localeCompare(b.bookName));

    return res.json({
      success: true,
      data: finalBooksArr,
    });
  } catch (error) {
    console.error("Error in /api/books-aggregated:", error);
    return res
      .status(500)
      .json({ success: false, error: error.message || "Internal server error" });
  }
});
app.get("/api/user-book", async (req, res) => {
  try {
    const { userId } = req.query;
    if (!userId) {
      return res
        .status(400)
        .json({ success: false, error: "Missing userId query parameter." });
    }

    // We want the first or most recent book. Let's assume "createdAt" is a Firestore Timestamp
    // We'll order by "createdAt" descending and limit(1).
    const booksRef = db.collection("books_demo");
    const query = booksRef
      .where("userId", "==", userId)
      .orderBy("createdAt", "desc")
      .limit(1);

    const snapshot = await query.get();

    if (snapshot.empty) {
      // No books for this user
      return res.json({
        success: true,
        data: null, // or an empty object
      });
    }

    // Grab the first doc
    const doc = snapshot.docs[0];
    const docData = doc.data();
    // Convert "createdAt" if needed
    let createdAtISO = null;
    if (docData.createdAt) {
      createdAtISO = docData.createdAt.toDate().toISOString();
    }

    // Return minimal info or the full doc
    return res.json({
      success: true,
      data: {
        bookId: doc.id,
        name: docData.name,
        userId: docData.userId,
        categoryId: docData.categoryId || null,
        createdAt: createdAtISO,
      },
    });
  } catch (err) {
    console.error("Error in GET /api/user-book:", err);
    return res.status(500).json({
      success: false,
      error: err.message || "Internal server error",
    });
  }
});
app.get("/api/books-structure", async (req, res) => {
  try {
    // 1. Fetch all books
    const booksSnapshot = await db.collection("books_demo").get();
    const booksData = [];

    for (const bookDoc of booksSnapshot.docs) {
      const bookId = bookDoc.id;
      const book = {
        id: bookId,
        ...bookDoc.data(),
      };

      // 2. Fetch all chapters for this book
      const chaptersSnapshot = await db
        .collection("chapters_demo")
        .where("bookId", "==", bookId)
        .get();

      const chaptersData = [];
      for (const chapterDoc of chaptersSnapshot.docs) {
        const chapterId = chapterDoc.id;
        const chapter = {
          id: chapterId,
          ...chapterDoc.data(),
        };

        // 3. Fetch all subchapters for this chapter
        const subchaptersSnapshot = await db
          .collection("subchapters_demo")
          .where("chapterId", "==", chapterId)
          .get();

        const subchaptersData = subchaptersSnapshot.docs.map((subDoc) => ({
          id: subDoc.id,
          ...subDoc.data(),
        }));

        // Attach subchapters to the chapter
        chapter.subchapters = subchaptersData;
        chaptersData.push(chapter);
      }

      // Attach chapters to the book
      book.chapters = chaptersData;
      booksData.push(book);
    }

    // 4. Return nested structure
    return res.status(200).json(booksData);
  } catch (error) {
    console.error("Error fetching book structure:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// =======================================
// ROUTE CATEGORY: SUBCHAPTER SPECFIC
// =======================================


app.post("/api/complete-subchapter", async (req, res) => {
  try {
    const {
      userId,
      subChapterId,
      startReading,
      endReading
    } = req.body;

    // 1) Validate
    if (!userId || !subChapterId) {
      return res.status(400).json({
        success: false,
        error: "Missing userId or subChapterId in request body."
      });
    }

    // 2) Find the subchapter by ID
    const subchapterRef = db.collection("subchapters_demo").doc(subChapterId);
    const subchapterDoc = await subchapterRef.get();
    if (!subchapterDoc.exists) {
      return res.status(404).json({
        success: false,
        error: `Sub-chapter with ID '${subChapterId}' not found.`,
      });
    }

    // 3) Prepare update data
    const updateData = {};

    // If user clicked 'Start Reading'
    if (startReading) {
      updateData.proficiency = "reading";
      updateData.readStartTime = new Date();
      // Overwrite or clear any old end time
      updateData.readEndTime = null;
    }

    // If user clicked 'Finish Reading'
    if (endReading) {
      updateData.proficiency = "read";
      updateData.readEndTime = new Date();
      // (We assume readStartTime already set if it was reading)
      // If you want to ensure readStartTime is not null, you can handle that logic here
    }

    // 4) Update the subchapters_demo doc
    await subchapterRef.update(updateData);

    return res.json({ success: true });
  } catch (error) {
    console.error("Error in /api/complete-subchapter route:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
});



// =======================================
// ROUTE CATEGORY: QUIZ
// =======================================

app.post("/api/quizzes", async (req, res) => {
  try {
    const {
      userId,
      subChapterId,
      subChapterName,
      questions,
      selectedAnswers,
      score
    } = req.body;
    
    // Basic validations
    if (!userId) {
      return res.status(400).json({ error: "Missing userId" });
    }
    if (!subChapterId) {
      return res.status(400).json({ error: "Missing subChapterId" });
    }
    if (!subChapterName) {
      return res.status(400).json({ error: "Missing subChapterName" });
    }
    if (!Array.isArray(questions)) {
      return res.status(400).json({ error: "Invalid questions array" });
    }

    // Example: Firestore "quizzes_demo" collection
    // Adjust if your Firestore instance or collection name differs.
    const quizzesRef = db.collection("quizzes_demo");
    
    // Create a doc with auto-generated ID
    await quizzesRef.add({
      userId,
      subChapterId,
      subChapterName,
      questions,
      selectedAnswers,
      score,
      createdAt: new Date()
    });

    return res.json({ success: true });
  } catch (err) {
    console.error("Error saving quiz:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});
app.get("/api/quizzes", async (req, res) => {
  try {
    const { userId, subChapterId } = req.query;
    if (!userId || !subChapterId) {
      return res.status(400).json({ success: false, error: "Missing userId or subChapterId" });
    }

    // Query Firestore for the MOST RECENT doc matching userId + subChapterId
    // by ordering 'createdAt' descending, then limiting to 1
    const quizzesRef = db.collection("quizzes_demo");
    const snapshot = await quizzesRef
      .where("userId", "==", userId)
      .where("subChapterId", "==", subChapterId)
      .orderBy("createdAt", "desc")
      .limit(1)
      .get();

    if (snapshot.empty) {
      // No existing quiz
      return res.json({
        success: false,
        message: "No quiz found for this subChapterId & user."
      });
    }

    // Grab the first (and only) doc from this query
    const doc = snapshot.docs[0];
    const data = doc.data();

    // Return the doc data
    return res.json({ success: true, data });
  } catch (err) {
    console.error("Error fetching quiz:", err);
    return res.status(500).json({ success: false, error: "Internal server error" });
  }
});





// =======================================
// ROUTE CATEGORY: USER ACTIVITY
// =======================================

app.post("/api/user-activities", async (req, res) => {
  try {
    const { userId, subChapterId, eventType, timestamp } = req.body;

    if (!userId || !subChapterId || !eventType) {
      return res.status(400).json({
        success: false,
        error: "Missing required fields: userId, subChapterId, eventType.",
      });
    }

    // Build document data
    const docData = {
      userId,
      subChapterId,
      eventType,
      timestamp: timestamp ? new Date(timestamp) : new Date(), // fallback
    };

    await db.collection("user_activities_demo").add(docData);

    return res.json({ success: true });
  } catch (error) {
    console.error("Error in POST /api/user-activities:", error);
    return res
      .status(500)
      .json({ success: false, error: error.message || "Internal server error" });
  }
});
app.get("/api/user-activities", async (req, res) => {
  try {
    const { userId } = req.query;
    if (!userId) {
      return res.status(400).json({
        success: false,
        error: "Missing 'userId' query parameter.",
      });
    }

    // Build query: userId + orderBy timestamp desc
    let query = db
      .collection("user_activities_demo")
      .where("userId", "==", userId)
      .orderBy("timestamp", "desc"); // optional limit(...) if you only want the last X

    const snapshot = await query.get();
    if (snapshot.empty) {
      return res.json({
        success: true,
        data: [],
      });
    }

    // Map docs to a simple array
    const activities = snapshot.docs.map((doc) => {
      const data = doc.data();
      return {
        id: doc.id, // doc id if needed
        eventType: data.eventType,
        subChapterId: data.subChapterId,
        timestamp: data.timestamp
          ? data.timestamp.toDate().toISOString() // convert Firestore Timestamp to string
          : null,
        userId: data.userId,
      };
    });

    return res.json({
      success: true,
      data: activities,
    });
  } catch (err) {
    console.error("Error fetching user activities:", err);
    return res.status(500).json({
      success: false,
      error: err.message || "Internal server error",
    });
  }
});






app.get("/api/adaptive-plan", async (req, res) => {
  try {
    console.log("[GET /api/adaptive-plan] Incoming request...");
    const { planId } = req.query;
    console.log("Query params:", req.query);

    if (!planId) {
      console.log("No 'planId' provided, returning 400...");
      return res.status(400).json({ error: "Missing 'planId' in query params" });
    }

    // 1) Check 'adaptive_demo'
    console.log(`Checking 'adaptive_demo' for planId='${planId}'`);
    const demoRef = db.collection("adaptive_demo").doc(planId);
    const demoSnap = await demoRef.get();

    if (demoSnap.exists) {
      console.log(`Found doc in 'adaptive_demo' => planId='${planId}'`);
      const planData = demoSnap.data();

      // Attach Firestore doc ID to the returned data (so front-end can see planData.id)
      planData.id = demoSnap.id;

      console.log(
        "Returning planDoc from 'adaptive_demo' => docId:",
        demoSnap.id
      );
      return res.json({ planDoc: planData });
    }

    // 2) If not found in 'adaptive_demo', check 'adaptive_books'
    console.log(
      `Not found in 'adaptive_demo'. Checking 'adaptive_books' for planId='${planId}'`
    );
    const booksRef = db.collection("adaptive_books").doc(planId);
    const booksSnap = await booksRef.get();

    if (booksSnap.exists) {
      console.log(`Found doc in 'adaptive_books' => planId='${planId}'`);
      const planData = booksSnap.data();

      // Also attach doc ID here
      planData.id = booksSnap.id;

      console.log(
        "Returning planDoc from 'adaptive_books' => docId:",
        booksSnap.id
      );
      return res.json({ planDoc: planData });
    }

    // 3) If not found in either collection => 404
    console.log(
      `Document '${planId}' not found in 'adaptive_demo' nor 'adaptive_books'`
    );
    return res.status(404).json({
      error: `Plan document ${planId} not found in any collection`,
    });
  } catch (error) {
    console.error("Error in /api/adaptive-plan route:", error);
    logger.error("Error fetching plan from adaptive_demo/books:", error);
    return res.status(500).json({ error: error.message });
  }
});



// Assuming you already have:
// const app = express(); // your Express app
// const db = admin.firestore(); // your Firestore reference
// app.use(cors({ origin: true }));

app.get("/api/subchapters/:id", async (req, res) => {
  try {
    const subChapterId = req.params.id;
    console.log("Fetching subchapter document:", subChapterId);

    // 1) Read the document from subchapters_demo
    const docRef = db.collection("subchapters_demo").doc(subChapterId);
    const docSnap = await docRef.get();

    if (!docSnap.exists) {
      // If not found, return 404
      return res.status(404).json({
        error: `Subchapter '${subChapterId}' not found in 'subchapters_demo'.`
      });
    }

    // 2) Data from Firestore
    const data = docSnap.data();

    // If you want to rename fields or ensure certain properties:
    // e.g. "name" -> "subChapterName"
    // "summary" -> The main text
    // "wordCount" -> numeric field
    // "proficiency" -> "empty"/"reading"/"read"/"proficient"
    // "readStartTime" and "readEndTime" might be Firestore timestamps
    // Here is an example mapping:

    const responseData = {
      subChapterId: subChapterId, // or docSnap.id
      subChapterName: data.name || "Untitled",
      summary: data.summary || "",
      wordCount: data.wordCount || 0,
      proficiency: data.proficiency || "empty",
      // Convert Firestore Timestamp to ISO if they exist
      readStartTime: data.readStartTime ? data.readStartTime.toDate().toISOString() : null,
      readEndTime: data.readEndTime ? data.readEndTime.toDate().toISOString() : null,
      // any other fields you want
    };

    // 3) Return the subchapter data
    return res.json(responseData);

  } catch (error) {
    console.error("Error fetching subchapter doc:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
});



// =======================================
// ROUTE CATEGORY: THE MAIN THING
// =======================================




app.get("/api/home-plan-id", async (req, res) => {
  try {
    const { userId, bookId } = req.query;
    if (!userId || !bookId) {
      return res
        .status(400)
        .json({ error: "Missing userId or bookId in query params" });
    }

    const db = admin.firestore();
    const collRef = db.collection("adaptive_books");

    // Query docs where userId == userId AND bookId == bookId, ordered by createdAt desc
    const querySnap = await collRef
      .where("userId", "==", userId)
      .where("bookId", "==", bookId)
      .orderBy("createdAt", "desc")
      // .limit(1)  <- Remove or comment out limit to get *all* matching docs
      .get();

    if (querySnap.empty) {
      return res.json({
        success: true,
        planIds: [], // Return empty array if no docs found
      });
    }

    // Collect all matching doc IDs
    const planIds = querySnap.docs.map((doc) => doc.id);

    return res.json({
      success: true,
      planIds, // e.g. ["doc1", "doc2", ...] in descending order
    });
  } catch (error) {
    console.error("Error fetching home plan IDs:", error);
    return res.status(500).json({ error: error.message });
  }
});


app.get("/api/adaptive-plan-id", async (req, res) => {
  try {
    const { userId, bookId } = req.query;
    if (!userId || !bookId) {
      return res
        .status(400)
        .json({ error: "Missing userId or bookId in query params" });
    }

    const db = admin.firestore();
    const collRef = db.collection("adaptive_demo");

    // Query docs where userId == userId AND bookId == bookId, ordered by createdAt desc
    const querySnap = await collRef
      .where("userId", "==", userId)
      .where("bookId", "==", bookId)
      .orderBy("createdAt", "desc")
      // .limit(1) <- Remove or comment out limit to get *all* matching docs
      .get();

    if (querySnap.empty) {
      // No docs found
      return res.json({
        success: true,
        planIds: []
      });
    }

    // Grab all matching doc IDs
    const planIds = querySnap.docs.map((doc) => doc.id);

    return res.json({
      success: true,
      planIds
    });
  } catch (error) {
    console.error("Error fetching adaptive plan IDs:", error);
    return res.status(500).json({ error: error.message });
  }
});


app.get("/api/adaptive-plans", async (req, res) => {
  try {
    const { userId, bookId } = req.query;

    if (!userId) {
      return res.status(400).json({ error: "Missing userId in query." });
    }

    // Start with a base query for userId
    let query = db.collection("adaptive_demo").where("userId", "==", userId);

    // If bookId is provided, extend the query to also match the bookId
    if (bookId) {
      query = query.where("bookId", "==", bookId);
    }

    // Execute the query
    const snap = await query.get();
    const plans = [];
    snap.forEach((doc) => {
      plans.push({ id: doc.id, ...doc.data() });
    });

    return res.json({ success: true, plans });
  } catch (err) {
    console.error("Error fetching plans in Express route:", err);
    return res.status(500).json({ error: err.message });
  }
});



app.get("/api/books-user", async (req, res) => {
  try {
    const { userId } = req.query;
    if (!userId) {
      return res
        .status(400)
        .json({ success: false, error: "Missing userId in query params" });
    }

    // Query the "books_demo" collection for all docs where "userId" field matches
    const snapshot = await db
      .collection("books_demo")
      .where("userId", "==", userId)
      .get();

    const books = snapshot.docs.map((doc) => {
      const data = doc.data();

      // Convert Firestore Timestamp to a string (ISO 8601), or fallback
      let createdAtString = null;
      if (data.createdAt && data.createdAt.toDate) {
        // If it's an actual Firestore Timestamp field
        createdAtString = data.createdAt.toDate().toISOString();
      } else {
        // Fallback to Firestore doc metadata's createTime if no custom createdAt
        createdAtString = doc.createTime
          ? doc.createTime.toDate().toISOString()
          : null;
      }

      return {
        // doc.id is the Firestore document ID
        id: doc.id,
        ...data,
        // Force the createdAt field to be a plain string for the frontend
        createdAt: createdAtString,
      };
    });

    return res.json({ success: true, data: books });
  } catch (error) {
    console.error("Error fetching books for user:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
});



// Initialize Firebase admin if not already done
// admin.initializeApp({
//   credential: admin.credential.applicationDefault(),
//   ...
// });



// Reuse or define your numeric-aware sorting functions
function parseLeadingSections(str) {
  const parts = str.split('.').map(p => p.trim());
  const result = [];
  for (let i = 0; i < parts.length; i++) {
    const maybeNum = parseInt(parts[i], 10);
    if (!isNaN(maybeNum)) {
      result.push(maybeNum);
    } else {
      break;
    }
  }
  if (result.length === 0) return [Infinity];
  return result;
}

function compareSections(aSections, bSections) {
  const len = Math.max(aSections.length, bSections.length);
  for (let i = 0; i < len; i++) {
    const aVal = aSections[i] ?? 0;
    const bVal = bSections[i] ?? 0;
    if (aVal !== bVal) {
      return aVal - bVal;
    }
  }
  return 0;
}

function sortByNameNumericAware(items = []) {
  return items.sort((a, b) => {
    if (!a.name && !b.name) return 0;
    if (!a.name) return 1;
    if (!b.name) return -1;
    const aSections = parseLeadingSections(a.name);
    const bSections = parseLeadingSections(b.name);
    const sectionCompare = compareSections(aSections, bSections);
    if (sectionCompare !== 0) {
      return sectionCompare;
    } else {
      return a.name.localeCompare(b.name);
    }
  });
}



// GET /api/processing-data?userId=XYZ
app.get('/api/processing-data', async (req, res) => {
  try {
    const userId = req.query.userId || '';
    if (!userId) {
      return res.status(400).json({ error: 'Missing userId param' });
    }

    // 1) Fetch all books for this user from "books_demo"
    const booksSnap = await db
      .collection('books_demo')
      .where('userId', '==', userId)
      .orderBy('createdAt', 'desc')
      .get();

    const booksData = [];
    for (const bookDoc of booksSnap.docs) {
      const book = { id: bookDoc.id, ...bookDoc.data() };

      // 2) For each book, find the pdfExtracts that reference it (via bookDemoId)
      const pdfExtractsSnap = await db
        .collection('pdfExtracts')
        .where('bookDemoId', '==', bookDoc.id)
        .get();

      // We'll store a small array of extracts, each with # of pages
      const pdfExtractsArr = [];
      for (const extractDoc of pdfExtractsSnap.docs) {
        const edata = extractDoc.data() || {};
        const extractId = extractDoc.id;

        // Count how many pages are in pdfPages for this doc
        const pagesSnap = await db
          .collection('pdfPages')
          .where('pdfDocId', '==', extractId)
          .get();

        const pagesCount = pagesSnap.size; // no need to fetch text

        pdfExtractsArr.push({
          id: extractId,
          filePath: edata.filePath || '',
          createdAt: edata.createdAt || null,
          pagesCount,
        });
      }

      // 3) For each book, fetch chapters_demo
      const chaptersSnap = await db
        .collection('chapters_demo')
        .where('bookId', '==', bookDoc.id)
        .get();

      // We'll collect chapters with minimal info, sorted numerically by name
      let chaptersArr = [];
      for (const chapDoc of chaptersSnap.docs) {
        const cdata = chapDoc.data() || {};
        const chapterId = chapDoc.id;

        // Now fetch subchapters_demo for this chapter
        const subSnap = await db
          .collection('subchapters_demo')
          .where('chapterId', '==', chapterId)
          .get();

        let subArr = [];
        for (const sDoc of subSnap.docs) {
          const sdata = sDoc.data() || {};
          subArr.push({
            id: sDoc.id,
            name: sdata.name || '',
            summary: sdata.summary || '',
          });
        }

        // Sort subchapters by name numeric-aware
        subArr = sortByNameNumericAware(subArr);

        chaptersArr.push({
          id: chapterId,
          name: cdata.name || '',
          subchapters: subArr,
        });
      }

      // Now sort the chapters by numeric-aware name
      chaptersArr = sortByNameNumericAware(chaptersArr);

      // Build final object for each book
      const bookObj = {
        ...book,
        pdfExtracts: pdfExtractsArr,
        chapters: chaptersArr,
      };

      booksData.push(bookObj);
    }

    // Final payload
    res.status(200).json({
      userId,
      books: booksData,
    });
  } catch (error) {
    console.error('Error fetching processing data:', error);
    res.status(500).json({ error: error.message });
  }
});



// server.js or app.js (wherever your Express server is defined)

app.get('/api/chapters-process', async (req, res) => {
  try {
    const bookId = req.query.bookId || '';
    const userId = req.query.userId || 'unknownUser';

    if (!bookId) {
      return res.status(400).json({ error: 'Missing bookId parameter' });
    }

    // Query pdfSummaries where bookId == ...
    const snap = await db
      .collection('pdfSummaries')
      .where('bookId', '==', bookId)
      .limit(1)
      .get();

    if (snap.empty) {
      return res.status(404).json({
        error: `No pdfSummaries doc found for bookId=${bookId}.`
      });
    }

    // We pick the first doc
    const summaryDoc = snap.docs[0];
    const summaryData = summaryDoc.data() || {};

    // We expect "summary" to be a GPT JSON string like:
    // { chapters: [ { title, summary, startPage, endPage }, ... ] }
    const rawJson = summaryData.summary || '';
    if (!rawJson) {
      return res.status(404).json({
        error: `pdfSummaries doc doesn't have a 'summary' field for bookId=${bookId}.`
      });
    }

    // Attempt to parse
    let parsedSummary;
    try {
      parsedSummary = JSON.parse(rawJson);
    } catch (err) {
      return res.status(500).json({
        error: 'Failed to parse the GPT summary JSON.',
        details: err.message,
      });
    }

    // The chapters array
    const chapters = parsedSummary.chapters || [];

    // Return it
    return res.status(200).json({
      userId,
      bookId,
      chapters
    });
  } catch (err) {
    console.error('Error in /api/chapters-process =>', err);
    return res.status(500).json({ error: err.message });
  }
});


app.get('/api/process-book-data', async (req, res) => {
  try {
    const userId = req.query.userId || '';
    const bookId = req.query.bookId || '';

    if (!userId || !bookId) {
      return res
        .status(400)
        .json({ error: 'Missing userId or bookId param' });
    }

    // 1) Fetch chapters from "chapters_demo" matching userId & bookId
    const chaptersSnap = await db
      .collection('chapters_demo')
      .where('userId', '==', userId)
      .where('bookId', '==', bookId)
      .get();

    let chaptersArr = [];

    // 2) For each chapter, also fetch subchapters from "subchapters_demo"
    for (const chapDoc of chaptersSnap.docs) {
      const cdata = chapDoc.data() || {};
      const chapterId = chapDoc.id;

      // fetch subchapters for this chapter
      const subSnap = await db
        .collection('subchapters_demo')
        .where('userId', '==', userId)
        .where('bookId', '==', bookId)
        .where('chapterId', '==', chapterId)
        .get();

      let subArr = [];
      for (const sDoc of subSnap.docs) {
        const sdata = sDoc.data() || {};
        subArr.push({
          id: sDoc.id,
          name: sdata.name || '',
          summary: sdata.summary || '',
        });
      }

      chaptersArr.push({
        id: chapterId,
        name: cdata.name || '',
        subchapters: subArr,
      });
    }

    // 3) Send the final JSON response
    res.status(200).json({
      userId,
      bookId,
      chapters: chaptersArr,
    });
  } catch (error) {
    console.error('Error in process-book-data:', error);
    res.status(500).json({ error: error.message });
  }
});


// Example in your Express server file

app.get('/api/latest-book', async (req, res) => {
  console.log('[DEBUG] (LATEST BOOK) Route called.');
  console.log('[DEBUG] Query params =>', req.query);

  try {
    const userId = req.query.userId || '';
    console.log(`[DEBUG] userId extracted => "${userId}"`);

    if (!userId) {
      console.log('[DEBUG] No userId provided => returning 400.');
      return res.status(400).json({ error: 'Missing userId' });
    }

    console.log('[DEBUG] Querying books_demo collection...');
    const snap = await db
      .collection('books_demo')
      .where('userId', '==', userId)
      .orderBy('createdAt', 'desc')
      .limit(1)
      .get();

    console.log('[DEBUG] Firestore query complete. snap.empty =>', snap.empty);

    if (snap.empty) {
      console.log(`[DEBUG] No books found for userId="${userId}". Returning 404.`);
      return res.status(404).json({ error: 'No books found for this user' });
    }

    // The first (and only) doc in the snapshot
    const doc = snap.docs[0];
    const bookId = doc.id;
    const docData = doc.data();

    console.log('[DEBUG] Found at least one book. bookId =>', bookId);
    console.log('[DEBUG] Book doc data =>', docData);

    // Return just the bookId or the entire doc if you prefer
    return res.status(200).json({ bookId });
  } catch (error) {
    console.error('[ERROR] /api/latest-book =>', error);
    return res.status(500).json({ error: error.message });
  }
});

app.post("/login-google", async (req, res) => {
  try {
    const { idToken } = req.body;
    // 1) Verify the ID token
    const decoded = await admin.auth().verifyIdToken(idToken);
    const uid = decoded.uid;
    const email = decoded.email || "";
    const name = decoded.name || "";

    // 2) Lookup or create the user doc in Firestore "users" collection
    const usersRef = db.collection("users").doc(uid);
    const userSnap = await usersRef.get();
    let userData;
    if (!userSnap.exists) {
      // Create the doc if it doesn't exist. Possibly store a placeholder password
      userData = {
        username: email, // or name
        password: "",    // no password for google
        role: "googleUser",
        createdAt: new Date(),
      };
      await usersRef.set(userData);
    } else {
      userData = userSnap.data();
    }

    // 3) Create your own JWT
    const token = jwt.sign(
      {
        id: uid,
        username: userData.username,
        role: userData.role,
      },
      process.env.JWT_SECRET,
      { expiresIn: "1h" }
    );

    // 4) Create a Firebase custom token
    const firebaseCustomToken = await admin
      .auth()
      .createCustomToken(uid, { role: userData.role });

    // 5) Return success, plus tokens & user
    res.json({
      success: true,
      token, // your own server JWT
      firebaseCustomToken,
      user: {
        username: userData.username,
        role: userData.role,
        onboardingComplete: userData.onboardingComplete || false,
        // anything else you want
      },
    });
  } catch (error) {
    console.error("Error in /login-google:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});


// Pseudocode for your server
app.post("/create-learner-persona", async (req, res) => {
  const { userId, wpm, dailyReadingTime } = req.body;
  // Check if there's already a doc in learnerPersonas for this userId
  const docRef = db.collection("learnerPersonas").doc(userId);
  const snap = await docRef.get();
  if (!snap.exists) {
    // Create doc with the given data
    await docRef.set({
      userId,
      wpm: wpm,
      dailyReadingTime: dailyReadingTime
    });
  }
  return res.json({ success: true });
});


app.post("/api/learner-personas/onboard", async (req, res) => {
  try {
    console.log("[/api/learner-personas/onboard] Received request");
    console.log("Request body:", req.body);

    const { userId } = req.body;
    if (!userId) {
      console.log("Error: Missing userId in body");
      return res.status(400).json({ success: false, error: "Missing userId" });
    }

    console.log(`Marking user ${userId} as onboarded in Firestore...`);
    await db
      .collection("learnerPersonas")
      .doc(userId)
      .set({ isOnboarded: true }, { merge: true });

    console.log(`Success: user ${userId} marked as onboarded`);
    return res.json({ success: true });
  } catch (err) {
    console.error("Error marking user onboarded:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
});


app.get("/api/getPrompt", async (req, res) => {
  try {
    // 1) read promptKey from query
    const { promptKey } = req.query;
    if (!promptKey) {
      return res.status(400).json({ error: "Missing promptKey in query" });
    }

    // 2) fetch from Firestore
    const collRef = db.collection("prompts");
    const snap = await collRef.where("promptKey", "==", promptKey).limit(1).get();

    if (snap.empty) {
      return res.status(404).json({ error: "Prompt not found." });
    }

    // 3) Return the first doc found
    const doc = snap.docs[0];
    const docData = doc.data();

    return res.json({
      prompt: {
        docId: doc.id,
        promptKey: docData.promptKey,
        promptText: docData.promptText,
      },
    });
  } catch (err) {
    console.error("GET /api/getPrompt => error:", err);
    return res.status(500).json({ error: err.message });
  }
});


// e.g. in Express
app.get("/api/userActivities", async (req, res) => {
  try {
    const { subChapterId } = req.query;
    if (!subChapterId) return res.status(400).json({ error: "Missing subChapterId" });
    
    // Example: your Firestore collection = user__activities__demo
    // Filter by subChapterId field. Sort descending by e.g. timestamp.
    const snap = await db.collection("user__activities__demo")
      .where("subChapterId", "==", subChapterId)
      .orderBy("startTimestamp", "desc")
      .get();

    const activities = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    res.json({ activities });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

/**
 * POST /api/createPrompt
 * ----------------------
 *  - Expects JSON body: { promptKey, promptText }
 *  - Creates new doc in 'prompts' collection
 */
app.post("/api/createPrompt", async (req, res) => {
  try {
    const { promptKey, promptText } = req.body;
    if (!promptKey || !promptText) {
      return res.status(400).json({ error: "Missing promptKey or promptText in body." });
    }

    // Optionally check if promptKey already exists
    const collRef = db.collection("prompts");
    const existing = await collRef.where("promptKey", "==", promptKey).limit(1).get();
    if (!existing.empty) {
      return res.status(400).json({
        error: `A prompt with key '${promptKey}' already exists.`,
      });
    }

    // Create new doc
    const newDocRef = await collRef.add({
      promptKey,
      promptText,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return res.status(201).json({
      docId: newDocRef.id,
      message: "Prompt created successfully",
    });
  } catch (err) {
    console.error("POST /api/createPrompt => error:", err);
    return res.status(500).json({ error: err.message });
  }
});



app.post("/revision", async (req, res) => {
  try {
    const { subChapterId } = req.body;
    if (!subChapterId) {
      return res.status(400).json({ error: "subChapterId is required" });
    }

    // 1) Fetch subchapter details
    const subChapter = await fetchSubchapterDetails(subChapterId);

    // 2) Fetch user activities
    const activities = await fetchUserActivities(subChapterId);

    // 3) Call GPT to generate revision content
    const revisionData = await generateRevisionData(subChapter, activities);

    // 4) Send the GPT-generated data as JSON back to the React frontend
    return res.json(revisionData);
  } catch (err) {
    console.error("Error in POST /api/revision:", err);
    return res.status(500).json({ error: err.message || "Server Error" });
  }
});

/**
 * Example function to fetch subchapter details from your DB or an internal API.
 * Replace this with your actual logic.
 */
async function fetchSubchapterDetails(subChapterId) {
  // Example: use fetch/axios if your data is in another service:
  // const resp = await fetch(`http://localhost:3001/api/subchapters/${subChapterId}`);
  // if (!resp.ok) throw new Error("Error fetching subchapter");
  // return resp.json();

  // Or direct DB access in Node:
  // return db.query("SELECT * FROM subchapters WHERE id = $1", [subChapterId]);

  // For now, mock:
  return {
    id: subChapterId,
    name: "Mock SubChapter Name",
    summary: "This is a mock summary for demonstration purposes.",
  };
}

/**
 * Example function to fetch user activities from your DB/collection.
 */
async function fetchUserActivities(subChapterId) {
  // Again, replace with your real logic. For demonstration:
  return [
    { activityId: "a1", detail: "User tried to solve problem #1" },
    { activityId: "a2", detail: "User completed a quiz" },
  ];
}

/**
 * Example function that calls GPT using openai npm package.
 */
async function generateRevisionData(subChapter, activities) {
  const openaiKey = process.env.OPENAI_API_KEY;
  if (!openaiKey) {
    throw new Error("Missing OpenAI API key in environment (OPENAI_API_KEY)");
  }

  const config = new Configuration({ apiKey: openaiKey });
  const openai = new OpenAIApi(config);

  // Build a prompt. (Feel free to adapt from your existing prompt logic.)
  const userPrompt = `
You are a helpful tutor. The user is in the "apply" stage for sub-chapter: ${subChapter.name}.
The sub-chapter content: "${subChapter.summary}"
User activities: ${JSON.stringify(activities, null, 2)}

Generate some revision suggestions or summary in plain JSON. 
For example:
{
  "someKey": "someValue",
  "anotherKey": ["list", "of", "items"]
}
`;

  // Call GPT (Chat Completion)
  const response = await openai.createChatCompletion({
    model: "gpt-3.5-turbo",
    messages: [{ role: "user", content: userPrompt }],
    temperature: 0.7,
  });

  const gptContent = response.data.choices?.[0]?.message?.content || "";

  // Possibly parse GPT content as JSON, or just return raw text:
  let parsed;
  try {
    parsed = JSON.parse(gptContent.trim());
  } catch (err) {
    // If GPT doesn't return valid JSON, you might decide to just return the raw text
    // or handle the error as needed.
    parsed = { rawText: gptContent.trim(), warning: "GPT did not return valid JSON." };
  }

  return parsed;
}
/*

app.post("/api/generate", async (req, res) => {
  try {
    const { userId, subchapterId, promptKey } = req.body;
    if (!userId || !subchapterId || !promptKey) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const db = admin.firestore();

    // 1. Fetch the prompt text and UI configuration from "prompts" by promptKey
    const promptSnapshot = await db
      .collection("prompts")
      .where("promptKey", "==", promptKey)
      .limit(1)
      .get();

    let promptText = "";
    let UIconfig = {};

    if (!promptSnapshot.empty) {
      // Take the first matched document
      const promptDoc = promptSnapshot.docs[0];
      const promptData = promptDoc.data();
      promptText = promptData.promptText || "";
      UIconfig = promptData.UIconfig || {};
    } else {
      console.warn(`No prompt document found for promptKey: ${promptKey}`);
    }

    // 2. Fetch user activities for this user and subchapter from "user_activities_demo"
    const activitiesSnapshot = await db
      .collection("user_activities_demo")
      .where("userId", "==", userId)
      .where("subChapterId", "==", subchapterId)  // Note the capital "C" if that's how it is in Firestore
      .orderBy("timestamp", "desc")
      .get();

    let activitiesText = "";
    activitiesSnapshot.forEach((doc) => {
      const data = doc.data();
      const activityText = data.content || data.eventType || "";
      if (activityText) {
        activitiesText += activityText + "\n";
      }
    });

    // 3. Fetch subchapter summary from "subchapters_demo"
    const subChapterDoc = await db
      .collection("subchapters_demo")
      .doc(subchapterId)
      .get();

    let subChapterSummary = "";
    if (subChapterDoc.exists) {
      const subChapterData = subChapterDoc.data();
      subChapterSummary = subChapterData.summary || "";
    } else {
      console.warn(`No subchapter document found for subchapterId: ${subchapterId}`);
    }

    // 4. Construct the final prompt
    const finalPrompt = `Subchapter Summary: ${subChapterSummary}\n\nUser Activities:\n${activitiesText}\n\nPrompt Text: ${promptText}`;
    console.log("Final Prompt being sent to OpenAI:", finalPrompt);

    // 5. Call OpenAI API (use whichever model you need)
    const openaiResponse = await openai.chat.completions.create({
      model: "gpt-4o", // or gpt-3.5-turbo, etc.
      messages: [{ role: "user", content: finalPrompt }],
      max_tokens: 1000,
      temperature: 0.7,
    });

    const result = openaiResponse.choices[0].message.content.trim();
    console.log("OpenAI result:", result);

    // 6. Return the final prompt, GPT result, and UI configuration
    return res.json({ finalPrompt, result, UIconfig });
  } catch (error) {
    console.error("Error generating text:", error);
    return res.status(500).json({ error: "Failed to generate text" });
  }
});

// Start the server on port 3001 (or your chosen port)

// app.post("/api/submitQuiz", ...)
// POST /api/submitQuiz
app.post("/api/submitQuiz", async (req, res) => {
  try {
    const {
      userId,
      subchapterId,
      quizType,
      quizSubmission,
      score,
      totalQuestions,
      attemptNumber,  // NEW FIELD
    } = req.body;

    if (!userId || !subchapterId || !quizType || !quizSubmission || !score) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const db = admin.firestore();

    // Add a new doc in quizzes_demo with the attemptNumber
    const docRef = await db.collection("quizzes_demo").add({
      userId,
      subchapterId,
      quizType,
      quizSubmission, // array of question objects
      score,
      totalQuestions,
      attemptNumber,           // new field
      timestamp: new Date(),
    });

    return res.status(200).json({
      message: "Quiz submission saved successfully",
      docId: docRef.id
    });
  } catch (error) {
    console.error("Error saving quiz submission:", error);
    return res.status(500).json({ error: "Failed to save quiz submission" });
  }
});


// GET /api/getQuiz
app.get("/api/getQuiz", async (req, res) => {
  try {
    const { userId, subchapterId, quizType } = req.query;
    if (!userId || !subchapterId || !quizType) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    // Log the incoming query params
    console.log("GET /api/getQuiz => userId:", userId,
                "subchapterId:", subchapterId,
                "quizType:", quizType);

    const db = admin.firestore();

    // Firestore query
    const snapshot = await db
      .collection("quizzes_demo")
      .where("userId", "==", userId)
      .where("subchapterId", "==", subchapterId)
      .where("quizType", "==", quizType)
      .orderBy("attemptNumber", "desc") // or by timestamp if you prefer
      .get();

    // Log the number of docs returned
    console.log("GET /api/getQuiz => snapshot size:", snapshot.size);

    // Optional: log each doc
    snapshot.forEach((doc) => {
      console.log("Doc ID:", doc.id, "=>", doc.data());
    });

    if (snapshot.empty) {
      // No docs found
      return res.json({ attempts: [] });
    }

    // Build an array of attempt docs
    const attempts = snapshot.docs.map((doc) => {
      const data = doc.data();
      return {
        docId: doc.id,
        userId: data.userId,
        subchapterId: data.subchapterId,
        quizType: data.quizType,
        quizSubmission: data.quizSubmission,
        score: data.score,
        totalQuestions: data.totalQuestions,
        attemptNumber: data.attemptNumber,
        timestamp: data.timestamp,
      };
    });

    // Return to front end
    return res.json({ attempts });
  } catch (error) {
    console.error("Error fetching quiz attempts:", error);
    return res.status(500).json({ error: "Failed to fetch quiz attempts" });
  }
});


app.post("/api/submitRevision", async (req, res) => {
  try {
    const {
      userId,
      subchapterId,
      revisionType,
      revisionNumber,
    } = req.body;

    if (!userId || !subchapterId || !revisionType || !revisionNumber) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const db = admin.firestore();

    // We'll store the record in "revisions_demo"
    // Use an auto-generated doc ID (or define your own).
    const docRef = await db.collection("revisions_demo").add({
      userId,
      subchapterId,
      revisionType,   // e.g. "analyze"
      revisionNumber, // e.g. 1, 2, etc.
      timestamp: new Date(),
    });

    return res.status(200).json({
      message: "Revision record saved successfully",
      docId: docRef.id
    });
  } catch (error) {
    console.error("Error saving revision record:", error);
    return res.status(500).json({ error: "Failed to save revision record" });
  }
});


app.get("/api/getRevisions", async (req, res) => {
  try {
    const { userId, subchapterId, revisionType } = req.query;
    if (!userId || !subchapterId || !revisionType) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const db = admin.firestore();

    // orderBy("revisionNumber", "desc") or by timestamp
    const snapshot = await db.collection("revisions_demo")
      .where("userId", "==", userId)
      .where("subchapterId", "==", subchapterId)
      .where("revisionType", "==", revisionType)
      .orderBy("revisionNumber", "desc")
      .get();

    if (snapshot.empty) {
      return res.json({ revisions: [] });
    }

    const revisions = snapshot.docs.map(doc => {
      const data = doc.data();
      return {
        docId: doc.id,
        userId: data.userId,
        subchapterId: data.subchapterId,
        revisionType: data.revisionType,
        revisionNumber: data.revisionNumber,
        timestamp: data.timestamp,
      };
    });

    return res.json({ revisions });
  } catch (error) {
    console.error("Error fetching revisions:", error);
    return res.status(500).json({ error: "Failed to fetch revisions" });
  }
});

*/

////////////////////////////////////////////////////////////////////////
// GET /api/exam-config
//  Returns an exam config document for a given examId
//  If examId is empty or "general," we fallback to "general" doc
////////////////////////////////////////////////////////////////////////
app.get("/api/exam-config", async (req, res) => {
  try {
    const { examId } = req.query;
    // Default examId to "general" if empty
    const effectiveExamId = examId && examId.trim() ? examId : "general";

    const db = admin.firestore();
    const docRef = db.collection("examConfigs").doc(effectiveExamId);
    const snap = await docRef.get();

    if (!snap.exists) {
      return res.status(404).json({
        error: `No exam config found for examId='${effectiveExamId}'.`
      });
    }

    const data = snap.data() || {};
    // data might have { stages: [...], planTypes: {...}, ... }

    // Return just what's needed on the front end.
    // Usually, the front end only needs "stages", but you can return the entire doc if you prefer.
    return res.json({
      examId: effectiveExamId,
      stages: data.stages || [],
      planTypes: data.planTypes || {}
      // add other fields if needed
    });
  } catch (error) {
    console.error("Error in /api/exam-config:", error);
    return res.status(500).json({ error: error.message });
  }
});




/**
 * /api/generate
 * 
 * 1) Fetches a "prompt" doc from Firestore (by promptKey).
 * 2) Fetches user "activities" + subchapter summary.
 * 3) Combines them into a 'finalPrompt'.
 * 4) Calls OpenAI with the new "chat.completions.create" method (v4.x).
 * 5) Returns GPT's JSON result (plus UIconfig).
 */

app.post("/api/generate", async (req, res) => {
  try {
    const { userId, subchapterId, promptKey } = req.body;
    if (!userId || !subchapterId || !promptKey) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    // Firestore ref
    const db = admin.firestore();

    // 1) Fetch the prompt doc
    const promptSnapshot = await db
      .collection("prompts")
      .where("promptKey", "==", promptKey)
      .limit(1)
      .get();

    let promptText = "";
    let UIconfig = {};

    if (!promptSnapshot.empty) {
      const promptDoc = promptSnapshot.docs[0];
      const promptData = promptDoc.data();
      promptText = promptData.promptText || "";
      UIconfig = promptData.UIconfig || {};
    } else {
      console.warn(`No prompt document found for promptKey: ${promptKey}`);
      // We can proceed, but GPT won't have any instructions
    }

    // 2) Fetch user activities
    const activitiesSnapshot = await db
      .collection("user_activities_demo")
      .where("userId", "==", userId)
      .where("subChapterId", "==", subchapterId)  // or subchapterId if your DB uses that
      .orderBy("timestamp", "desc")
      .get();

    let activitiesText = "";
    activitiesSnapshot.forEach((doc) => {
      const data = doc.data();
      const activityText = data.content || data.eventType || "";
      if (activityText) {
        activitiesText += activityText + "\n";
      }
    });

    // 3) Fetch subchapter summary
    const subChapterDoc = await db
      .collection("subchapters_demo")
      .doc(subchapterId)
      .get();

    let subChapterSummary = "";
    if (subChapterDoc.exists) {
      const subChData = subChapterDoc.data();
      subChapterSummary = subChData.summary || "";
    } else {
      console.warn(`No subchapter document found for subchapterId: ${subchapterId}`);
    }

    // 4) Build final prompt
    const finalPrompt = `
Subchapter Summary:
${subChapterSummary}

User Activities:
${activitiesText}

Instructions:
${promptText}
`.trim();

    console.log("Calling GPT with finalPrompt:", finalPrompt);

    // 5) Call the new OpenAI Chat endpoint (v4.x style)
    //    Make sure you have: npm install openai@latest 
    //    and have done:
    //      const { Configuration, OpenAIApi } = require("openai");
    //      const configuration = new Configuration({ apiKey: ... });
    //      const openai = new OpenAIApi(configuration);
    const openaiResponse = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",   // or "gpt-4"
      messages: [{ role: "user", content: finalPrompt }],
      max_tokens: 1000,
      temperature: 0.7,
    });
    console.log("Raw openaiResponse:", openaiResponse);

    // Extract GPT's text
    const result = openaiResponse.choices[0].message.content.trim();
    console.log("OpenAI result:", result);

    // 6) Return finalPrompt, GPT result, UI config
    return res.json({
      finalPrompt,
      result,
      UIconfig,
    });

  } catch (error) {
    console.error("Error in /api/generate:", error);
    return res.status(500).json({ error: "Failed to generate quiz" });
  }
});



// -------------- /api/submitRevision --------------
app.post("/api/submitRevision", async (req, res) => {
  console.log("=== /api/submitRevision Request Body ===", req.body);

  try {
    const { userId, subchapterId, revisionType, revisionNumber, planId } = req.body;
    console.log("Parsed fields =>", { userId, subchapterId, revisionType, revisionNumber, planId });

    if (!userId || !subchapterId || !revisionType || !revisionNumber) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const db = admin.firestore();
    const docRef = await db.collection("revisions_demo").add({
      userId,
      subchapterId,
      revisionType,
      revisionNumber,
      planId: planId ?? null,  // store planId if present
      timestamp: new Date(),
    });

    return res.status(200).json({
      message: "Revision record saved successfully",
      docId: docRef.id
    });
  } catch (error) {
    console.error("Error in /api/submitRevision:", error);
    return res.status(500).json({ error: "Failed to save revision record" });
  }
});

// -------------- /api/getRevisions --------------
app.get("/api/getRevisions", async (req, res) => {
  try {
    const { userId, subchapterId, revisionType, planId } = req.query;

    // Make them all mandatory
    if (!userId || !subchapterId || !revisionType || !planId) {
      return res.status(400).json({
        error: "Missing required fields: userId, subchapterId, revisionType, planId"
      });
    }

    const db = admin.firestore();
    let ref = db
      .collection("revisions_demo")
      .where("userId", "==", userId)
      .where("subchapterId", "==", subchapterId)
      .where("revisionType", "==", revisionType)
      .where("planId", "==", planId); // mandatory

    ref = ref.orderBy("revisionNumber", "desc");

    const snapshot = await ref.get();

    if (snapshot.empty) {
      return res.json({ revisions: [] });
    }

    const revisions = snapshot.docs.map((doc) => {
      const data = doc.data();
      return {
        docId: doc.id,
        userId: data.userId,
        subchapterId: data.subchapterId,
        revisionType: data.revisionType,
        revisionNumber: data.revisionNumber,
        planId: data.planId,  // just to confirm we see it
        timestamp: data.timestamp,
      };
    });

    return res.json({ revisions });
  } catch (error) {
    console.error("Error in /api/getRevisions:", error);
    return res.status(500).json({ error: "Failed to fetch revisions" });
  }
});

/*

app.post("/api/generateQuiz", async (req, res) => {
  try {
    const { subChapterId, questionType, numberOfQuestions } = req.body;
    // Pull from Firestore => subchapter summary, question type doc
    // Build a GPT prompt => call OpenAI
    // Return JSON with "questions"
    // (Essentially the same steps as in QuizQuestionGenerator, 
    //  but done on the backend to hide the OpenAI key.)
    res.json({ success: true, questions: [...] });
  } catch (error) {
    console.error("Error in /api/generateQuiz:", error);
    res.status(500).json({ error: "Failed to generate quiz" });
  }
});

*/

// For storing a completed quiz attempt:
app.post("/api/submitQuiz", async (req, res) => {
  // 1) Log the entire request body right away
  console.log("=== /api/submitQuiz Request Body ===", req.body);

  try {
    // 2) Destructure the fields, then log them
    const {
      userId,
      subchapterId,
      quizType,
      quizSubmission,
      score,
      totalQuestions,
      attemptNumber,
      planId // <-- accept it
    } = req.body;

    console.log("[submitQuiz] Parsed fields =>", {
      userId,
      subchapterId,
      quizType,
      quizSubmission,
      score,
      totalQuestions,
      attemptNumber,
      planId
    });

    // 3) Basic validation
    if (!userId || !subchapterId || !quizType) {
      console.error("[submitQuiz] Missing required fields =>", {
        userId,
        subchapterId,
        quizType
      });
      return res.status(400).json({ error: "Missing required fields" });
    }

    // 4) About to write to Firestore
    console.log("[submitQuiz] About to write doc in 'quizzes_demo' collection...");
    const db = admin.firestore();

    const docRef = await db.collection("quizzes_demo").add({
      userId,
      subchapterId,
      quizType,
      quizSubmission,
      score,
      totalQuestions,
      attemptNumber,
      planId: planId ?? null, // store planId or null
      timestamp: new Date(),
    });

    console.log("[submitQuiz] Quiz submission doc created with ID:", docRef.id);

    // 5) Return success
    return res.status(200).json({
      message: "Quiz submission saved successfully",
      docId: docRef.id,
    });

  } catch (error) {
    // 6) Log the entire error object or stack trace
    console.error("Error in /api/submitQuiz:", error);
    return res.status(500).json({ error: "Failed to save quiz submission" });
  }
});

// For retrieving quiz attempts:
app.get("/api/getQuiz", async (req, res) => {
  try {
    const { userId, subchapterId, quizType, planId } = req.query;

    // Make them all mandatory
    if (!userId || !subchapterId || !quizType || !planId) {
      return res.status(400).json({
        error: "Missing required fields: userId, subchapterId, quizType, planId"
      });
    }

    const db = admin.firestore();
    let ref = db
      .collection("quizzes_demo")
      .where("userId", "==", userId)
      .where("subchapterId", "==", subchapterId)
      .where("quizType", "==", quizType)
      .where("planId", "==", planId);  // mandatory

    ref = ref.orderBy("attemptNumber", "desc");

    const snapshot = await ref.get();

    if (snapshot.empty) {
      return res.json({ attempts: [] });
    }

    const attempts = snapshot.docs.map((d) => ({
      docId: d.id,
      ...d.data(),
    }));
    return res.json({ attempts });
  } catch (error) {
    console.error("Error in /api/getQuiz:", error);
    res.status(500).json({ error: "Failed to fetch quiz attempts" });
  }
});

// =======================================
// ROUTE CATEGORY: SUBCHAPTER CONCEPTS
// =======================================

app.get("/api/getSubchapterConcepts", async (req, res) => {
  try {
    // 1) Grab subchapterId from query params
    const { subchapterId } = req.query;
    if (!subchapterId) {
      return res.status(400).json({ error: "Missing subchapterId query param" });
    }

    // 2) Firestore query:
    //    db.collection("subchapterConcepts").where("subChapterId", "==", subchapterId)
    const conceptsRef = db.collection("subchapterConcepts");
    const snapshot = await conceptsRef.where("subChapterId", "==", subchapterId).get();

    if (snapshot.empty) {
      // If no matching documents, just return an empty array
      return res.json({ concepts: [] });
    }

    // 3) Map each doc into a plain object
    const concepts = [];
    snapshot.forEach((docSnap) => {
      concepts.push({
        id: docSnap.id,
        ...docSnap.data(),
      });
    });

    // 4) Return them
    res.json({ concepts });
  } catch (err) {
    console.error("Error fetching subchapter concepts:", err);
    res.status(500).json({ error: err.message });
  }
});



app.post("/api/submitReading", async (req, res) => {
  console.log("=== /api/submitReading Request Body ===", req.body);

  try {
    const {
      userId,
      subChapterId,
      readingStartTime,
      readingEndTime,
      productReadingPerformance,
      planId,
      timestamp,
    } = req.body;

    // Basic validation
    if (!userId || !subChapterId || !readingStartTime || !readingEndTime) {
      return res.status(400).json({
        success: false,
        error: "Missing required fields: userId, subChapterId, readingStartTime, readingEndTime",
      });
    }

    const db = admin.firestore();

    // Create a doc in "reading_demo" (or any name you prefer)
    const docRef = await db.collection("reading_demo").add({
      userId,
      subChapterId,
      readingStartTime: new Date(readingStartTime),
      readingEndTime: new Date(readingEndTime),
      productReadingPerformance: productReadingPerformance ?? null,
      planId: planId ?? null,
      timestamp: timestamp ? new Date(timestamp) : new Date(), // fallback to "now"
    });

    return res.status(200).json({
      success: true,
      docId: docRef.id,
      message: "Reading record saved successfully",
    });
  } catch (error) {
    console.error("Error in /api/submitReading:", error);
    return res.status(500).json({
      success: false,
      error: "Failed to save reading record",
    });
  }
});


const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
