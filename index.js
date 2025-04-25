require("dotenv").config();

// --- PDF-slicer stack -------------
const multer        = require("multer");


const sharp              = require("sharp");
const { parse: csvParse} = require("csv-parse/sync");
const fsp                = require("node:fs/promises");
const fs                 = require("node:fs");
const path               = require("node:path");
const { tmpdir }         = require("node:os");
const { promisify }      = require("node:util");
const { execFile }       = require("node:child_process");
const execFileP          = promisify(execFile);




const pdfjsLib        = require('pdfjs-dist/legacy/build/pdf.js');




const { v4: uuidv4 } = require("uuid");
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const admin = require("firebase-admin");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const app = express();

app.use("/slices", express.static(path.join(__dirname, "public", "slices")));


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
    const { userId, subchapterId, revisionType, revisionNumber, planId, activityId } = req.body;
    console.log("Parsed fields =>", { userId, subchapterId, revisionType, revisionNumber, planId });

    if (!userId || !subchapterId || !revisionType || !revisionNumber) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const db = admin.firestore();
    const docRef = await db.collection("revisions_demo").add({
      userId,
      activityId,
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
      activityId,
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
      activityId,
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
      activityId,
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
      activityId,
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
      activityId,
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




app.post("/api/incrementTime", async (req, res) => {
  try {
    const { userId, planId, increment } = req.body;
    if (!userId || !planId || typeof increment !== "number") {
      return res.status(400).json({ error: "Missing or invalid fields" });
    }

    // For daily records, build docId with today's date => "userId_planId_YYYY-MM-DD"
    const dateStr = new Date().toISOString().substring(0, 10);
    const docId = `${userId}_${planId}_${dateStr}`;
    const docRef = db.collection("dailyTimeRecords").doc(docId);

    let newTotal;
    await db.runTransaction(async (t) => {
      const snap = await t.get(docRef);
      const current = snap.exists ? snap.data().totalSeconds || 0 : 0;
      newTotal = current + increment;

      // Update the parent doc with new total
      t.set(docRef, {
        userId,
        planId,
        dateStr,
        totalSeconds: newTotal,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
    });

    // Also log the increment in a sub-collection
    const incrementsRef = docRef.collection("increments");
    await incrementsRef.add({
      increment,
      newTotal,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
    });

    return res.json({ newTotalSeconds: newTotal });
  } catch (err) {
    console.error("Error in incrementTime:", err);
    res.status(500).json({ error: "Server error" });
  }
});


// GET /api/dailyTime?userId=abc&planId=xyz
// returns { totalSeconds: number }

app.get("/api/dailyTime", async (req, res) => {
  try {
    const { userId, planId } = req.query;
    if (!userId || !planId) {
      return res.status(400).json({ error: "Missing userId or planId" });
    }

    // docId => e.g. "abc_xyz_2023-08-05"
    const dateStr = new Date().toISOString().substring(0, 10);
    const docId = `${userId}_${planId}_${dateStr}`;
    const docRef = db.collection("dailyTimeRecords").doc(docId);

    const docSnap = await docRef.get();
    const totalSeconds = docSnap.exists ? (docSnap.data().totalSeconds || 0) : 0;

    res.json({ totalSeconds });
  } catch (err) {
    console.error("Error in /api/dailyTime:", err);
    res.status(500).json({ error: "Server error" });
  }
});




// index.js partial (server)
app.get("/api/getReadingTime", async (req, res) => {
  try {
    const { userId, planId, subChapterId } = req.query;
    if (!userId || !planId || !subChapterId) {
      return res.status(400).json({ error: "Missing userId, planId, or subChapterId" });
    }
    const dateStr = new Date().toISOString().substring(0, 10);
    const docId = `${userId}_${planId}_${subChapterId}_${dateStr}`;
    const docRef = db.collection("readingSubActivity").doc(docId);

    const snap = await docRef.get();
    let totalSeconds = 0;
    if (snap.exists) {
      totalSeconds = snap.data().totalSeconds || 0;
    }
    res.json({ totalSeconds });
  } catch (err) {
    console.error("Error in /api/getReadingTime:", err);
    res.status(500).json({ error: "Server error" });
  }
});

app.post("/api/incrementReadingTime", async (req, res) => {
  try {
    const { userId, planId, subChapterId, increment, activityId } = req.body;
    if (!userId || !planId || !subChapterId || typeof increment !== "number") {
      return res.status(400).json({ error: "Missing or invalid fields" });
    }

    const dateStr = new Date().toISOString().substring(0, 10);
    const docId = `${userId}_${planId}_${subChapterId}_${dateStr}`;
    const docRef = db.collection("readingSubActivity").doc(docId);

    let newTotal;
    await db.runTransaction(async (t) => {
      const snap = await t.get(docRef);
      const current = snap.exists ? snap.data().totalSeconds || 0 : 0;
      newTotal = current + increment;

      t.set(
        docRef,
        {
          userId,
          activityId,
          planId,
          subChapterId,
          dateStr,
          totalSeconds: newTotal,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    });

    res.json({ newTotalSeconds: newTotal });
  } catch (err) {
    console.error("Error in incrementReadingTime:", err);
    res.status(500).json({ error: "Server error" });
  }
});


// Example: QuizTime routes
// GET /api/getQuizTime => read doc from "quizTimeSubActivity" collection
// POST /api/incrementQuizTime => increment doc total

app.get("/api/getQuizTime", async (req, res) => {
  try {
    const { docId } = req.query;
    if (!docId) {
      return res.status(400).json({ error: "Missing docId" });
    }

    const docRef = db.collection("quizTimeSubActivity").doc(docId);
    const snap = await docRef.get();
    let totalSeconds = 0;
    if (snap.exists) {
      totalSeconds = snap.data().totalSeconds || 0;
    }

    res.json({ totalSeconds });
  } catch (err) {
    console.error("Error in /api/getQuizTime:", err);
    res.status(500).json({ error: "Server error" });
  }
});


// In your Express server code:
// In your Express server code:
app.post("/api/incrementQuizTime", async (req, res) => {
  try {
    const {
      docId,
      activityId,
      increment,
      userId,
      planId,
      subChapterId,
      quizStage,
      dateStr,
      attemptNumber,  // <-- NEW
    } = req.body;

    // Validate
    if (!docId || typeof increment !== "number") {
      return res
        .status(400)
        .json({ error: "Missing or invalid docId/increment" });
    }
    if (!userId || !planId) {
      return res.status(400).json({ error: "Missing userId or planId" });
    }

    const docRef = db.collection("quizTimeSubActivity").doc(docId);

    let newTotal;
    await db.runTransaction(async (t) => {
      const snap = await t.get(docRef);
      const current = snap.exists ? snap.data().totalSeconds || 0 : 0;
      newTotal = current + increment;

      // Merge in all fields for normal Firestore queries
      t.set(
        docRef,
        {
          userId,
          activityId,
          planId,
          subChapterId: subChapterId || "",
          quizStage: quizStage || "",
          dateStr: dateStr || "",
          attemptNumber: attemptNumber || null, // <-- store attemptNumber
          totalSeconds: newTotal,
          updatedAt: new Date(),
        },
        { merge: true }
      );
    });

    res.json({ newTotalSeconds: newTotal });
  } catch (err) {
    console.error("Error in /api/incrementQuizTime:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// Example: RevisionTime routes
// GET /api/getReviseTime => read doc from "reviseTimeSubActivity" collection
// POST /api/incrementReviseTime => increment doc total

app.get("/api/getReviseTime", async (req, res) => {
  try {
    const { docId } = req.query;
    if (!docId) {
      return res.status(400).json({ error: "Missing docId" });
    }

    const docRef = db.collection("reviseTimeSubActivity").doc(docId);
    const snap = await docRef.get();
    let totalSeconds = 0;
    if (snap.exists) {
      totalSeconds = snap.data().totalSeconds || 0;
    }

    res.json({ totalSeconds });
  } catch (err) {
    console.error("Error in /api/getReviseTime:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// In your Express server code:
// In your Express server code:
app.post("/api/incrementReviseTime", async (req, res) => {
  try {
    const {
      docId,
      activityId,
      increment,
      userId,
      planId,
      subChapterId,
      quizStage,
      dateStr,
      revisionNumber // <-- NEW
    } = req.body;

    // Validate
    if (!docId || typeof increment !== "number") {
      return res.status(400).json({ error: "Missing or invalid docId/increment" });
    }
    if (!userId || !planId) {
      return res.status(400).json({ error: "Missing userId or planId" });
    }

    const docRef = db.collection("reviseTimeSubActivity").doc(docId);

    let newTotal;
    await db.runTransaction(async (t) => {
      const snap = await t.get(docRef);
      const current = snap.exists ? snap.data().totalSeconds || 0 : 0;
      newTotal = current + increment;

      // Merge in all fields (including revisionNumber)
      t.set(docRef, {
        userId,
        activityId,
        planId,
        subChapterId: subChapterId || "",
        quizStage: quizStage || "",
        dateStr: dateStr || "",
        revisionNumber: revisionNumber || 1, // Store attempt # for revision
        totalSeconds: newTotal,
        updatedAt: new Date()
      }, { merge: true });
    });

    res.json({ newTotalSeconds: newTotal });
  } catch (err) {
    console.error("Error in /api/incrementReviseTime:", err);
    res.status(500).json({ error: "Server error" });
  }
});


app.get("/api/cumulativeReadingTime", async (req, res) => {
  try {
    const { userId, planId, subChapterId } = req.query;

    // Basic validation
    if (!userId || !planId || !subChapterId) {
      return res.status(400).json({
        error: "Missing userId, planId, or subChapterId",
      });
    }

    // Firestore query => all docs in readingSubActivity that match
    const colRef = db.collection("readingSubActivity");
    const q = colRef
      .where("userId", "==", userId)
      .where("planId", "==", planId)
      .where("subChapterId", "==", subChapterId);

    const snap = await q.get();

    // Sum over all matching docs
    let totalSeconds = 0;
    snap.forEach((docSnap) => {
      const data = docSnap.data();
      totalSeconds += data.totalSeconds || 0;
    });

    res.json({ totalSeconds });
  } catch (err) {
    console.error("Error in /api/cumulativeReadingTime:", err);
    res.status(500).json({ error: "Server error" });
  }
});


app.get("/api/cumulativeQuizTime", async (req, res) => {
  try {
    const { userId, planId, subChapterId, quizStage } = req.query;

    // Basic validation
    if (!userId || !planId || !subChapterId || !quizStage) {
      return res.status(400).json({
        error: "Missing userId, planId, subChapterId, or quizStage",
      });
    }

    // Query => quizTimeSubActivity
    const colRef = db.collection("quizTimeSubActivity");
    const q = colRef
      .where("userId", "==", userId)
      .where("planId", "==", planId)
      .where("subChapterId", "==", subChapterId)
      .where("quizStage", "==", quizStage); // must match case-sensitively

    const snap = await q.get();

    let totalSeconds = 0;
    snap.forEach((docSnap) => {
      const data = docSnap.data();
      totalSeconds += data.totalSeconds || 0;
    });

    res.json({ totalSeconds });
  } catch (err) {
    console.error("Error in /api/cumulativeQuizTime:", err);
    res.status(500).json({ error: "Server error" });
  }
});


app.get("/api/cumulativeReviseTime", async (req, res) => {
  try {
    const { userId, planId, subChapterId, quizStage } = req.query;

    if (!userId || !planId || !subChapterId || !quizStage) {
      return res.status(400).json({
        error: "Missing userId, planId, subChapterId, or quizStage",
      });
    }

    // Query => reviseTimeSubActivity
    const colRef = db.collection("reviseTimeSubActivity");
    const q = colRef
      .where("userId", "==", userId)
      .where("planId", "==", planId)
      .where("subChapterId", "==", subChapterId)
      .where("quizStage", "==", quizStage);

    const snap = await q.get();

    let totalSeconds = 0;
    snap.forEach((docSnap) => {
      const data = docSnap.data();
      totalSeconds += data.totalSeconds || 0;
    });

    res.json({ totalSeconds });
  } catch (err) {
    console.error("Error in /api/cumulativeReviseTime:", err);
    res.status(500).json({ error: "Server error" });
  }
});


// Matches your “cloud aggregator” QUIZ_STAGES

// =============================
// File: index.js (or wherever your /subchapter-status is defined)
// =============================


const QUIZ_STAGES = ["remember", "understand", "apply", "analyze"];



// File: subchapter-status.js (or wherever your Express route is defined)

// 1) The /subchapter-status endpoint
app.get("/subchapter-status", async (req, res) => {
  try {
    // 1) Parse query
    const { userId, planId, subchapterId } = req.query;
    console.log("[/subchapter-status] Incoming params =>", { userId, planId, subchapterId });

    if (!userId || !planId || !subchapterId) {
      console.log("[/subchapter-status] Missing params => returning 400");
      return res.status(400).json({ error: "Missing userId, planId, or subchapterId" });
    }

    // 2) readingStats => merges reading_demo + readingSubActivity lumps
    console.log("[/subchapter-status] calling buildReadingStatsSingle...");
    const readingStatsMap = await buildReadingStatsSingle(userId, planId);
    console.log("[/subchapter-status] readingStatsMap =>", readingStatsMap);

    // If this subchapter isn’t in readingStatsMap => not-started
    const readingObj = readingStatsMap[subchapterId] || null;
    console.log("[/subchapter-status] readingObj for subChapterId:", subchapterId, "=>", readingObj);

    const readingSummary = buildReadingSummary(readingObj);
    console.log("[/subchapter-status] readingSummary =>", readingSummary);

    // 3) For each QUIZ_STAGE => gather aggregator data + status
    const quizStagesData = {};    // FULL aggregator object (quizAttempts, revisionAttempts, etc.)
    const quizStagesStatus = {};  // PARTIAL status => { overall, masteryPct, etc. }

    console.log("[/subchapter-status] building quizStages for QUIZ_STAGES =>", QUIZ_STAGES);

    for (const stage of QUIZ_STAGES) {
      console.log(`[/subchapter-status] gathering stageData for stage=${stage}`);
      const stageData = await gatherStageDataSingle(userId, planId, subchapterId, stage);
      console.log(`[/subchapter-status] stageData =>`, stageData);

      const stageStatus = getStageStatus(stageData);
      console.log(`[/subchapter-status] stageStatus => '${stage}':`, stageStatus);

      // Store them
      quizStagesData[stage]   = stageData;   // the raw aggregator details
      quizStagesStatus[stage] = stageStatus; // simplified "overall", "masteryPct", etc.
    }
    console.log("[/subchapter-status] final quizStagesStatus =>", quizStagesStatus);

    // 4) Combine reading + quiz => locked/unlocked logic + next tasks
    console.log("[/subchapter-status] calling buildTaskInfoV2...");
    const taskInfo = buildTaskInfoV2(readingSummary, quizStagesData, quizStagesStatus);
    console.log("[/subchapter-status] final taskInfo =>", taskInfo);

    // 5) FETCH CONCEPTS for subchapter
    console.log("[/subchapter-status] fetching subchapterConcepts => subChId=", subchapterId);
    const conceptSnap = await db
      .collection("subchapterConcepts")
      .where("subChapterId", "==", subchapterId)
      .get();

    const concepts = [];
    conceptSnap.forEach((docSnap) => {
      concepts.push({
        id: docSnap.id,
        ...docSnap.data(),
      });
    });
    console.log("[/subchapter-status] found concepts =>", concepts.map(c=>c.id));

    // 6) Return final => now also returning quizStagesData + concepts
    console.log("[/subchapter-status] returning success => subchapterId:", subchapterId);
    return res.json({
      userId,
      planId,
      subchapterId,
      readingSummary,            // e.g. { overall: "done", timeSpent, completionDate }
      quizStages: quizStagesStatus, 
      quizStagesData,            // raw aggregator data for each stage
      taskInfo,                  // e.g. array for Reading/Remember/Understand/Apply/Analyze
      concepts,                  // <--- new array of subchapterConcepts
    });
  } catch (err) {
    console.error("[/subchapter-status] error =>", err);
    res.status(500).json({ error: err.message });
  }
});

// 2) The gatherStageDataSingle function
async function gatherStageDataSingle(userId, planId, subChId, stage) {
  console.log("[gatherStageDataSingle] userId =", userId, 
              "planId =", planId, 
              "subChId =", subChId, 
              "stage =", stage);

  const dbRef = admin.firestore();

  // 1) Quizzes
  console.log("[gatherStageDataSingle] => Querying 'quizzes_demo'...");
  const quizSnap = await dbRef
    .collection("quizzes_demo")
    .where("userId", "==", userId)
    .where("planId", "==", planId)
    .where("subchapterId", "==", subChId)
    .where("quizType", "==", stage)
    .get();
  console.log("[gatherStageDataSingle] quizSnap.size =", quizSnap.size);

  const quizAttempts = [];
  quizSnap.forEach((docSnap) => {
    const d = docSnap.data();
    console.log("[gatherStageDataSingle] quiz doc =>", docSnap.id, d);
    quizAttempts.push({
      attemptNumber: d.attemptNumber || 1,
      score: d.score || 0,
      quizSubmission: d.quizSubmission || [],
      timestamp: d.timestamp || null,          // <-- ensure we carry over the doc's timestamp
      type: "quiz",                            // <-- add 'type' so front-end sees "quiz"
    });
  });

  // 2) Revisions
  console.log("[gatherStageDataSingle] => Querying 'revisions_demo'...");
  const revSnap = await dbRef
    .collection("revisions_demo")
    .where("userId", "==", userId)
    .where("planId", "==", planId)
    .where("subchapterId", "==", subChId)
    .where("revisionType", "==", stage)
    .get();
  console.log("[gatherStageDataSingle] revSnap.size =", revSnap.size);

  const revisionAttempts = [];
  revSnap.forEach((docSnap) => {
    const d = docSnap.data();
    console.log("[gatherStageDataSingle] revision doc =>", docSnap.id, d);
    revisionAttempts.push({
      revisionNumber: d.revisionNumber || 1,
      timestamp: d.timestamp || null,          // <-- carry over revision doc's timestamp
      type: "revision",                        // <-- add 'type' so front-end sees "revision"
    });
  });

  // 3) lumps => quizTimeSubActivity + reviseTimeSubActivity
  let totalSeconds = 0;

  // quizTimeSubActivity
  console.log("[gatherStageDataSingle] => Querying 'quizTimeSubActivity'...");
  const quizTimeSnap = await dbRef
    .collection("quizTimeSubActivity")
    .where("userId", "==", userId)
    .where("planId", "==", planId)
    .where("subChapterId", "==", subChId)
    .where("quizStage", "==", stage)
    .get();
  console.log("[gatherStageDataSingle] quizTimeSnap.size =", quizTimeSnap.size);

  quizTimeSnap.forEach((docSnap) => {
    const docData = docSnap.data();
    console.log("[gatherStageDataSingle] quizTime doc =>", docSnap.id, docData);
    totalSeconds += docData.totalSeconds || 0;
  });

  // reviseTimeSubActivity
  console.log("[gatherStageDataSingle] => Querying 'reviseTimeSubActivity'...");
  const reviseTimeSnap = await dbRef
    .collection("reviseTimeSubActivity")
    .where("userId", "==", userId)
    .where("planId", "==", planId)
    .where("subChapterId", "==", subChId)
    .where("quizStage", "==", stage)
    .get();
  console.log("[gatherStageDataSingle] reviseTimeSnap.size =", reviseTimeSnap.size);

  reviseTimeSnap.forEach((docSnap) => {
    const docData = docSnap.data();
    console.log("[gatherStageDataSingle] reviseTime doc =>", docSnap.id, docData);
    totalSeconds += docData.totalSeconds || 0;
  });

  console.log("[gatherStageDataSingle] totalSeconds after lumps =>", totalSeconds);

  // 4) subchapterConcepts => find concept docs for this subchapter
  console.log("[gatherStageDataSingle] => Querying 'subchapterConcepts'...");
  const conceptSnap = await dbRef
    .collection("subchapterConcepts")
    .where("subChapterId", "==", subChId)
    .get();

  console.log("[gatherStageDataSingle] conceptSnap.size =", conceptSnap.size);

  let totalConceptCount = 0;
  const conceptArr = [];
  conceptSnap.forEach((cDoc) => {
    const cData = cDoc.data();
    console.log("[gatherStageDataSingle] concept doc =>", cDoc.id, cData);
    const name = cData.name || "UnnamedConcept";
    conceptArr.push({ name });
  });
  totalConceptCount = conceptArr.length;
  console.log("[gatherStageDataSingle] conceptArr =>", conceptArr, "totalConceptCount =>", totalConceptCount);

  // 5) Build concept stats => same approach as aggregator
  const allAttemptsConceptStats = buildAllAttemptsConceptStats(quizAttempts, conceptArr);
  console.log("[gatherStageDataSingle] allAttemptsConceptStats =>", JSON.stringify(allAttemptsConceptStats, null, 2));

  // Return aggregator-like object
  const result = {
    quizAttempts,
    revisionAttempts,
    totalSeconds,
    totalConceptCount,
    allAttemptsConceptStats,
  };
  console.log("[gatherStageDataSingle] final =>", result);

  return result;
}

async function buildReadingStatsSingle(userId, planId) {
  const result = {};

  // 1) reading_demo => completions
  const readDemoSnap = await admin.firestore()
    .collection("reading_demo")
    .where("userId", "==", userId)
    .where("planId", "==", planId)
    .get();

  // In cloud aggregator you stored “timestamp” or “readingEndTime” for completions.
  // We’ll store them in completionMap
  const completionMap = {};
  readDemoSnap.forEach((docSnap) => {
    const d = docSnap.data();
    const subId = d.subChapterId;
    if (!subId) return;

    // If readingEndTime is your “done” marker
    const endTs = d.readingEndTime || null;
    completionMap[subId] = endTs; // store the timestamp
  });

  // 2) readingSubActivity => lumps of reading time
  const readSubSnap = await admin.firestore()
    .collection("readingSubActivity")
    .where("userId", "==", userId)
    .where("planId", "==", planId)
    .get();

  const timeMap = {};
  readSubSnap.forEach((docSnap) => {
    const d = docSnap.data();
    const scId = d.subChapterId || "";
    if (!timeMap[scId]) timeMap[scId] = 0;
    timeMap[scId] += d.totalSeconds || 0;
  });

  // 3) Merge => produce final
  // For each subCh that has lumps
  Object.keys(timeMap).forEach((scId) => {
    const totalSec = timeMap[scId];
    const totalMin = totalSec / 60;
    const endTs = completionMap[scId] || null; // user might have readingEndTime
    result[scId] = {
      totalTimeSpentMinutes: totalMin,
      completionDate: endTs ? convertToDate(endTs) : null,
    };
  });

  // For subCh that appear in completionMap but no lumps => timeSpent=0
  Object.keys(completionMap).forEach((scId) => {
    if (!result[scId]) {
      const endTs = completionMap[scId];
      result[scId] = {
        totalTimeSpentMinutes: 0,
        completionDate: endTs ? convertToDate(endTs) : null,
      };
    }
  });

  return result;
}

/*********************************************
 * buildReadingSummary
 * => merges totalTimeSpentMinutes + completionDate => overall=done/in-progress
 *********************************************/
function buildReadingSummary(readObj) {
  if (!readObj) {
    return { overall: "not-started", timeSpent: 0, completionDate: null };
  }
  const { totalTimeSpentMinutes, completionDate } = readObj;
  let overall = "not-started";

  if (completionDate) {
    overall = "done";
  } else if ((totalTimeSpentMinutes || 0) > 0) {
    overall = "in-progress";
  }
  return {
    overall,
    timeSpent: totalTimeSpentMinutes || 0,
    completionDate: completionDate || null,
  };
}

/*********************************************
 * getStageStatus (OBJECT-based)
 * => returns { overall: "...", masteryPct: number, timeSpentMinutes: number }
 *********************************************/
function getStageStatus(stageObj) {
  if (!stageObj) {
    return { overall: "not-started", masteryPct: 0, timeSpentMinutes: 0 };
  }
  const totalConcepts = stageObj.totalConceptCount || 0;
  const passCount = computePassCount(stageObj.allAttemptsConceptStats);
  const timeSpentMinutes = (stageObj.totalSeconds || 0) / 60;

  let overall = "not-started";
  let masteryPct = 0;

  if (totalConcepts === 0) {
    // If user has lumps or attempts => "in-progress"
    if (
      stageObj.quizAttempts.length > 0 ||
      stageObj.revisionAttempts.length > 0 ||
      timeSpentMinutes > 0
    ) {
      overall = "in-progress";
    }
  } else {
    // if passCount >= total => done
    masteryPct = (passCount / totalConcepts) * 100;
    if (passCount >= totalConcepts) {
      overall = "done";
    } else if (
      passCount > 0 ||
      stageObj.quizAttempts.length > 0 ||
      stageObj.revisionAttempts.length > 0 ||
      timeSpentMinutes > 0
    ) {
      overall = "in-progress";
    }
  }

  return {
    overall,
    masteryPct,
    timeSpentMinutes,
  };
}

/*********************************************
 * computePassCount(allAttemptsConceptStats)
 * => how many *unique* concepts were passed
 *********************************************/
function computePassCount(allAttemptsConceptStats) {
  if (!Array.isArray(allAttemptsConceptStats)) return 0;
  const passedSet = new Set();
  for (const attempt of allAttemptsConceptStats) {
    for (const cs of attempt.conceptStats || []) {
      if (cs.passOrFail === "PASS") {
        passedSet.add(cs.conceptName);
      }
    }
  }
  return passedSet.size;
}

/*********************************************
 * buildAllAttemptsConceptStats(quizAttempts, conceptArr)
 * => array of { attemptNumber, score, conceptStats }
 *********************************************/
function buildAllAttemptsConceptStats(quizAttempts, conceptArr) {
  // (A) If the subchapter truly has no concepts, return empty
  if (!conceptArr.length) {
    return [];
  }

  // (B) If there are no quiz attempts, create one pseudo "attempt"
  //     marking each concept as NOT_TESTED
  if (!quizAttempts.length) {
    const pseudoStats = conceptArr.map((c) => ({
      conceptName: c.name || `Concept ${c.id || ""}`,
      passOrFail: "NOT_TESTED",
      correct: 0,
      total: 0,
      ratio: 0,
    }));
    return [
      {
        attemptNumber: 0, // or 1 if you prefer
        score: 0,
        conceptStats: pseudoStats,
      },
    ];
  }

  // (C) Otherwise, use the existing logic
  return quizAttempts.map((attempt) => {
    const stats = buildConceptStats(attempt.quizSubmission || [], conceptArr);
    return {
      attemptNumber: attempt.attemptNumber,
      score: attempt.score,
      conceptStats: stats,
    };
  });
}

/*********************************************
 * buildConceptStats(quizSubmission, conceptArr)
 * => merges user’s quizSubmission with known conceptArr
 *********************************************/
function buildConceptStats(quizSubmission, conceptArr) {
  const countMap = {};
  quizSubmission.forEach((q) => {
    const cName = q.conceptName || "UnknownConcept";
    if (!countMap[cName]) {
      countMap[cName] = { correct: 0, total: 0 };
    }
    countMap[cName].total++;
    if (q.score && parseFloat(q.score) >= 1) {
      countMap[cName].correct++;
    }
  });

  const conceptNamesSet = new Set(conceptArr.map((c) => c.name));
  if (countMap["UnknownConcept"]) {
    conceptNamesSet.add("UnknownConcept");
  }

  const statsArray = [];
  conceptNamesSet.forEach((cName) => {
    const rec = countMap[cName] || { correct: 0, total: 0 };
    const ratio = rec.total > 0 ? rec.correct / rec.total : 0;
    let passOrFail = "FAIL";
    if (rec.total === 0) {
      passOrFail = "NOT_TESTED";
    } else if (ratio === 1.0) {
      passOrFail = "PASS";
    }
    statsArray.push({
      conceptName: cName,
      correct: rec.correct,
      total: rec.total,
      ratio,
      passOrFail,
    });
  });
  return statsArray;
}

/*********************************************
 * buildTaskInfoV2
 * => merges reading + quiz stages => locked/unlocked + next tasks
 * Key difference: we pass *both* the raw aggregator data (quizStagesData)
 * and the short status objects (quizStagesStatus).
 *********************************************/
function buildTaskInfoV2(readingSummary, quizStagesData, quizStagesStatus) {
  // locked logic => if reading not done => remember locked, etc.
  const rememberLocked    = (readingSummary.overall !== "done");
  const understandLocked  = (quizStagesStatus.remember.overall    !== "done");
  const applyLocked       = (quizStagesStatus.understand.overall  !== "done");
  const analyzeLocked     = (quizStagesStatus.apply.overall       !== "done");

  // next tasks
  const readingTask    = getReadingTaskInfo(readingSummary);
  const rememberTask   = getQuizStageTaskInfo(quizStagesData.remember, quizStagesStatus.remember);
  const understandTask = getQuizStageTaskInfo(quizStagesData.understand, quizStagesStatus.understand);
  const applyTask      = getQuizStageTaskInfo(quizStagesData.apply, quizStagesStatus.apply);
  const analyzeTask    = getQuizStageTaskInfo(quizStagesData.analyze, quizStagesStatus.analyze);

  // active logic => first not done
  const readingDone      = (readingSummary.overall === "done");
  const rememberDone     = (quizStagesStatus.remember.overall === "done");
  const understandDone   = (quizStagesStatus.understand.overall === "done");
  const applyDone        = (quizStagesStatus.apply.overall === "done");
  const analyzeDone      = (quizStagesStatus.analyze.overall === "done");

  const readingActive    = !readingDone;
  const rememberActive   = readingDone && !rememberDone;
  const understandActive = readingDone && rememberDone && !understandDone;
  const applyActive      = readingDone && rememberDone && understandDone && !applyDone;
  const analyzeActive    = readingDone && rememberDone && understandDone && applyDone && !analyzeDone;

  return [
    {
      stageLabel: "Reading",
      locked: false,
      status: readingSummary.overall,
      nextTaskLabel: readingTask.taskLabel,
      hasTask: readingTask.hasTask,
      isActive: readingActive,
    },
    {
      stageLabel: "Remember",
      locked: rememberLocked,
      status: quizStagesStatus.remember.overall,
      nextTaskLabel: rememberTask.taskLabel,
      hasTask: rememberTask.hasTask,
      isActive: rememberActive,
    },
    {
      stageLabel: "Understand",
      locked: understandLocked,
      status: quizStagesStatus.understand.overall,
      nextTaskLabel: understandTask.taskLabel,
      hasTask: understandTask.hasTask,
      isActive: understandActive,
    },
    {
      stageLabel: "Apply",
      locked: applyLocked,
      status: quizStagesStatus.apply.overall,
      nextTaskLabel: applyTask.taskLabel,
      hasTask: applyTask.hasTask,
      isActive: applyActive,
    },
    {
      stageLabel: "Analyze",
      locked: analyzeLocked,
      status: quizStagesStatus.analyze.overall,
      nextTaskLabel: analyzeTask.taskLabel,
      hasTask: analyzeTask.hasTask,
      isActive: analyzeActive,
    },
  ];
}

/*********************************************
 * getReadingTaskInfo
 *********************************************/
function getReadingTaskInfo(readingSummary) {
  if (readingSummary.overall === "done") {
    return { hasTask: false, taskLabel: "" };
  }
  return { hasTask: true, taskLabel: "READ" };
}

/*********************************************
 * getQuizStageTaskInfo
 * => EXACT logic from "ProgressView":
 *    if last doc is quiz => next => REVISION#
 *    if last doc is revision => next => QUIZ(N+1)
 *********************************************/
function getQuizStageTaskInfo(stageData, stageStatus) {
  if (!stageData) {
    // If we have no aggregator data at all:
    if (stageStatus.overall === "done") {
      return { hasTask: false, taskLabel: "" };
    }
    // else => "QUIZ1"
    return { hasTask: true, taskLabel: "QUIZ1" };
  }
  // If stage is "done" => no next
  if (stageStatus.overall === "done") {
    return { hasTask: false, taskLabel: "" };
  }

  // Combine quiz + revision
  const quizArr = stageData.quizAttempts || [];
  const revArr  = stageData.revisionAttempts || [];
  const combined = [];

  quizArr.forEach((q) => {
    combined.push({
      type: "quiz",
      attemptNumber: q.attemptNumber || 1,
      timestamp: toMillis(q.timestamp),
    });
  });
  revArr.forEach((r) => {
    combined.push({
      type: "revision",
      attemptNumber: r.revisionNumber || 1,
      timestamp: toMillis(r.timestamp),
    });
  });

  // sort => last is most recent
  combined.sort((a, b) => {
    const diff = a.timestamp - b.timestamp;
    if (diff !== 0) return diff;
    return (a.attemptNumber - b.attemptNumber);
  });

  if (!combined.length) {
    // no attempts => QUIZ1
    return { hasTask: true, taskLabel: "QUIZ1" };
  }

  const last = combined[combined.length - 1];
  if (last.type === "quiz") {
    // next => revision for same attempt
    return { hasTask: true, taskLabel: `REVISION${last.attemptNumber}` };
  } else {
    // last.type = "revision"
    return { hasTask: true, taskLabel: `QUIZ${last.attemptNumber + 1}` };
  }
}

/*********************************************
 * convertToDate / toMillis
 *********************************************/
function convertToDate(ts) {
  if (!ts) return null;
  if (typeof ts.toDate === "function") {
    return ts.toDate();
  }
  if (typeof ts.seconds === "number") {
    return new Date(ts.seconds * 1000);
  }
  return null;
}
function toMillis(ts) {
  if (!ts) return 0;
  if (typeof ts.seconds === "number") return ts.seconds * 1000;
  if (typeof ts._seconds === "number") return ts._seconds * 1000;
  if (ts instanceof Date) return ts.getTime();
  return 0;
}


/**
 * POST /api/deferActivity
 * Body: { userId, planId, activityId }
 *
 *  1) Fetch the plan doc from "adaptive_demo" by planId
 *  2) Check planData.userId == userId (for security)
 *  3) Locate the activity => set: activity.deferred = true, activity.deferredTime = new Date().toISOString()
 *  4) Save the doc back
 */
// In your server file (index.js or server.js)
app.post("/api/setCompletionStatus", async (req, res) => {
  try {
    const { userId, planId, activityId, completionStatus } = req.body;
    if (!userId || !planId || !activityId || !completionStatus) {
      return res.status(400).json({
        error: "Missing userId, planId, activityId, or completionStatus.",
      });
    }

    const db = admin.firestore();
    const planRef = db.collection("adaptive_demo").doc(planId);
    const planSnap = await planRef.get();

    if (!planSnap.exists) {
      return res
        .status(404)
        .json({ error: `No plan found with planId='${planId}'` });
    }

    const planData = planSnap.data();
    // Optional security check
    if (planData.userId !== userId) {
      return res
        .status(403)
        .json({ error: "You do not have permission to modify this plan." });
    }

    let found = false;
    if (Array.isArray(planData.sessions)) {
      for (const session of planData.sessions) {
        if (!Array.isArray(session.activities)) continue;
        for (const act of session.activities) {
          if (act.activityId === activityId) {
            // Just set completionStatus
            act.completionStatus = completionStatus;
            // You could also remove older fields like act.deferred or act.deferredTime
            found = true;
            break;
          }
        }
        if (found) break;
      }
    }

    if (!found) {
      return res
        .status(404)
        .json({ error: `Activity '${activityId}' not found in plan.` });
    }

    await planRef.set(planData, { merge: true });

    return res.status(200).json({
      message: `Activity '${activityId}' set to completionStatus='${completionStatus}'`,
      planId,
    });
  } catch (err) {
    console.error("Error in POST /api/setCompletionStatus:", err);
    return res.status(500).json({ error: err.message });
  }
});

// In your expressindex.js or routes file:

// In your Express server file (e.g. expressindex.js)
// Make sure you already did: const admin = require("firebase-admin");
// And that you have admin.initializeApp(...) somewhere at startup

/**
 * POST /api/markActivityCompletion
 * Body: { userId, planId, activityId, completionStatus }
 *
 * If completionStatus="deferred", automatically replicate this activity
 * to the next session (creating a new session if needed).
 */
// File: markActivityCompletion.js (or inline in your Express setup)
app.post("/api/markActivityCompletion", async (req, res) => {
  try {
    const { userId, planId, activityId, completed, replicaIndex } = req.body;

    // 1) Validate input
    //    - 'completed' should be boolean
    if (!userId || !planId || !activityId || typeof completed !== "boolean") {
      return res.status(400).json({
        error: "Missing or invalid fields: userId, planId, activityId, completed(boolean)."
      });
    }

    // 2) Load plan doc from 'adaptive_demo'
    const planRef = db.collection("adaptive_demo").doc(planId);
    const planSnap = await planRef.get();
    if (!planSnap.exists) {
      return res.status(404).json({ error: `No plan found with planId='${planId}'` });
    }

    const planData = planSnap.data();
    if (planData.userId !== userId) {
      return res.status(403).json({
        error: "You do not have permission to modify this plan."
      });
    }
    if (!Array.isArray(planData.sessions)) {
      planData.sessions = [];
    }

    // 3) Find the matching activity => match by activityId AND (replicaIndex or 0)
    const requestedReplica = typeof replicaIndex === "number" ? replicaIndex : 0;

    let foundSessionIndex = -1;
    let foundActivityIndex = -1;

    outerLoop: 
    for (let sIdx = 0; sIdx < planData.sessions.length; sIdx++) {
      const session = planData.sessions[sIdx];
      if (!Array.isArray(session.activities)) continue;

      for (let aIdx = 0; aIdx < session.activities.length; aIdx++) {
        const act = session.activities[aIdx];
        if (act.activityId === activityId) {
          // If 'act.replicaIndex' is missing, treat it like 0
          const actReplica = typeof act.replicaIndex === "number" ? act.replicaIndex : 0;
          if (actReplica === requestedReplica) {
            foundSessionIndex = sIdx;
            foundActivityIndex = aIdx;
            break outerLoop;
          }
        }
      }
    }

    if (foundSessionIndex < 0 || foundActivityIndex < 0) {
      return res.status(404).json({
        error: `Activity '${activityId}' (replicaIndex=${requestedReplica}) not found in plan '${planId}'.`
      });
    }

    // 4) Set .completed
    planData.sessions[foundSessionIndex].activities[foundActivityIndex].completed = completed;

    // 5) Save updated plan
    await planRef.set(planData, { merge: true });

    // 6) Return success
    return res.status(200).json({
      message: `Activity '${activityId}' (replicaIndex=${requestedReplica}) set completed=${completed}.`,
      planId,
    });
  } catch (err) {
    console.error("Error in POST /api/markActivityCompletion:", err);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/replicateActivity
 * Body: { userId, planId, activityId }
 *
 * Steps:
 *  1) Load plan from "adaptive_demo" by planId
 *  2) Ensure planData.userId == userId
 *  3) Find sessionIndex + activityIndex where activityId matches
 *  4) Make a copy => new activityId => place at start of next session's activities
 *  5) Save doc
 */
app.post("/api/replicateActivity", async (req, res) => {
  try {
    const { userId, planId, activityId } = req.body;
    if (!userId || !planId || !activityId) {
      return res
        .status(400)
        .json({ error: "Missing userId, planId, or activityId." });
    }

    const db = admin.firestore();
    const planRef = db.collection("adaptive_demo").doc(planId);
    const planSnap = await planRef.get();

    if (!planSnap.exists) {
      return res
        .status(404)
        .json({ error: `No plan doc found with planId='${planId}'` });
    }

    const planData = planSnap.data();
    if (planData.userId !== userId) {
      return res.status(403).json({ error: "User does not own this plan." });
    }

    if (!Array.isArray(planData.sessions)) {
      return res.status(400).json({ error: "planData.sessions is not an array." });
    }

    // 1) Find session + activity index
    let foundSessionIndex = -1;
    let foundActivityIndex = -1;

    planData.sessions.forEach((sess, sIdx) => {
      if (!Array.isArray(sess.activities)) return;
      sess.activities.forEach((act, aIdx) => {
        if (act.activityId === activityId) {
          foundSessionIndex = sIdx;
          foundActivityIndex = aIdx;
        }
      });
    });

    if (foundSessionIndex < 0 || foundActivityIndex < 0) {
      return res
        .status(404)
        .json({ error: `Activity '${activityId}' not found in plan.` });
    }

    // 2) If this is the last session => error or create new
    const nextSessionIndex = foundSessionIndex + 1;
    if (nextSessionIndex >= planData.sessions.length) {
      // If you want to create a new session automatically, do so here.
      // For now, let's just return an error:
      return res
        .status(400)
        .json({ error: "No 'next day' to replicate into (this is the last session)." });
    }

    // 3) Make a copy of the activity
    const originalActivity =
      planData.sessions[foundSessionIndex].activities[foundActivityIndex];
    // Deep clone
    const newActivity = JSON.parse(JSON.stringify(originalActivity));
    // Assign a new activityId
    newActivity.activityId = uuidv4();
    // (Optional) remove any fields you don't want copied exactly, e.g.:
    // newActivity.deferred = false;

    // 4) Insert at start (index 0) of next session's activities
    planData.sessions[nextSessionIndex].activities.unshift(newActivity);

    // 5) Save updated doc
    await planRef.set(planData, { merge: true });

    return res.status(200).json({
      message: `Successfully replicated activity '${activityId}' into session index ${nextSessionIndex}.`,
      newActivityId: newActivity.activityId,
    });
  } catch (err) {
    console.error("Error in /api/replicateActivity:", err);
    return res.status(500).json({ error: err.message });
  }
});


app.get("/api/getActivityTime", async (req, res) => {
  try {
    const { activityId, type } = req.query;
    if (!activityId) {
      return res.status(400).json({ error: "Missing activityId" });
    }
    if (!type) {
      return res.status(400).json({ error: "Missing type (read|quiz)" });
    }

    let totalTime = 0;
    let details = []; // array of doc-specific info

    if (type === "read") {
      // 1) readingSubActivity
      const snap = await db
        .collection("readingSubActivity")
        .where("activityId", "==", activityId)
        .get();

      let sum = 0;
      snap.forEach((docSnap) => {
        const docData = docSnap.data();
        const sec = docData.totalSeconds || 0;
        sum += sec;

        // define dateStr from docData if it exists
        const dateStr = docData.dateStr || null;

        details.push({
          docId: docSnap.id,
          collection: "readingSubActivity",
          totalSeconds: sec,
          lumps: docData.lumps || [],   // partial intervals if any
          createdAt: docData.createdAt || null,
          dateStr,
          // NEW FIELDS:
          subChapterId: docData.subChapterId || null,
          // Possibly userId, planId if you want:
          userId: docData.userId || null,
          planId: docData.planId || null,
        });
      });
      totalTime = sum;

    } else if (type === "quiz") {
      // 2) quiz => sum from quizTimeSubActivity + reviseTimeSubActivity
      let quizTimeSum = 0;
      let reviseTimeSum = 0;

      // A) quizTimeSubActivity
      const quizSnap = await db
        .collection("quizTimeSubActivity")
        .where("activityId", "==", activityId)
        .get();

      quizSnap.forEach((docSnap) => {
        const docData = docSnap.data();
        const sec = docData.totalSeconds || 0;
        quizTimeSum += sec;

        const dateStr = docData.dateStr || null;

        details.push({
          docId: docSnap.id,
          collection: "quizTimeSubActivity",
          totalSeconds: sec,
          lumps: docData.lumps || [],
          createdAt: docData.createdAt || null,
          dateStr,
          // NEW FIELDS:
          attemptNumber: docData.attemptNumber || null,
          quizStage: docData.quizStage || null,
          subChapterId: docData.subChapterId || null,
          userId: docData.userId || null,
          planId: docData.planId || null,
        });
      });

      // B) reviseTimeSubActivity
      const reviseSnap = await db
        .collection("reviseTimeSubActivity")
        .where("activityId", "==", activityId)
        .get();

      reviseSnap.forEach((docSnap) => {
        const docData = docSnap.data();
        const sec = docData.totalSeconds || 0;
        reviseTimeSum += sec;

        const dateStr = docData.dateStr || null;

        details.push({
          docId: docSnap.id,
          collection: "reviseTimeSubActivity",
          totalSeconds: sec,
          lumps: docData.lumps || [],
          createdAt: docData.createdAt || null,
          dateStr,
          // NEW FIELDS:
          revisionNumber: docData.revisionNumber || null,
          quizStage: docData.quizStage || null,
          subChapterId: docData.subChapterId || null,
          userId: docData.userId || null,
          planId: docData.planId || null,
        });
      });

      totalTime = quizTimeSum + reviseTimeSum;

    } else {
      return res.status(400).json({ error: "Unsupported type." });
    }

    // Return totalTime + doc-level details (with new fields)
    return res.json({
      totalTime,
      details,
    });
  } catch (err) {
    console.error("[GET] /api/getActivityTime => error:", err);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * GET /subchapter-history?userId=...&planId=...&subchapterId=...
 * => Return all quiz attempts, revision attempts, concept mastery, etc. 
 *    across all quiz stages: remember, understand, apply, analyze.
 */
app.get("/subchapter-history", async (req, res) => {
  try {
    const { userId, planId, subchapterId } = req.query;
    if (!userId || !planId || !subchapterId) {
      return res.status(400).json({ error: "Missing userId, planId, or subchapterId" });
    }

    // 1) We'll build a final "history" object keyed by quiz stage.
    //    e.g. { remember: {...}, understand: {...}, apply: {...}, analyze: {...} }
    const QUIZ_STAGES = ["remember", "understand", "apply", "analyze"];
    const finalData = {};

    // 2) For each stage => gather aggregator-like data
    for (const stage of QUIZ_STAGES) {
      const stageData = await gatherStageHistory(userId, planId, subchapterId, stage);
      finalData[stage] = stageData;
    }

    // 3) Return the final object
    return res.json({
      userId,
      planId,
      subchapterId,
      history: finalData,
    });
  } catch (err) {
    console.error("[/subchapter-history] error =>", err);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * gatherStageHistory
 * => returns an object like:
 *    {
 *      quizAttempts: [
 *        { attemptNumber, score, timestamp, conceptStats: [...] },
 *        ...
 *      ],
 *      revisionAttempts: [
 *        { revisionNumber, timestamp },
 *        ...
 *      ],
 *      masteryPct: number,   // 0..100
 *      conceptMastery: [
 *        { conceptName, ratio, passOrFail, correct, total },
 *        ...
 *      ]
 *    }
 */
/**
 * Gathers quiz + revision attempts for a given stage, builds an aggregated
 * conceptMastery array so that if a concept was passed in ANY attempt,
 * we still show "PASS" for that concept. This matches your masteryPct.
 */
async function gatherStageHistory(userId, planId, subChId, stage) {
  const dbRef = admin.firestore();

  // 1) Get all quiz attempts for this user/plan/subchapter/stage
  const quizSnap = await dbRef
    .collection("quizzes_demo")
    .where("userId", "==", userId)
    .where("planId", "==", planId)
    .where("subchapterId", "==", subChId)
    .where("quizType", "==", stage)
    .get();

  const quizAttempts = [];
  quizSnap.forEach((docSnap) => {
    const d = docSnap.data();
    quizAttempts.push({
      attemptNumber: d.attemptNumber || 1,
      score: d.score || "",            // e.g. "75%" or "50.00%"
      timestamp: d.timestamp || null,  // Firestore timestamp
      quizSubmission: d.quizSubmission || [],
    });
  });

  // Sort quiz attempts by timestamp, then attemptNumber
  quizAttempts.sort((a, b) => {
    const tA = toMillis(a.timestamp), tB = toMillis(b.timestamp);
    if (tA !== tB) return tA - tB;
    return (a.attemptNumber || 0) - (b.attemptNumber || 0);
  });

  // 2) Get all revision attempts for the same stage
  const revSnap = await dbRef
    .collection("revisions_demo")
    .where("userId", "==", userId)
    .where("planId", "==", planId)
    .where("subchapterId", "==", subChId)
    .where("revisionType", "==", stage)
    .get();

  const revisionAttempts = [];
  revSnap.forEach((docSnap) => {
    const d = docSnap.data();
    revisionAttempts.push({
      revisionNumber: d.revisionNumber || 1,
      timestamp: d.timestamp || null,
    });
  });

  // Sort revision attempts similarly
  revisionAttempts.sort((a, b) => {
    const tA = toMillis(a.timestamp), tB = toMillis(b.timestamp);
    if (tA !== tB) return tA - tB;
    return (a.revisionNumber || 0) - (b.revisionNumber || 0);
  });

  // 3) Fetch all subchapterConcepts so we know which concepts exist
  const conceptSnap = await dbRef
    .collection("subchapterConcepts")
    .where("subChapterId", "==", subChId)
    .get();

  const conceptArr = [];
  conceptSnap.forEach((cDoc) => {
    const cData = cDoc.data();
    const name = cData.name || "UnnamedConcept";
    conceptArr.push({ name });
  });

  // 4) For each quiz attempt => build the standard "attempt.conceptStats"
  //    using your existing per‐attempt logic (buildConceptStats)
  quizAttempts.forEach((attempt) => {
    attempt.conceptStats = buildConceptStats(attempt.quizSubmission, conceptArr);
    // e.g. each conceptStats item => { conceptName, correct, total, ratio, passOrFail }
  });

  // 5) Build a "cumulative" conceptMastery array => if concept is ever passed,
  //    we show PASS here, plus the attempt # where it was first passed
  const cumulativeStats = buildCumulativeConceptMastery(quizAttempts, conceptArr);

  // 6) masteryPct => how many total concepts are "PASS" out of conceptArr.length
  const passCount = cumulativeStats.filter((c) => c.passOrFail === "PASS").length;
  const totalCount = conceptArr.length;
  const masteryPct = totalCount > 0 ? (passCount / totalCount) * 100 : 0;

  // Return final object
  return {
    quizAttempts,       // each attempt has conceptStats
    revisionAttempts,   // normal as before
    masteryPct,         // aggregated pass rate
    conceptMastery: cumulativeStats,  // aggregated pass/fail for all concepts
  };
}

/**
 * Example buildCumulativeConceptMastery function:
 *  - Goes through all quiz attempts, merges pass/fail for each concept
 *  - If ratio==1 in ANY attempt, mark it PASS in the final array
 */
function buildCumulativeConceptMastery(quizAttempts, conceptArr) {
  const conceptMap = {};
  // Initialize from known subchapterConcepts
  conceptArr.forEach((c) => {
    conceptMap[c.name] = {
      name: c.name,
      pass: false,
      passAttempt: null,  // attemptNumber of first pass
    };
  });

  // Walk through each attempt's conceptStats
  quizAttempts.forEach((attempt) => {
    const aNum = attempt.attemptNumber || 1;
    (attempt.conceptStats || []).forEach((cs) => {
      if (!conceptMap[cs.conceptName]) {
        conceptMap[cs.conceptName] = {
          name: cs.conceptName,
          pass: false,
          passAttempt: null,
        };
      }
      // If ratio==1 => concept is passed on this attempt
      if (cs.ratio === 1 && !conceptMap[cs.conceptName].pass) {
        conceptMap[cs.conceptName].pass = true;
        conceptMap[cs.conceptName].passAttempt = aNum;
      }
    });
  });

  // Build final array => e.g. { conceptName, ratio, passOrFail, passAttempt }
  return Object.values(conceptMap).map((obj) => ({
    conceptName: obj.name,
    ratio: obj.pass ? 1 : 0,
    passOrFail: obj.pass ? "PASS" : "FAIL",
    passAttempt: obj.passAttempt, // might be null if never passed
  }));
}


app.get("/userDoc", async (req, res) => {
  try {
    console.log("===== Entered /userDoc route =====");

    const { userId } = req.query;
    console.log("Received userId from query:", userId);

    if (!userId) {
      console.error("No userId provided in query.");
      return res.status(400).json({
        success: false,
        error: "Missing userId query parameter.",
      });
    }

    // Fetch user doc from Firestore
    console.log(`Attempting to fetch doc from 'users/${userId}'...`);
    const userDocRef = admin.firestore().collection("users").doc(userId);
    const userDocSnap = await userDocRef.get();

    console.log("Doc exists:", userDocSnap.exists);

    if (!userDocSnap.exists) {
      console.error(`No user document found for userId: ${userId}`);
      return res.status(404).json({
        success: false,
        error: `No user document found for userId: ${userId}`,
      });
    }

    const userData = userDocSnap.data();
    console.log("Document data:", JSON.stringify(userData, null, 2));

    // Return the userDoc in a success response
    console.log("Returning success response with user data.");
    return res.status(200).json({
      success: true,
      userDoc: userData,
    });
  } catch (error) {
    console.error("Error fetching user document:", error);
    return res.status(500).json({
      success: false,
      error: "Internal server error",
      details: error.message,
    });
  }
});


app.get("/api/daily-time", async (req, res) => {
  const { userId, dateStr } = req.query;
  if (!userId || !dateStr) {
    return res.json({
      success: false,
      message: "Missing userId or dateStr query params",
    });
  }

  try {
    const db = admin.firestore();

    // Query dailyTimeRecords for all docs matching userId + dateStr
    const snapshot = await db
      .collection("dailyTimeRecords")
      .where("userId", "==", userId)
      .where("dateStr", "==", dateStr)
      .get();

    let sumSeconds = 0;
    snapshot.forEach((doc) => {
      const data = doc.data();
      sumSeconds += data.totalSeconds || 0;
    });

    return res.json({ success: true, sumSeconds });
  } catch (err) {
    console.error("Error in GET /daily-time:", err);
    return res.json({ success: false, message: err.message });
  }
});

app.get("/api/daily-time-all", async (req, res) => {
  const { userId } = req.query;
  if (!userId) {
    return res.json({ success: false, message: "Missing userId" });
  }

  try {
    const db = admin.firestore();
    // Query all dailyTimeRecords for the user
    const snapshot = await db
      .collection("dailyTimeRecords")
      .where("userId", "==", userId)
      .get();

    // We'll group by dateStr => sum of totalSeconds
    const map = new Map();
    snapshot.forEach((doc) => {
      const data = doc.data();
      const dateStr = data.dateStr;
      const sec = data.totalSeconds || 0;
      if (!map.has(dateStr)) {
        map.set(dateStr, sec);
      } else {
        map.set(dateStr, map.get(dateStr) + sec);
      }
    });

    // Build an array of { dateStr, sumSeconds }
    const records = [];
    map.forEach((val, key) => {
      records.push({ dateStr: key, sumSeconds: val });
    });

    return res.json({ success: true, records });
  } catch (err) {
    console.error("Error in /daily-time-all:", err);
    return res.json({ success: false, message: err.message });
  }
});

app.get("/api/user", async (req, res) => {
  const { userId } = req.query;
  if (!userId) {
    return res.json({ success: false, message: "Missing userId" });
  }

  try {
    const db = admin.firestore();
    // If doc ID == userId, we do .doc(userId) not .where("userId","==",userId)
    const docRef = db.collection("users").doc(userId);
    const snapshot = await docRef.get();

    if (!snapshot.exists) {
      return res.json({ success: false, message: "User not found." });
    }

    const userData = snapshot.data() || {};
    // e.g. userData = { username: "someone@example.com", createdAt: <timestamp> }

    // Convert Firestore Timestamp => ISO string if needed
    let createdAtStr = null;
    if (userData.createdAt && userData.createdAt.toDate) {
      createdAtStr = userData.createdAt.toDate().toISOString();
    } else if (userData.createdAt) {
      // If it's already a string or Date
      createdAtStr = userData.createdAt;
    }

    return res.json({
      success: true,
      user: {
        username: userData.username || "unknown@example.com",
        createdAt: createdAtStr,
      },
    });
  } catch (err) {
    console.error("Error in GET /api/user:", err);
    return res.json({ success: false, message: err.message });
  }
});



// Example: copy the plan doc from "plans" collection into "adaptive_demo" collection



// Suppose you've already initialized admin.firestore() somewhere above.
// Then your route:

app.post("/api/markPlanAsAdapted", async (req, res) => {
  console.log("[POST] /api/markPlanAsAdapted => HIT THIS ROUTE");
  console.log("Request body =>", req.body);

  try {
    const { planId, userId, sessionIndex } = req.body;

    // 1) Basic validation
    if (!planId || !userId) {
      return res.status(400).json({ error: "Missing planId or userId" });
    }
    if (sessionIndex === undefined || sessionIndex === null) {
      return res.status(400).json({ error: "Missing sessionIndex (exactly one)" });
    }
    if (isNaN(sessionIndex)) {
      return res.status(400).json({ error: "sessionIndex must be a number" });
    }

    console.log(
      `[markPlanAsAdapted] userId=${userId}, planId=${planId}, sessionIndex=${sessionIndex}`
    );

    // 2) Load plan from 'adaptive_demo'
    const dbRef = admin.firestore();
    const planRef = dbRef.collection("adaptive_demo").doc(planId);

    const snap = await planRef.get();
    if (!snap.exists) {
      return res.status(404).json({ error: "Plan document not found in adaptive_demo." });
    }

    const planData = snap.data();
    if (!planData.sessions) {
      return res.status(400).json({
        error: "Plan doc has no 'sessions' array."
      });
    }

    // dailyReadingTimeUsed => e.g. 30 minutes
    const dailyLimit = planData.dailyReadingTimeUsed || 30;
    console.log(`[markPlanAsAdapted] dailyLimit = ${dailyLimit} minutes`);

    // 3) Check session index in range
    if (sessionIndex < 0 || sessionIndex >= planData.sessions.length) {
      return res.status(400).json({
        error: `sessionIndex out of range (0..${planData.sessions.length - 1})`
      });
    }

    // 4) aggregator logic => find incomplete tasks
    const sessionObj = planData.sessions[sessionIndex];
    if (!sessionObj.activities || sessionObj.activities.length === 0) {
      // If no activities => nothing to do
      return res.json({
        success: true,
        message: `Session #${sessionIndex} has no activities; no changes made.`
      });
    }

    // Gather subchapter IDs => aggregator calls
    const uniqueSubChIds = new Set();
    sessionObj.activities.forEach((act) => {
      if (act.subChapterId) {
        uniqueSubChIds.add(act.subChapterId);
      }
    });

    const subChStatusMap = {};
    for (const subChId of uniqueSubChIds) {
      const url = `http://localhost:3001/subchapter-status?userId=${userId}&planId=${planId}&subchapterId=${subChId}`;
      console.log("[markPlanAsAdapted] aggregator =>", url);
      const resp = await axios.get(url);
      subChStatusMap[subChId] = resp.data; 
      // e.g. { readingSummary, quizStages, ... }
    }

    // 5) Determine which tasks are incomplete
    //    We do NOT remove them from session #N; we keep them as history.
    //    We'll copy them forward with a new replicaIndex.
    const incompleteActs = [];
    sessionObj.activities.forEach((act) => {
      let isComplete = false;
      const subChId = act.subChapterId;

      if (!subChId || !subChStatusMap[subChId]) {
        // aggregator data missing => default incomplete
        act.completed = false;
        incompleteActs.push(act);
        return;
      }

      const aggregatorResult = subChStatusMap[subChId];
      const rawType = (act.type || "").toLowerCase();

      if (rawType.includes("read")) {
        // reading => aggregatorResult.readingSummary.overall === "done"
        const readingOverall = aggregatorResult.readingSummary?.overall || "not-started";
        if (readingOverall === "done") {
          isComplete = true;
        }
      } else if (rawType.includes("quiz")) {
        // quiz => aggregatorResult.quizStages[quizStage].overall === "done"
        const stage = (act.quizStage || "").toLowerCase();
        if (aggregatorResult.quizStages?.[stage]?.overall === "done") {
          isComplete = true;
        }
      }

      act.completed = isComplete;
      if (!isComplete) {
        // add to incomplete list
        incompleteActs.push(act);
      }
    });

    // 6) "Copy" these incomplete tasks into next day or new day
    if (incompleteActs.length > 0) {
      const isLastSession = (sessionIndex === planData.sessions.length - 1);

      // We'll create a "copy" array for the next session
      const newCopies = incompleteActs.map((orig) => {
        // If there's no replicaIndex, assume 0
        const oldReplica = typeof orig.replicaIndex === "number" ? orig.replicaIndex : 0;
        const newIndex = oldReplica + 1; // increment

        return {
          ...orig,
          // NOTE: we keep same activityId
          // but we set replicaIndex to oldReplica + 1
          replicaIndex: newIndex,
          // Also set completed to false on the copy
          completed: false,
          // aggregatorStatus / any other fields are optional
        };
      });

      if (isLastSession) {
        // create brand-new session with these tasks
        const newSess = {
          sessionLabel: String(planData.sessions.length + 1),
          activities: newCopies,
        };
        planData.sessions.push(newSess);
        console.log(
          `[markPlanAsAdapted] Created new session #${
            planData.sessions.length - 1
          } with ${newCopies.length} incomplete tasks (copied, with replicaIndex++).`
        );
      } else {
        // Prepend them to the next session's activities
        const nextSession = planData.sessions[sessionIndex + 1];
        if (!nextSession.activities) {
          nextSession.activities = [];
        }
        nextSession.activities = [...newCopies, ...nextSession.activities];
        console.log(
          `[markPlanAsAdapted] Copied ${newCopies.length} incomplete tasks to session #${
            sessionIndex + 1
          } (replicaIndex++).`
        );
      }
    }

    // 7) Rebalance from sessionIndex+1 => onward
    //    so that each day’s sum of timeNeeded <= dailyLimit
    const startRebalanceIndex = sessionIndex + 1;
    if (startRebalanceIndex < planData.sessions.length) {
      // gather future tasks
      let allFutureActs = [];
      for (let i = startRebalanceIndex; i < planData.sessions.length; i++) {
        allFutureActs.push(...planData.sessions[i].activities);
      }

      // remove old sessions from that index onward
      planData.sessions.splice(startRebalanceIndex);

      // build new sessions day-by-day
      let newSessions = [];
      let currentActs = [];
      let currentTime = 0;

      for (const a of allFutureActs) {
        const needed = a.timeNeeded || 0;
        if (currentTime + needed > dailyLimit) {
          // finalize day
          newSessions.push({
            sessionLabel: String(planData.sessions.length + newSessions.length + 1),
            activities: currentActs,
          });
          // new day
          currentActs = [a];
          currentTime = needed;
        } else {
          currentActs.push(a);
          currentTime += needed;
        }
      }
      // leftover
      if (currentActs.length > 0) {
        newSessions.push({
          sessionLabel: String(planData.sessions.length + newSessions.length + 1),
          activities: currentActs,
        });
      }

      // add new sessions
      planData.sessions.push(...newSessions);

      console.log(
        `[markPlanAsAdapted] Rebalanced from session #${startRebalanceIndex}, created ${newSessions.length} new sessions (limit=${dailyLimit}).`
      );
    }

    // 8) Mark adapted + update Firestore
    await planRef.update({
      sessions: planData.sessions,
      adapted: true,
      lastAdaptedAt: new Date(),
    });

    return res.json({
      success: true,
      message: `Copied incomplete tasks from sessionIndex=${sessionIndex} => next day (with replicaIndex). Then rebalanced from day #${startRebalanceIndex}.`,
    });
  } catch (err) {
    console.error("[markPlanAsAdapted] ERROR =>", err);
    return res.status(500).json({ error: err.message });
  }
});


/**
 * slicePdf(pdfPath, csvPath, outDir)  →  Promise<[fileName, …]>
 * csv rows:   pageNumber , cutRatio   (0 – 1)
 * Example row:  9,0.5313   → cut page 9 at 53.13 % from top.
 */
// ──────────────────────────────────────────────────────────────
// ⬇︎ 1.  DEPENDENCIES for the PDF-slicer stack
// ──────────────────────────────────────────────────────────────


// ──────────────────────────────────────────────────────────────
// ⬇︎ 2.  Minimal Canvas factory for pdfjs  (no external file)
//      – copied/adapted from the pdfjs-dist node example
// ──────────────────────────────────────────────────────────────
class NodeCanvasFactory {
  /** Create a canvas of given size and return { canvas, context } */
  create (width, height) {
    const canvas  = createCanvas(width, height);
    const context = canvas.getContext("2d");
    return { canvas, context };
  }

  /** Reset an existing canvas to a new size */
  reset ({ canvas, context }, width, height) {
    canvas.width  = width;
    canvas.height = height;
  }

  /** Dispose of the canvas to free memory */
  destroy ({ canvas /*, context*/ }) {
    canvas.width  = 0;
    canvas.height = 0;
    canvas        = null;
  }
}

// ──────────────────────────────────────────────────────────────
// ⬇︎ 3.  Core helper – slice a PDF given a CSV of cut-markers
// ──────────────────────────────────────────────────────────────
/**
 * @param {string} pdfPath  – absolute path to the uploaded PDF
 * @param {string} csvPath  – absolute path to the uploaded CSV
 * @param {string} outDir   – directory that will receive slice-PNGs
 * @returns {Promise<string[]>} – list of file-names written inside outDir
 */


// ---------------------------------------------------------------------------
//  Slice a PDF into PNG strips based on <page,ratio> markers                |
//  Uses *only* Sharp to render each page → PNG, then crops in-memory.        |
// ---------------------------------------------------------------------------
async function slicePdf(pdfPath, csvPath, outDir) {
  await fsp.mkdir(outDir, { recursive: true });

  // ---------- 1. read CSV  ----------------------------------------
  const map = {};
  const rows = csvParse(await fsp.readFile(csvPath));
  for (const [pStr, rStr] of rows) {
    const p = Number(pStr), r = Number(rStr);
    if (!Number.isFinite(p) || !Number.isFinite(r)) continue;
    (map[p] ||= []).push(r);
  }

  // ---------- 2. discover #pages  --------------------------------
  const { stdout: meta } = await execFileP("pdfinfo", [pdfPath]);
  const pagesLine = meta.toString().split(/\r?\n/).find(l => l.startsWith("Pages:"));
  const pageCount = Number(pagesLine.split(/\s+/)[1]);

  // ---------- 3. iterate pages that actually have cuts ------------
  let   global = 1;
  const written = [];

  for (const pageNum of Object.keys(map).map(Number)) {
    if (pageNum < 1 || pageNum > pageCount) continue;

    //----------------------------------------------------------------
    // 3a. rasterise page → tmp PNG   (pdftoppm creates file <prefix>.png)
    //----------------------------------------------------------------
    const tmpPrefix = path.join(tmpdir(), `pdftmp_${Date.now()}_${pageNum}`);
    await execFileP(
      "pdftoppm",
      [
        "-png",
        "-r", "300",          // 300 dpi
        "-f", pageNum,
        "-l", pageNum,
        "-singlefile",
        pdfPath,
        tmpPrefix            // produces `${tmpPrefix}.png`
      ]
    );
    const pagePngPath = `${tmpPrefix}.png`;

    //----------------------------------------------------------------
    // 3b. crop slices with Sharp
    //----------------------------------------------------------------
    const { width, height } = await sharp(pagePngPath).metadata();
    const ratios = map[pageNum]
      .map(Number).filter(x => x>0 && x<1)
      .sort((a,b)=>a-b);
    ratios.push(1);

    let top = 0;
    for (const r of ratios) {
      const bottom = Math.round(r * height);
      const sliceH = bottom - top;
      if (sliceH <= 0) { top = bottom; continue; }

      const fname = String(global).padStart(4,"0") + ".png";
      await sharp(pagePngPath)
        .extract({ left:0, top, width, height: sliceH })
        .toFile(path.join(outDir, fname));

      written.push(fname);
      global += 1;
      top     = bottom;
    }

    // clean tmp raster
    fs.unlinkSync(pagePngPath);
  }

  console.log(`✅  Wrote ${written.length} slices → ${outDir}`);
  return written;
}

// ──────────────────────────────────────────────────────────────
// ⬇︎ 4.  Express route:  /api/upload-slices
//     – expects multipart/form-data with fields:
//         • pdfFile (single PDF)
//         • csvFile (single CSV of page,ratio)
// ──────────────────────────────────────────────────────────────
const multerUpload = multer({ dest: "uploads" });   // tmp directory for raw uploads

app.post("/api/upload-slices",
  multerUpload.fields([{ name: "pdfFile" }, { name: "csvFile" }]),
  async (req, res) => {
    try {
      const { pdfFile, csvFile } = req.files || {};
      if (!pdfFile || !csvFile) {
        return res.status(400).json({ error: "Need both PDF & CSV files." });
      }

      const uploadId = Date.now().toString(36);
      const outDir   = path.join(__dirname, "public", "slices", uploadId);
      await fsp.mkdir(outDir, { recursive: true });

      const fileNames = await slicePdf(pdfFile[0].path, csvFile[0].path, outDir);
      const urls      = fileNames.map((n) => `/slices/${uploadId}/${n}`);

      // remove temp uploads
      fsp.unlink(pdfFile[0].path).catch(()=>{});
      fsp.unlink(csvFile[0].path).catch(()=>{});

      return res.status(200).json({ uploadId, urls });
    } catch (err) {
      console.error("Slice error:", err);
      return res.status(500).json({ error: "Slicing failed." });
    }
  }
);

// ──────────────────────────────────────────────────────────────
// ⬇︎ 5.  static server for generated images
//     (already added once near top – keep only ONE instance!)
// ──────────────────────────────────────────────────────────────
app.use("/slices", express.static(path.join(__dirname, "public", "slices")));


const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
