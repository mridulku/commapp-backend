require("dotenv").config();
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const admin = require("firebase-admin");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const app = express();

// Debugging the loaded JWT_SECRET
console.log("JWT_SECRET in use:", process.env.JWT_SECRET); // Add this line

// =======================================
// CORS CONFIGURATION
// =======================================
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

// Use CORS with the above options
app.use(cors(corsOptions));

// Handle preflight (OPTIONS) requests globally
app.options("*", cors(corsOptions));
// =======================================

// Middleware
// (Note: we do NOT call "app.use(cors())" again because we've already set it above.)
// app.use(cors());
app.use(express.json());

// Initialize Firebase Admin
const serviceAccount = require("./firebase-key.json"); // Ensure this matches the filename of your service account key
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore(); // Firestore database instance

// Middleware to verify JWT token
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


// Basic Route to Test
app.get("/", (req, res) => {
  res.send("Backend server is running!");
});

// Firestore Test Route
app.get("/test-firestore", async (req, res) => {
  try {
    // Add a test document to the "testCollection"
    await db.collection("testCollection").add({
      testField: "Hello, Firestore!",
      timestamp: new Date(),
    });

    res.json({ success: true, message: "Data added to Firestore!" });
  } catch (error) {
    console.error("Error adding data to Firestore:", error);
    res.status(500).json({ success: false, error: "Failed to add data" });
  }
});

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

// Route to fetch all documents from a Firestore collection
app.get("/get-users", async (req, res) => {
  try {
    const usersSnapshot = await db.collection("users").get(); // Replace "users" with your collection name
    const users = usersSnapshot.docs.map((doc) => ({
      id: doc.id, // Include the document ID
      ...doc.data(), // Include the document fields
    }));

    res.json({ success: true, users });
  } catch (error) {
    console.error("Error fetching users:", error);
    res.status(500).json({ success: false, error: "Failed to fetch users" });
  }
});

// Route for user login
app.post("/login", async (req, res) => {
  const { username, password } = req.body;

  try {
    // Query Firestore for the user with the given username
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

    // Compare the provided password with the hashed password
    const isPasswordValid = await bcrypt.compare(password, userData.password);
    if (!isPasswordValid) {
      return res.status(401).json({ error: "Invalid username or password." });
    }

    // Generate a JWT token for the user
    const token = jwt.sign(
      {
        id: userDoc.id,
        username: userData.username,
        role: userData.role,
      },
      process.env.JWT_SECRET,
      { expiresIn: "1h" }
    );

    // -------------- NEW CODE: Store login timestamp --------------
    await db.collection("loginTimestamps").add({
      userId: userDoc.id,           // The Firestore doc ID of the user
      username: userData.username,  // Optional: store username as well
      timestamp: new Date(),        // Or use FieldValue.serverTimestamp()
    });
    // -------------------------------------------------------------

    // Send back success, token, and user object
    res.json({
      success: true,
      token,
      user: {
        username: userData.username,
        role: userData.role,
      },
    });
  } catch (error) {
    console.error("Error during login:", error);
    res.status(500).json({ error: "An error occurred during login." });
  }

  // For debugging: verify JWT_SECRET is present
  console.log("JWT_SECRET during signing:", process.env.JWT_SECRET);
});

// Protected route to fetch the logged-in user's profile
app.get("/user-profile", authenticateToken, async (req, res) => {
  try {
    // Query Firestore by username from the decoded token payload
    const usersSnapshot = await db
      .collection("users")
      .where("username", "==", req.user.username) // Use username
      .limit(1) // Limit to one user
      .get();

    if (usersSnapshot.empty) {
      return res.status(404).json({ error: "User not found." });
    }

    // Get the first matching document
    const userDoc = usersSnapshot.docs[0];

    res.json({ success: true, profile: userDoc.data() });
  } catch (error) {
    console.error("Error fetching user profile:", error);
    res.status(500).json({ error: "Failed to fetch user profile." });
  }
});

// Protected route to fetch a list of users (admin-only)
app.get("/all-users", authenticateToken, async (req, res) => {
  if (req.user.role !== "admin") {
    return res.status(403).json({ error: "Access denied." });
  }

  try {
    const usersSnapshot = await db.collection("users").get();
    const users = usersSnapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));

    res.json({ success: true, users });
  } catch (error) {
    console.error("Error fetching users:", error);
    res.status(500).json({ error: "Failed to fetch users." });
  }
});

// ...
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

/*

app.get("/api/books", async (req, res) => {
  try {
    // 1. Fetch from the new Firestore collection
    const snapshot = await db.collection("SubChapterNames").get();

    // 2. Build a nested object: data[book_name][chapter][title] = { summary, serial, start_page, end_page, wordCount }
    const data = {};

    snapshot.forEach((doc) => {
      const docData = doc.data();
      const {
        bookName,
        chapter,
        start_page,
        end_page,
        title,
        serial,
        description
      } = docData;

      // Ensure we have top-level object for this book
      if (!data[bookName]) {
        data[bookName] = {};
      }

      // Ensure we have a sub-object for this chapter
      if (!data[bookName][chapter]) {
        data[bookName][chapter] = {};
      }

      // === NEW: compute or retrieve wordCount ===
      // If you already have docData.wordCount in Firestore, you can use that instead.
      // E.g.: const wordCount = docData.wordCount || 0
      // Otherwise, compute from description:
      const wordCount = description
        ? description.trim().split(/\s+/).length
        : 0;
      // === end new code ===

      // Use "title" as the sub-chapter key
      data[bookName][chapter][title] = {
        summary: description, // rename "description" -> "summary" for the viewer
        serial,
        start_page,
        end_page,
        wordCount  // new field added
      };
    });

    // 3. Transform that nested object -> array of { bookName, chapters: [{ chapterName, subChapters }] }
    const booksArray = Object.keys(data).map((bookName) => ({
      bookName,
      chapters: Object.keys(data[bookName]).map((chapterName) => {
        // Grab all sub-chapter "titles"
        const subChaptersArr = Object.keys(data[bookName][chapterName]).map((subTitle) => {
          const item = data[bookName][chapterName][subTitle];
          return {
            subChapterName: subTitle,
            summary: item.summary,
            serial: item.serial,
            start_page: item.start_page,
            end_page: item.end_page,
            wordCount: item.wordCount // pass through to front end
          };
        });

        // Optional: sort subChapters by "serial"
        subChaptersArr.sort((a, b) => (a.serial || 0) - (b.serial || 0));

        return {
          chapterName,
          subChapters: subChaptersArr
        };
      })
    }));

    // 4. Send the final array
    res.json(booksArray);
  } catch (error) {
    console.error("Error fetching books:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

*/

const multer = require("multer");

// If you want to store files in memory (Buffer)
const upload = multer(); 

// If you prefer writing to disk or a specific folder, you can specify:
// const upload = multer({ dest: "uploads/" });

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

// =======================================
// ROUTE 2: Get unique book names
// =======================================
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

// =======================================
// ROUTE 3: Get pages for a given book in range
// =======================================
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


// In your index.js or similar
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

// GET /api/chapters?bookName=XYZ
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

/*

// "complete-subchapter" route
app.post("/api/complete-subchapter", async (req, res) => {
  try {
    // e.g. { userId, bookName, chapterName, subChapterName, done }
    const { userId, bookName, chapterName, subChapterName, done } = req.body;

    // Up to you how you store it:
    // e.g. in a "UserProgress" collection
    await db.collection("UserProgress").doc(`${userId}_${bookName}_${chapterName}_${subChapterName}`)
      .set({
        userId,
        bookName,
        chapterName,
        subChapterName,
        isDone: done,
        updatedAt: new Date()
      });

    return res.json({ success: true });
  } catch (error) {
    console.error("Error in /complete-subchapter route:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
});



app.get("/api/user-progress", async (req, res) => {
  try {
    const { userId } = req.query;
    if (!userId) {
      return res.status(400).json({ success: false, error: "Missing userId" });
    }

    const snapshot = await db.collection("UserProgress")
      .where("userId", "==", userId)
      .get();

    const progress = snapshot.docs.map((doc) => doc.data()); 
    // each doc: { userId, bookName, chapterName, subChapterName, isDone }
    
    res.json({ success: true, progress });
  } catch (error) {
    console.error("Error in /api/user-progress:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==============================================
// AGGREGATED PROGRESS ROUTE
// ==============================================
app.get("/api/books-aggregated", async (req, res) => {
  try {
    const { userId } = req.query;
    if (!userId) {
      return res
        .status(400)
        .json({ success: false, error: "Missing userId in query params." });
    }

    // 1) Fetch ALL sub-chapter docs from Firestore
    const subChSnap = await db.collection("SubChapterNames").get();
    if (subChSnap.empty) {
      // No sub-chapters at all
      return res.json({ success: true, data: [] });
    }

    // 2) Fetch user progress docs for this user
    //    Each doc: { userId, bookName, chapterName, subChapterName, isDone }
    const progressSnap = await db
      .collection("UserProgress")
      .where("userId", "==", userId)
      .get();

    // Build a quick lookup: doneSet[bookName][chapterName][subChapterName] = true/false
    const doneSet = {};
    progressSnap.forEach((doc) => {
      const p = doc.data();
      if (!doneSet[p.bookName]) {
        doneSet[p.bookName] = {};
      }
      if (!doneSet[p.bookName][p.chapterName]) {
        doneSet[p.bookName][p.chapterName] = {};
      }
      // isDone is a boolean; default to false if missing
      doneSet[p.bookName][p.chapterName][p.subChapterName] = p.isDone || false;
    });

    // 3) Group sub-chapters in memory as: book -> chapter -> subChapters
    const booksMap = {}; // { [bookName]: { chaptersMap: { [chapterName]: { subChapters: {} } }, totalWords, totalWordsRead } }

    subChSnap.forEach((doc) => {
      const data = doc.data();
      const {
        bookName,
        chapter,
        title, // sub-chapter title
        description,
        wordCount,
      } = data;

      // Book container
      if (!booksMap[bookName]) {
        booksMap[bookName] = {
          bookName,
          chaptersMap: {},
          totalWords: 0,
          totalWordsRead: 0,
        };
      }

      // Chapter container
      if (!booksMap[bookName].chaptersMap[chapter]) {
        booksMap[bookName].chaptersMap[chapter] = {
          chapterName: chapter,
          subChaptersMap: {},
          totalWords: 0,
          totalWordsRead: 0,
        };
      }

      // Use whatever logic you want to get subChapterName
      const subChapterName = title;

      // If wordCount is not stored, compute from description:
      const computedWordCount = wordCount
        ? wordCount
        : description
        ? description.trim().split(/\s+/).length
        : 0;

      // Check if the user has completed this sub-chapter
      const isDone =
        doneSet[bookName]?.[chapter]?.[subChapterName] === true;

      // We consider "wordsRead" fully if isDone, or 0 if not done
      const wordsRead = isDone ? computedWordCount : 0;

      // Build the sub-chapter entry
      booksMap[bookName].chaptersMap[chapter].subChaptersMap[subChapterName] = {
        subChapterName,
        wordCount: computedWordCount,
        wordsRead,
      };

      // Also add to chapter totals
      booksMap[bookName].chaptersMap[chapter].totalWords += computedWordCount;
      booksMap[bookName].chaptersMap[chapter].totalWordsRead += wordsRead;

      // Add to book totals
      booksMap[bookName].totalWords += computedWordCount;
      booksMap[bookName].totalWordsRead += wordsRead;
    });

    // 4) Convert booksMap into an array (with nested chapters + subChapters)
    const finalBooksArr = Object.values(booksMap).map((bookObj) => {
      const { bookName, chaptersMap, totalWords, totalWordsRead } = bookObj;
      const bookPct =
        totalWords > 0 ? (totalWordsRead / totalWords) * 100 : 0;

      const chaptersArr = Object.values(chaptersMap).map((chap) => {
        const { chapterName, subChaptersMap } = chap;
        const cPct =
          chap.totalWords > 0
            ? (chap.totalWordsRead / chap.totalWords) * 100
            : 0;

        const subChaptersArr = Object.values(subChaptersMap).map((sub) => {
          const scPct =
            sub.wordCount > 0
              ? (sub.wordsRead / sub.wordCount) * 100
              : 0;
          return {
            subChapterName: sub.subChapterName,
            wordCount: sub.wordCount,
            wordsRead: sub.wordsRead,
            percentageCompleted: scPct,
          };
        });

        return {
          chapterName,
          totalWords: chap.totalWords,
          totalWordsRead: chap.totalWordsRead,
          percentageCompleted: cPct,
          subChapters: subChaptersArr,
        };
      });

      return {
        bookName,
        totalWords,
        totalWordsRead,
        percentageCompleted: bookPct,
        chapters: chaptersArr,
      };
    });

    return res.json({
      success: true,
      data: finalBooksArr,
    });
  } catch (error) {
    console.error("Error in /api/books-aggregated:", error);
    return res.status(500).json({
      success: false,
      error: error.message || "Internal server error",
    });
  }
});


*/

// In index.js or routes/subchapters.js
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

// GET /api/subchapters?bookName=XYZ&chapterName=ABC
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




/*
  ----------------------------------------------------------
  1) GET /api/categories 
  -> returns all categories sorted by name
  ----------------------------------------------------------
*/
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

/*
  ----------------------------------------------------------
  2) GET /api/books?categoryId=...
  -> returns an array of books (with nested chapters & subChapters)
     optionally filtered by categoryId
  -> also sorts books, chapters, subChapters in alphabetical order
  ----------------------------------------------------------
*/
app.get("/api/books", async (req, res) => {
  try {
    const { categoryId } = req.query;

    // 1) Fetch books (optionally filtered by categoryId)
    let booksRef = db.collection("books_demo");
    if (categoryId) {
      booksRef = booksRef.where("categoryId", "==", categoryId);
    }
    const booksSnap = await booksRef.get();

    // 2) Fetch all chapters (we'll filter in-memory if needed)
    const chaptersSnap = await db.collection("chapters_demo").get();

    // 3) Fetch all subChapters
    const subChaptersSnap = await db.collection("subchapters_demo").get();

    // Build quick maps
    const booksMap = {}; // key = doc.id for the book
    booksSnap.forEach((doc) => {
      const data = doc.data();
      booksMap[doc.id] = {
        bookId: doc.id,
        bookName: data.name,
        chapters: [],
      };
    });

    // We’ll store all chapters in a map first
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

    // Link sub-chapters to chapters
    subChaptersSnap.forEach((doc) => {
      const data = doc.data();
      const chapterId = data.chapterId;
      if (chaptersMap[chapterId]) {
        chaptersMap[chapterId].subChapters.push({
          subChapterName: data.name,
          summary: data.summary || "",
          wordCount: data.wordCount
            ? data.wordCount
            : data.summary
            ? data.summary.trim().split(/\s+/).length
            : 0,
        });
      }
    });

    // Now link chapters to the books we actually have in booksMap
    // (these are already filtered by categoryId if it was provided)
    Object.values(chaptersMap).forEach((chap) => {
      if (booksMap[chap.bookId]) {
        booksMap[chap.bookId].chapters.push({
          chapterName: chap.chapterName,
          subChapters: chap.subChapters,
        });
      }
    });

    // Convert booksMap to array, then sort
    let booksArray = Object.values(booksMap);

    // Sort books by bookName
    booksArray.sort((a, b) => a.bookName.localeCompare(b.bookName));

    // Sort chapters by chapterName & subChapters by subChapterName
    booksArray = booksArray.map((book) => {
      const sortedChapters = [...book.chapters];
      sortedChapters.sort((c1, c2) => c1.chapterName.localeCompare(c2.chapterName));

      const newChapters = sortedChapters.map((c) => {
        const sortedSubs = [...c.subChapters];
        sortedSubs.sort((s1, s2) =>
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

    return res.json(booksArray);
  } catch (error) {
    console.error("Error fetching books:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
});

/*
  ----------------------------------------------------------
  3) GET /api/user-progress?userId=...
  -> returns array of { userId, bookName, chapterName, subChapterName, isDone }
  ----------------------------------------------------------
*/
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

/*
  ----------------------------------------------------------
  4) GET /api/books-aggregated?userId=...&categoryId=...
  -> aggregator that shows totalWords, totalWordsRead, etc.
     (optionally filtered by categoryId)
  -> also sorts books, chapters, subChapters alphabetically
  ----------------------------------------------------------
*/
app.get("/api/books-aggregated", async (req, res) => {
  try {
    const { userId, categoryId } = req.query;
    if (!userId) {
      return res
        .status(400)
        .json({ success: false, error: "Missing userId" });
    }

    // 1) Fetch the needed collections
    // If categoryId is provided, filter books by that category
    let booksRef = db.collection("books_demo");
    if (categoryId) {
      booksRef = booksRef.where("categoryId", "==", categoryId);
    }

    const [booksSnap, chaptersSnap, subChaptersSnap] = await Promise.all([
      booksRef.get(),                         // only books in that category if categoryId was given
      db.collection("chapters_demo").get(),   // all chapters, we'll link them
      db.collection("subchapters_demo").get() // all subchapters
    ]);

    // 2) Fetch user progress docs for this user
    const progressSnap = await db
      .collection("user_progress_demo")
      .where("userId", "==", userId)
      .get();

    // Build a quick doneSet: subChapterId -> boolean
    const doneSet = {};
    progressSnap.forEach((doc) => {
      const p = doc.data();
      doneSet[p.subChapterId] = !!p.isDone;
    });

    // 3) Build maps
    const booksMap = {}; // bookId -> aggregator
    booksSnap.forEach((doc) => {
      const d = doc.data();
      booksMap[doc.id] = {
        bookId: doc.id,
        bookName: d.name,
        chaptersMap: {},
        totalWords: 0,
        totalWordsRead: 0,
      };
    });

    const chaptersMap = {};
    chaptersSnap.forEach((doc) => {
      const d = doc.data();
      chaptersMap[doc.id] = {
        chapterId: doc.id,
        chapterName: d.name,
        bookId: d.bookId,
        subChaptersMap: {},
        totalWords: 0,
        totalWordsRead: 0,
      };
    });

    // 4) Attach subchapters
    subChaptersSnap.forEach((doc) => {
      const d = doc.data();
      const subChapterId = doc.id;
      const chapterId = d.chapterId;
      if (!chaptersMap[chapterId]) return; // Orphan subchapter or belongs to a different book

      const computedWordCount = d.wordCount
        ? d.wordCount
        : d.summary
        ? d.summary.trim().split(/\s+/).length
        : 0;
      const isDone = doneSet[subChapterId] === true;
      const wordsRead = isDone ? computedWordCount : 0;

      chaptersMap[chapterId].subChaptersMap[subChapterId] = {
        subChapterId,
        subChapterName: d.name,
        wordCount: computedWordCount,
        wordsRead,
      };

      chaptersMap[chapterId].totalWords += computedWordCount;
      chaptersMap[chapterId].totalWordsRead += wordsRead;
    });

    // 5) Attach chapters to relevant books
    Object.values(chaptersMap).forEach((chap) => {
      const { bookId } = chap;
      if (!booksMap[bookId]) return; // Not in the filtered set of books

      booksMap[bookId].totalWords += chap.totalWords;
      booksMap[bookId].totalWordsRead += chap.totalWordsRead;
      booksMap[bookId].chaptersMap[chap.chapterId] = chap;
    });

    // 6) Convert to final array, sort everything
    let finalBooksArr = Object.values(booksMap).map((bookObj) => {
      const { bookName, chaptersMap, totalWords, totalWordsRead } = bookObj;
      const bookPct = totalWords > 0 ? (totalWordsRead / totalWords) * 100 : 0;

      // Sort chapters by name
      const sortedChapters = Object.values(chaptersMap).sort((a, b) =>
        a.chapterName.localeCompare(b.chapterName)
      );

      const chaptersArr = sortedChapters.map((chap) => {
        // Sort subChapters by name
        const sortedSubs = Object.values(chap.subChaptersMap).sort((s1, s2) =>
          s1.subChapterName.localeCompare(s2.subChapterName)
        );
        const cPct =
          chap.totalWords > 0
            ? (chap.totalWordsRead / chap.totalWords) * 100
            : 0;

        const subChaptersArr = sortedSubs.map((sub) => {
          const scPct =
            sub.wordCount > 0 ? (sub.wordsRead / sub.wordCount) * 100 : 0;
          return {
            subChapterName: sub.subChapterName,
            wordCount: sub.wordCount,
            wordsRead: sub.wordsRead,
            percentageCompleted: scPct,
          };
        });

        return {
          chapterName: chap.chapterName,
          totalWords: chap.totalWords,
          totalWordsRead: chap.totalWordsRead,
          percentageCompleted: cPct,
          subChapters: subChaptersArr,
        };
      });

      return {
        bookName,
        totalWords,
        totalWordsRead,
        percentageCompleted: bookPct,
        chapters: chaptersArr,
      };
    });

    // Finally, sort books by name
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

/*
  ----------------------------------------------------------
  5) POST /api/complete-subchapter
  -> same logic as before, name-based lookups to find IDs, 
     then upsert user_progress_demo
  ----------------------------------------------------------
*/
app.post("/api/complete-subchapter", async (req, res) => {
  try {
    const { userId, bookName, chapterName, subChapterName, done } = req.body;
    if (!userId || !bookName || !chapterName || !subChapterName) {
      return res.status(400).json({
        success: false,
        error: "Missing required fields in request body.",
      });
    }

    // 1) find the book by name
    const bookSnap = await db
      .collection("books_demo")
      .where("name", "==", bookName)
      .get();
    if (bookSnap.empty) {
      return res
        .status(404)
        .json({ success: false, error: `Book '${bookName}' not found.` });
    }
    const bookDoc = bookSnap.docs[0];
    const bookId = bookDoc.id;

    // 2) find the chapter
    const chapterSnap = await db
      .collection("chapters_demo")
      .where("name", "==", chapterName)
      .where("bookId", "==", bookId)
      .get();
    if (chapterSnap.empty) {
      return res
        .status(404)
        .json({
          success: false,
          error: `Chapter '${chapterName}' not found in book '${bookName}'.`,
        });
    }
    const chapterDoc = chapterSnap.docs[0];
    const chapterId = chapterDoc.id;

    // 3) find the subchapter
    const subchapterSnap = await db
      .collection("subchapters_demo")
      .where("name", "==", subChapterName)
      .where("chapterId", "==", chapterId)
      .get();
    if (subchapterSnap.empty) {
      return res
        .status(404)
        .json({
          success: false,
          error: `Sub-chapter '${subChapterName}' not found in chapter '${chapterName}'.`,
        });
    }
    const subchapterDoc = subchapterSnap.docs[0];
    const subChapterId = subchapterDoc.id;

    // 4) Upsert in user_progress_demo
    const docId = `${userId}_${subChapterId}`;
    await db.collection("user_progress_demo").doc(docId).set({
      userId,
      subChapterId,
      isDone: done,
      updatedAt: new Date(),
    });

    return res.json({ success: true });
  } catch (error) {
    console.error("Error in /api/complete-subchapter route:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
});


/*******************************************
 * GET /api/quizzes?bookName=...&chapterName=...&subChapterName=...
 * Returns quiz data for the specified subchapter.
 * If no quiz doc is found, returns an empty array.
 *******************************************/
app.get("/api/quizzes", async (req, res) => {
  try {
    const { bookName, chapterName, subChapterName } = req.query;
    if (!bookName || !chapterName || !subChapterName) {
      return res.status(400).json({
        success: false,
        error: "Missing bookName, chapterName or subChapterName in query."
      });
    }

    // 1) Find the Book doc by name
    const bookSnap = await db
      .collection("books_demo")
      .where("name", "==", bookName)
      .get();
    if (bookSnap.empty) {
      return res
        .status(404)
        .json({ success: false, error: `Book '${bookName}' not found.` });
    }
    const bookDoc = bookSnap.docs[0];
    const bookId = bookDoc.id;

    // 2) Find the Chapter doc by name & bookId
    const chapterSnap = await db
      .collection("chapters_demo")
      .where("name", "==", chapterName)
      .where("bookId", "==", bookId)
      .get();
    if (chapterSnap.empty) {
      return res.status(404).json({
        success: false,
        error: `Chapter '${chapterName}' not found in book '${bookName}'.`
      });
    }
    const chapterDoc = chapterSnap.docs[0];
    const chapterId = chapterDoc.id;

    // 3) Find the Subchapter doc by name & chapterId
    const subchapterSnap = await db
      .collection("subchapters_demo")
      .where("name", "==", subChapterName)
      .where("chapterId", "==", chapterId)
      .get();
    if (subchapterSnap.empty) {
      return res.status(404).json({
        success: false,
        error: `Sub-chapter '${subChapterName}' not found in chapter '${chapterName}'.`
      });
    }
    const subchapterDoc = subchapterSnap.docs[0];
    const subChapterId = subchapterDoc.id;

    // 4) Fetch the Quiz doc from quizzes_demo (docId = subChapterId or a where)
    const quizDocRef = db.collection("quizzes_demo").doc(subChapterId);
    const quizDocSnap = await quizDocRef.get();

    if (!quizDocSnap.exists) {
      // No quiz for this subchapter
      return res.json({ success: true, data: [] });
    }

    const quizData = quizDocSnap.data();
    // e.g. { subChapterId: ..., questions: [ {questionText, options, ...}, ... ] }

    return res.json({
      success: true,
      data: quizData.questions || []
    });
  } catch (error) {
    console.error("Error in /api/quizzes route:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
});



// No major changes needed here. The "answers" now contains pdfLink for each course.

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

// Add this route to your index.js file (or wherever you define routes)
// e.g., right below "app.get('/test-firestore', ...)" block:

app.post("/onboardingassessment", authenticateToken, async (req, res) => {
  try {
    const assessmentData = req.body;

    // If you want to associate data with a user:
    // const userId = req.user?.id; // if using authenticateToken
    // assessmentData.userId = userId;

    assessmentData.userId = req.user.id;


    // Save the data in the "onboardingAssessments" collection
    const docRef = await db.collection("onboardingAssessments").add(assessmentData);

    res.status(200).json({
      success: true,
      message: "Assessment data saved successfully!",
      docId: docRef.id,
    });
  } catch (error) {
    console.error("Error saving assessment data:", error);
    res.status(500).json({
      success: false,
      message: "Failed to save assessment data",
      error: error.message,
    });
  }
});




/*
  Add your app.listen(...) here, for example:
*/
// const PORT = 3001;
// app.listen(PORT, () => {
//   console.log(`Server running on port ${PORT}`);
// });

// Start the Server
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
