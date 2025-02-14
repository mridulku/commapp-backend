/**
 * index.js (Firebase Functions v2 example)
 */

const { onObjectFinalized } = require("firebase-functions/v2/storage");
const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");
const pdfParse = require("pdf-parse");
const { Storage } = require("@google-cloud/storage");
const fs = require("fs");
const path = require("path");
const openaiPackage = require("openai");
const Configuration = openaiPackage.Configuration;
const OpenAIApi = openaiPackage.OpenAIApi;
const { onDocumentUpdated } = require("firebase-functions/v2/firestore");

// Manually load the cl100k_base tokenizer for GPT-3.5 / GPT-4
const { Tiktoken } = require("@dqbd/tiktoken");
const cl100k = require("@dqbd/tiktoken/encoders/cl100k_base.json");

logger.info(
  "OpenAI version (from local package.json):",
  require("./package.json").dependencies["openai"]
);

admin.initializeApp();
const storage = new Storage();

/**
 * 1) TRIGGER ON PDF UPLOAD (v2 Storage)
 *    - Parse PDF into text
 *    - Store raw text in "pdfExtracts"
 */
exports.onPDFUpload = onObjectFinalized(async (event) => {
  try {
    const object = event.data;
    // 1) Extract custom metadata
    const customMetadata = object.metadata || {};
    const category = customMetadata.category || "unspecified"; // default if missing
    const courseName = customMetadata.courseName || "untitled-course";


    const bucketName = object.bucket;
    const filePath = object.name;
    const contentType = object.contentType;

    if (!contentType || !contentType.includes("pdf")) {
      logger.info("Not a PDF. Skipping.");
      return;
    }

    logger.info(`PDF detected at path: ${filePath}`);

    // 2) Download locally
    const tempFilePath = path.join("/tmp", path.basename(filePath));
    await storage.bucket(bucketName).file(filePath).download({ destination: tempFilePath });
    logger.info(`PDF downloaded locally to ${tempFilePath}`);

    // 3) Parse PDF
    const dataBuffer = fs.readFileSync(tempFilePath);
    const parsed = await pdfParse(dataBuffer);
    const rawText = parsed.text;
    logger.info(`Parsed PDF text length: ${rawText.length}`);

    // 4) Store in Firestore, including `category`
    const db = admin.firestore();
    await db.collection("pdfExtracts").add({
      filePath,
      text: rawText,
      category, // Store the category from custom metadata
      courseName,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    logger.info(`Stored PDF text + category="${category}" in Firestore (pdfExtracts).`);
  } catch (error) {
    logger.error("Error in onPDFUpload:", error);
  }
});


/**
 * 2) TRIGGER ON DOCUMENT CREATION IN "pdfExtracts"
 *    - Insert markers into raw text, store in the same doc (markerText field)
 *    - Call GPT with markerText to produce JSON chapters
 *    - Store JSON in "pdfSummaries", referencing pdfDocId
 */
exports.addMarkersAndSummarize = onDocumentCreated("pdfExtracts/{docId}", async (event) => {
  try {
    const docSnap = event.data;
    if (!docSnap) {
      logger.warn("No document snapshot found in event.");
      return;
    }

    const data = docSnap.data() || {};
    const text = data.text;
    if (!text) {
      logger.warn("Document has no 'text' field.");
      return;
    }

    // Helper: Insert markers every 1000 chars
    function insertMarkers(originalText, step = 1000) {
      let result = "";
      let index = 0;
      const length = originalText.length;

      while (index < length) {
        const end = Math.min(index + step, length);
        const chunk = originalText.slice(index, end);
        result += chunk;
        if (end < length) {
          result += `[INDEX=${end}]`;
        }
        index = end;
      }
      return result;
    }

    // 1) Insert markers
    const textWithMarkers = insertMarkers(text, 1000);

    // 2) Store the marker-based text in the same doc
    const db = admin.firestore();
    const pdfExtractDocRef = db.collection("pdfExtracts").doc(event.params.docId);
    await pdfExtractDocRef.update({
      markerText: textWithMarkers,
      markersCreatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    logger.info("Stored marker-based text in the pdfExtracts doc.");

    // 3) Call GPT with textWithMarkers
    const openAiKey = process.env.OPENAI_API_KEY;
    if (!openAiKey) {
      throw new Error("OPENAI_API_KEY is not set in environment variables!");
    }

    const configuration = new Configuration({ apiKey: openAiKey });
    const openai = new OpenAIApi(configuration);

    const prompt = `
You are a helpful assistant. I have text with markers like [INDEX=1000], [INDEX=2000], etc.
I want to split this text into 10 chapters. Please provide a structured JSON response containing:

1. An array called "chapters".
2. Each entry in "chapters" is an object with:
   - "title": a short descriptive title of the chapter,
   - "summary": a short summary of the chapter,
   - "startMarker": the marker where the chapter starts,
   - "endMarker": the marker where the chapter ends.

Do NOT include any additional commentary outside the JSON. Only return valid JSON so I can parse it. Also ensure that in the json you proide you cover all the content meaning that if chapter 1 starts at someindex and ends at some index, the next chapter, should start at the index where the last chapter ended and the final chapter should end at almost the index at which the content ends.

Also, the names of the chapters you provide should start with 1. xxx, 2. xxx, 3. xxx, etc. meaning first the number and then name of chapter.

Text with markers:
${textWithMarkers}
`.trim();

    const completion = await openai.createChatCompletion({
      model: "gpt-4o-mini", // or your actual model
      messages: [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: prompt },
      ],
      temperature: 0.7,
    });

    const gptJson = completion.data.choices[0].message.content.trim();
    logger.info("GPT JSON output:", gptJson);

    // 4) Store GPT JSON in "pdfSummaries" referencing the docId
    await db.collection("pdfSummaries").add({
      pdfDocId: event.params.docId, // reference back to pdfExtracts
      summary: gptJson,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    logger.info("Successfully stored JSON summary in pdfSummaries.");
  } catch (error) {
    logger.error("Error in addMarkersAndSummarize:", error);
  }
});

/**
 * 3) TRIGGER ON DOCUMENT CREATION IN "pdfSummaries"
 *    - Parse the JSON output from GPT
 *    - Fetch the *raw text* from pdfExtracts (or markerText, if you prefer)
 *    - Create "pdfChapters" sub-collection or a new top-level collection
 *      with each chapter's text
 */

/*
exports.segmentChapters = onDocumentCreated("pdfSummaries/{summaryId}", async (event) => {
  try {
    const docSnap = event.data;
    if (!docSnap) {
      logger.warn("No doc snapshot in segmentChapters event.");
      return;
    }

    const data = docSnap.data() || {};
    const pdfDocId = data.pdfDocId;
    const summaryJson = data.summary; // the GPT JSON

    if (!pdfDocId) {
      logger.warn("No pdfDocId found in summary doc. Cannot link back.");
      return;
    }
    if (!summaryJson) {
      logger.warn("No summary JSON found in summary doc.");
      return;
    }

    // 1) Parse the GPT JSON
    // We might have triple backticks or something. Let's clean it up:
    let cleanJson = summaryJson.replace(/^```json/, "").replace(/```$/, "").trim();

    let parsed;
    try {
      parsed = JSON.parse(cleanJson);
    } catch (jsonErr) {
      logger.error("Error parsing GPT JSON:", jsonErr);
      return;
    }

    // Expect something like { chapters: [ {title, summary, startMarker, endMarker}, ... ] }
    const chapters = parsed.chapters || [];
    logger.info("Parsed chapters length:", chapters.length);

    // 2) Fetch the raw text (or the markerText) from pdfExtracts
    const db = admin.firestore();
    const pdfExtractDoc = await db.collection("pdfExtracts").doc(pdfDocId).get();
    if (!pdfExtractDoc.exists) {
      logger.warn(`pdfExtract doc not found for docId=${pdfDocId}`);
      return;
    }

    const extractData = pdfExtractDoc.data();
    const rawText = extractData.text;      // or use markerText if you want
    const markerText = extractData.markerText; // your choice

    // 3) For each chapter, we can create sub-documents in a "pdfChapters" collection
    //    We'll do a top-level "pdfChapters" for example.
    //    If you want sub-collection, you'd do .doc(pdfDocId).collection("chapters") or similar.
    const chaptersCollection = db.collection("pdfChapters");

    // Helper to locate a marker in markerText if we want the exact substring
    // (Optional) Implementation depends on how you want to slice text.

    // If we rely on the raw text, you can do your own approach to slice by approximate indexes or something else.

    for (const chapter of chapters) {
      const { title, summary, startMarker, endMarker } = chapter;

      // Option A: store everything in doc without slicing text
      // Option B: attempt to slice the raw text or the markerText using the markers
      // We'll do a simple store of the metadata for now.

      // Example doc
      await chaptersCollection.add({
        pdfDocId,
        title,
        summary,
        startMarker,
        endMarker,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }

    logger.info("Chapters segmented and stored in pdfChapters collection.");
  } catch (error) {
    logger.error("Error in segmentChapters function:", error);
  }
});

/**
 * 4) TRIGGER ON DOCUMENT CREATION IN "pdfExtracts" (v2 Firestore)
 *    - Optional token counting remains the same
 */




exports.segmentChapters = onDocumentCreated("pdfSummaries/{summaryId}", async (event) => {
  try {
    const docSnap = event.data;
    if (!docSnap) return;
    const data = docSnap.data() || {};
    const pdfDocId = data.pdfDocId;
    const summaryJson = data.summary;

    // 1) parse the GPT JSON to get chapters
    // ... same as before

    // 2) fetch pdfExtracts doc for any needed context
    const db = admin.firestore();
    // ... same as before

    for (const chapter of chapters) {
      const { title, summary, startMarker, endMarker } = chapter;

      // (A) create pdfChapters doc
      const chapterRef = await db.collection("pdfChapters").add({
        pdfDocId,
        title,
        summary,
        startMarker,
        endMarker,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      // (B) also create doc in chapters_demo
      // read courseName from pdfExtracts doc
      const courseName = pdfExtractData.courseName;
      const booksSnap = await db
        .collection("books_demo")
        .where("name", "==", courseName)
        .limit(1)
        .get();

      if (!booksSnap.empty) {
        const bookDoc = booksSnap.docs[0];
        const bookId = bookDoc.id;

        const newChapterDemoRef = await db.collection("chapters_demo").add({
          bookId,
          name: title, // or rename
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        // (C) store newChapterDemoId in pdfChapters doc
        await chapterRef.update({
          chapterDemoId: newChapterDemoRef.id,
        });
      } else {
        // no matching book => handle
      }
    }
  } catch (error) {
    logger.error("Error in segmentChapters function:", error);
  }
});


exports.countTokens = onDocumentCreated("pdfExtracts/{docId}", async (event) => {
  try {
    const docSnap = event.data;
    if (!docSnap) {
      logger.warn("No document snapshot found in event.");
      return;
    }

    const data = docSnap.data() || {};
    const text = data.text || "";
    if (!text) {
      logger.warn("Document has no 'text' field.");
      return;
    }

    const encoder = new Tiktoken(
      cl100k.bpe_ranks,
      cl100k.special_tokens,
      cl100k.pat_str
    );

    const tokens = encoder.encode(text);
    const tokenCount = tokens.length;
    encoder.free();

    logger.info(`Token count for doc ${event.params.docId}: ${tokenCount}`);

    const db = admin.firestore();
    await db.collection("pdfExtracts").doc(event.params.docId).update({
      tokenCount,
      tokenCountedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (error) {
    logger.error("Error in countTokens:", error);
  }
});


/**
 * 5) TRIGGER ON DOCUMENT CREATION IN "pdfChapters"
 *    - Parse numeric positions from startMarker/endMarker
 *    - Fetch the markerText from pdfExtracts (since GPT offsets reference markerText)
 *    - Substring that text, remove leftover markers, store result in `fullText`
 */
exports.sliceMarkerTextForChapter = onDocumentCreated("pdfChapters/{chapterId}", async (event) => {
  try {
    const chapterSnap = event.data;
    if (!chapterSnap) {
      logger.warn("No document snapshot found in pdfChapters.");
      return;
    }

    const chapterData = chapterSnap.data() || {};
    const { pdfDocId, startMarker, endMarker } = chapterData;

    if (!pdfDocId) {
      logger.warn("No pdfDocId in chapter doc. Cannot reference pdfExtracts.");
      return;
    }
    if (!startMarker || !endMarker) {
      logger.warn("Missing startMarker/endMarker in chapter doc.");
      return;
    }

    // Helper to parse e.g. "[INDEX=171000]" → 171000
    function parseMarker(markerString) {
      return parseInt(
        markerString.replace("[INDEX=", "").replace("]", ""),
        10
      );
    }

    const startPos = parseMarker(startMarker);
    const endPos   = parseMarker(endMarker);

    // If they can't be parsed into numbers, skip
    if (isNaN(startPos) || isNaN(endPos)) {
      logger.warn(`Invalid markers. startMarker=${startMarker}, endMarker=${endMarker}`);
      return;
    }

    // Fetch the pdfExtracts doc to get markerText
    const db = admin.firestore();
    const pdfExtractRef = db.collection("pdfExtracts").doc(pdfDocId);
    const pdfExtractSnap = await pdfExtractRef.get();

    if (!pdfExtractSnap.exists) {
      logger.warn(`pdfExtract doc not found for docId=${pdfDocId}`);
      return;
    }

    const extractData = pdfExtractSnap.data();
    const markerText = extractData.markerText || "";
    // Note: We rely on these indexes referencing markerText.

    // Substring from startPos to endPos within markerText
    const safeEnd = Math.min(endPos, markerText.length);
    let chapterContent = markerText.substring(startPos, safeEnd);

    // Remove leftover markers like "[INDEX=12345]"
    chapterContent = chapterContent.replace(/\[INDEX=\d+\]/g, "");

    // Store the final text back into the same doc in pdfChapters
    await chapterSnap.ref.update({
      fullText: chapterContent,
      textCreatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    logger.info(`Stored fullText for chapter ${event.params.chapterId} (docId=${pdfDocId}).`);
  } catch (error) {
    logger.error("Error in sliceMarkerTextForChapter:", error);
  }
});


exports.createBookDoc = onDocumentCreated("pdfExtracts/{docId}", async (event) => {
  try {
    const docSnap = event.data;
    if (!docSnap) {
      logger.info("No document snapshot found in event.");
      return;
    }

    const data = docSnap.data() || {};
    const courseName = data.courseName || "Untitled";
    const categoryString = data.category || "Unspecified";
    const docId = event.params.docId;

    logger.info(`New pdfExtracts doc = ${docId}, courseName=${courseName}, category=${categoryString}`);

    // 1) Query categories_demo by 'name'
    const db = admin.firestore();
    const catSnap = await db
      .collection("categories_demo")
      .where("name", "==", categoryString)
      .limit(1)
      .get();

    let categoryId = null;
    if (!catSnap.empty) {
      categoryId = catSnap.docs[0].id;
      logger.info(`Found category docId=${categoryId}`);
    } else {
      logger.info(`No matching category doc for name="${categoryString}"`);
    }

    // 2) Create a new doc in books_demo
    const newBookRef = await db.collection("books_demo").add({
      categoryId: categoryId,
      name: courseName,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    logger.info(`Created books_demo doc id=${newBookRef.id}`);

    // 3) Cross-reference back in pdfExtracts
    await db.collection("pdfExtracts").doc(docId).update({
      bookDemoId: newBookRef.id,
    });

    logger.info(`Updated pdfExtracts/${docId} with bookDemoId=${newBookRef.id}`);

  } catch (error) {
    logger.error("Error in createBookDoc function:", error);
  }
});

/*

exports.createChaptersDemo = onDocumentCreated("pdfChapters/{chapterId}", async (event) => {
  try {
    const docSnap = event.data;
    if (!docSnap) {
      logger.info("No document snapshot in createChaptersDemo event.");
      return;
    }

    const data = docSnap.data() || {};
    const pdfDocId = data.pdfDocId;        // from pdfChapters doc
    const chapterTitle = data.title || ""; // from pdfChapters doc

    if (!pdfDocId) {
      logger.info("No pdfDocId in pdfChapters doc; cannot proceed.");
      return;
    }

    // 1) Fetch the pdfExtracts doc using pdfDocId
    const db = admin.firestore();
    const pdfExtractRef = db.collection("pdfExtracts").doc(pdfDocId);
    const pdfExtractSnap = await pdfExtractRef.get();
    if (!pdfExtractSnap.exists) {
      logger.info(`pdfExtract doc not found for docId=${pdfDocId}.`);
      return;
    }

    const pdfExtractData = pdfExtractSnap.data() || {};
    const courseName = pdfExtractData.courseName; // e.g. "fun", "Chemistry 101", etc.

    if (!courseName) {
      logger.info("No courseName in pdfExtracts doc. Unable to link to books_demo.");
      return;
    }

    logger.info(
      `Creating chapters_demo entry for chapter title="${chapterTitle}", pdfDocId=${pdfDocId}, courseName="${courseName}"`
    );

    // 2) Find the doc in books_demo whose name == courseName
    const booksSnap = await db
      .collection("books_demo")
      .where("name", "==", courseName)
      .limit(1)
      .get();

    if (booksSnap.empty) {
      logger.info(`No matching book in books_demo for name="${courseName}".`);
      return;
    }

    // We have a matching book doc
    const bookDoc = booksSnap.docs[0];
    const bookId = bookDoc.id;

    logger.info(`Matched book: id=${bookId}, name="${courseName}"`);

    // 3) Create doc in chapters_demo => store new doc's ID
    const newChapterRef = await db.collection("chapters_demo").add({
      bookId,
      name: chapterTitle,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    logger.info(
      `Successfully created chapters_demo doc referencing bookId=${bookId}, name="${chapterTitle}".`
    );

    // 4) Store the newly created chapterDemoId back in pdfChapters
    await docSnap.ref.update({
      chapterDemoId: newChapterRef.id,
    });
    logger.info(
      `Stored chapterDemoId=${newChapterRef.id} back into pdfChapters doc ${event.params.chapterId}`
    );

  } catch (error) {
    logger.error("Error in createChaptersDemo function:", error);
  }
});

*/


exports.addMarkersToFullText = onDocumentUpdated("pdfChapters/{chapterId}", async (event) => {
  try {
    const beforeData = event.data.before?.data() || {};
    const afterData = event.data.after?.data() || {};

    // 1) Extract old/new fullText fields
    const oldFullText = beforeData.fullText || null;
    const newFullText = afterData.fullText || null;

    // If no newFullText or it's unchanged, skip
    if (!newFullText) {
      logger.info("No new or updated 'fullText' in pdfChapters doc. Skipping marker insertion.");
      return;
    }
    if (newFullText === oldFullText) {
      logger.info("fullText unchanged. Skipping marker insertion.");
      return;
    }

    logger.info(`Detected updated fullText for doc ${event.params.chapterId}. Inserting markers...`);

    // 2) Insert markers
    function insertMarkers(originalText, step = 100) {
      let result = "";
      let index = 0;
      const length = originalText.length;

      while (index < length) {
        const end = Math.min(index + step, length);
        const chunk = originalText.slice(index, end);
        result += chunk;
        if (end < length) {
          result += `[INDEX=${end}]`;
        }
        index = end;
      }
      return result;
    }

    // Example: step=500 to place markers more frequently
    const markedText = insertMarkers(newFullText, 500);

    // 3) Store the marker-based text in 'fullTextMarkers'
    const db = admin.firestore();
    await db
      .collection("pdfChapters")
      .doc(event.params.chapterId)
      .update({
        fullTextMarkers: markedText,
        markersCreatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

    logger.info(
      `Successfully inserted markers into 'fullText' for doc=${event.params.chapterId}, updated 'fullTextMarkers'.`
    );

  } catch (error) {
    logger.error("Error in addMarkersToFullText function:", error);
  }
});



exports.summarizeFullTextMarkers = onDocumentUpdated("pdfChapters/{chapterId}", async (event) => {
  try {
    const beforeData = event.data.before?.data() || {};
    const afterData = event.data.after?.data() || {};

    // 1) Check if fullTextMarkers was newly created or changed
    const oldMarkers = beforeData.fullTextMarkers;
    const newMarkers = afterData.fullTextMarkers;

    // If no newMarkers or it's unchanged, skip
    if (!newMarkers) {
      logger.info("No new 'fullTextMarkers' in pdfChapters doc. Skipping GPT summarization.");
      return;
    }
    if (oldMarkers === newMarkers) {
      logger.info("fullTextMarkers unchanged. Skipping GPT summarization.");
      return;
    }

    // 2) Summarize newMarkers with GPT
    logger.info(`New/updated fullTextMarkers for docId=${event.params.chapterId}. Summarizing...`);

    const openAiKey = process.env.OPENAI_API_KEY;
    if (!openAiKey) {
      throw new Error("OPENAI_API_KEY is not set in environment variables!");
    }

    const configuration = new Configuration({ apiKey: openAiKey });
    const openai = new OpenAIApi(configuration);

    // Similar to your existing prompt for chunking into chapters, adapt as needed
    const prompt = `
You are a helpful assistant. I have text with markers like [INDEX=1000], [INDEX=2000], etc.
I want you to create sub-chapters from this text. Please provide a structured JSON response containing:

1. An array called "subChapters".
2. Each entry in "subChapters" is an object with:
   - "title": a short descriptive title,
   - "summary": a short summary,
   - "startMarker": the marker where the sub-chapter starts,
   - "endMarker": the marker where it ends.

Do NOT include any additional commentary outside the JSON. Only return valid JSON so I can parse it. Also ensure that in the json you proide you cover all the content meaning that if subchapter 1 starts at someindex and ends at some index, the next subchapter, should start at the index where the last subchapter ended and the final subchapter should end at almost the index at which the content ends.

Also, the names of the subchapters you provide should start with 1. xxx, 2. xxx, 3. xxx, etc. meaning first the number and then name of subchapter.

Text with markers:
${newMarkers}
`.trim();

    const completion = await openai.createChatCompletion({
      model: "gpt-4o-mini", // or whichever model suits your needs
      messages: [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: prompt },
      ],
      temperature: 0.7,
    });

    const gptJson = completion.data.choices[0].message.content.trim();
    logger.info("GPT sub-chapters JSON output:", gptJson);

    // 3) Store GPT JSON in pdfSubSummaries referencing this pdfChapters doc
    const db = admin.firestore();
    await db.collection("pdfSubSummaries").add({
      pdfChapterId: event.params.chapterId,
      subChaptersJson: gptJson, // store the raw JSON (or parse it, your choice)
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    logger.info(
      `Stored GPT sub-chapters JSON in pdfSubSummaries for chapterId=${event.params.chapterId}.`
    );

  } catch (error) {
    logger.error("Error in summarizeFullTextMarkers function:", error);
  }
});



exports.segmentSubChapters = onDocumentCreated("pdfSubSummaries/{subSummaryId}", async (event) => {
  try {
    const docSnap = event.data;
    if (!docSnap) {
      logger.warn("No doc snapshot found in segmentSubChapters event.");
      return;
    }

    const data = docSnap.data() || {};
    const pdfChapterId = data.pdfChapterId;   // references the parent doc in pdfChapters
    const subChaptersJson = data.subChaptersJson;  // the GPT JSON

    if (!pdfChapterId) {
      logger.warn("No pdfChapterId found in pdfSubSummaries doc. Cannot link back to pdfChapters.");
      return;
    }
    if (!subChaptersJson) {
      logger.warn("No subChaptersJson found in pdfSubSummaries doc.");
      return;
    }

    // 1) Parse the GPT sub-chapters JSON
    // It might have backticks or extra formatting
    let cleanJson = subChaptersJson.replace(/^```json/, "").replace(/```$/, "").trim();

    let parsed;
    try {
      parsed = JSON.parse(cleanJson);
    } catch (jsonErr) {
      logger.error("Error parsing subChapters JSON:", jsonErr);
      return;
    }

    // Expect: { "subChapters": [ { title, summary, startMarker, endMarker }, ... ] }
    const subChaptersArr = parsed.subChapters || [];
    logger.info(`Parsed ${subChaptersArr.length} sub-chapters from GPT JSON.`);

    const db = admin.firestore();

    // Optional: If you want the markerText from pdfChapters to do substring slicing,
    // you can fetch the doc here:
    // const chapterDoc = await db.collection("pdfChapters").doc(pdfChapterId).get();
    // if (!chapterDoc.exists) {
    //   logger.warn(`pdfChapter doc not found for docId=${pdfChapterId}`);
    //   return;
    // }
    // const chapterData = chapterDoc.data() || {};
    // const fullTextMarkers = chapterData.fullTextMarkers; // you could slice if needed.

    // 2) Create docs in "pdfSubChapters"
    // For each sub-chapter from GPT, store metadata: pdfChapterId, title, summary, startMarker, endMarker
    const subChaptersCollection = db.collection("pdfSubChapters");

    for (const subChapter of subChaptersArr) {
      const { title, summary, startMarker, endMarker } = subChapter;

      // Create doc in "pdfSubChapters"
      await subChaptersCollection.add({
        pdfChapterId,
        title: title || "Untitled Sub-chapter",
        summary: summary || "",
        startMarker: startMarker || "",
        endMarker: endMarker || "",
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      logger.info(`Created sub-chapter doc for title="${title}" referencing pdfChapterId=${pdfChapterId}.`);
    }

    logger.info(`Successfully stored ${subChaptersArr.length} sub-chapters in pdfSubChapters.`);
  } catch (error) {
    logger.error("Error in segmentSubChapters function:", error);
  }
});



exports.segmentChapters = onDocumentCreated("pdfSummaries/{summaryId}", async (event) => {
  try {
    const docSnap = event.data;
    if (!docSnap) {
      logger.warn("No document snapshot found in segmentChapters event.");
      return;
    }

    // Extract fields from the newly created pdfSummaries doc
    const data = docSnap.data() || {};
    const pdfDocId = data.pdfDocId;       // reference to pdfExtracts doc
    const summaryJson = data.summary;     // GPT's JSON output

    if (!pdfDocId || !summaryJson) {
      logger.warn("Missing pdfDocId or summaryJson in pdfSummaries doc.");
      return;
    }

    // 1) Clean up any triple backticks, parse the JSON
    let cleanJson = summaryJson
      .replace(/^```json/, "")
      .replace(/```$/, "")
      .trim();

    let parsed;
    try {
      parsed = JSON.parse(cleanJson);
    } catch (jsonErr) {
      logger.error("Error parsing GPT JSON in segmentChapters:", jsonErr);
      return;
    }

    // We expect { chapters: [ { title, summary, startMarker, endMarker }, ... ] }
    const chapters = parsed.chapters || [];
    logger.info(`Parsed chapters length: ${chapters.length}`);

    // 2) Fetch the pdfExtracts doc to get courseName, etc.
    const db = admin.firestore();
    const pdfExtractDoc = await db.collection("pdfExtracts").doc(pdfDocId).get();
    if (!pdfExtractDoc.exists) {
      logger.warn(`pdfExtract doc not found for docId=${pdfDocId} in segmentChapters.`);
      return;
    }

    const pdfExtractData = pdfExtractDoc.data() || {};
    const courseName = pdfExtractData.courseName || null;
    if (!courseName) {
      logger.warn("No courseName in pdfExtracts doc. Can't link to books_demo in segmentChapters.");
      return;
    }

    // Query the matching book in books_demo
    const booksSnap = await db
      .collection("books_demo")
      .where("name", "==", courseName)
      .limit(1)
      .get();

    if (booksSnap.empty) {
      logger.warn(`No matching book in books_demo for name="${courseName}".`);
      return;
    }
    const bookDoc = booksSnap.docs[0];
    const bookId = bookDoc.id;

    // 3) For each chapter, create a pdfChapters doc *and* a corresponding chapters_demo doc
    for (const chapter of chapters) {
      const { title, summary, startMarker, endMarker } = chapter;

      // (A) Create the pdfChapters doc
      const chapterRef = await db.collection("pdfChapters").add({
        pdfDocId,
        title,
        summary,
        startMarker,
        endMarker,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      // (B) Create the user-facing chapters_demo doc
      const newChapterDemoRef = await db.collection("chapters_demo").add({
        bookId,
        name: title, // The user-facing name of this chapter
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      // (C) Cross-reference back in pdfChapters (store chapterDemoId)
      await chapterRef.update({
        chapterDemoId: newChapterDemoRef.id,
      });
    }

    logger.info(
      `segmentChapters: Created pdfChapters + chapters_demo docs for all ${chapters.length} chapters.`
    );
  } catch (error) {
    logger.error("Error in segmentChapters function:", error);
  }
});


exports.sliceMarkerTextForSubchapter = onDocumentCreated("pdfSubChapters/{subChapterId}", async (event) => {
  try {
    const subChapterSnap = event.data;
    if (!subChapterSnap) {
      logger.warn("No document snapshot for newly created pdfSubChapters doc.");
      return;
    }

    const subChapterData = subChapterSnap.data() || {};
    const { pdfChapterId, startMarker, endMarker } = subChapterData;

    if (!pdfChapterId) {
      logger.warn("No pdfChapterId in sub-chapter doc. Cannot reference pdfChapters.");
      return;
    }
    if (!startMarker || !endMarker) {
      logger.warn("Missing startMarker/endMarker in sub-chapter doc.");
      return;
    }

    // Helper to parse e.g. "[INDEX=171000]" → 171000
    function parseMarker(markerString) {
      return parseInt(
        markerString.replace("[INDEX=", "").replace("]", ""),
        10
      );
    }

    const startPos = parseMarker(startMarker);
    const endPos   = parseMarker(endMarker);

    // If markers aren't valid numbers, skip
    if (isNaN(startPos) || isNaN(endPos)) {
      logger.warn(`Invalid markers. startMarker=${startMarker}, endMarker=${endMarker}`);
      return;
    }

    // 1) Fetch the doc in `pdfChapters` to get `fullTextMarkers`
    const db = admin.firestore();
    const chapterRef = db.collection("pdfChapters").doc(pdfChapterId);
    const chapterSnap = await chapterRef.get();

    if (!chapterSnap.exists) {
      logger.warn(`pdfChapters doc not found for docId=${pdfChapterId}`);
      return;
    }

    const chapterData = chapterSnap.data() || {};
    const fullTextMarkers = chapterData.fullTextMarkers || "";

    if (!fullTextMarkers) {
      logger.warn(
        `No 'fullTextMarkers' found in pdfChapters/${pdfChapterId}. Cannot slice sub-chapter text.`
      );
      return;
    }

    // 2) Substring from startPos..endPos in fullTextMarkers
    const safeEnd = Math.min(endPos, fullTextMarkers.length);
    let subChapterContent = fullTextMarkers.substring(startPos, safeEnd);

    // Remove leftover markers like [INDEX=12345]
    subChapterContent = subChapterContent.replace(/\[INDEX=\d+\]/g, "");

    // 3) Store the final text in this sub-chapter doc
    await subChapterSnap.ref.update({
      fullText: subChapterContent,
      textCreatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    logger.info(
      `Successfully stored 'fullText' for sub-chapter ${event.params.subChapterId} (pdfChapterId=${pdfChapterId}).`
    );
  } catch (error) {
    logger.error("Error in sliceMarkerTextForSubchapter:", error);
  }
});



/**
 * 1) CREATE Trigger: Fires when a doc is created in `pdfSubChapters/{subChapterId}`.
 *    - Reads the parent `pdfChapters` doc to get `chapterDemoId`.
 *    - Creates a corresponding doc in `subchapters_demo/{subChapterId}`.
 */
exports.createSubChaptersDemoOnCreate = onDocumentCreated(
  "pdfSubChapters/{subChapterId}",
  async (event) => {
    try {
      // `event.data` is the newly created doc snapshot.
      const docSnap = event.data;
      if (!docSnap) return;

      const subChapterId = event.params.subChapterId; // from {subChapterId}
      const data = docSnap.data() || {};

      const pdfChapterId = data.pdfChapterId;
      const subTitle = data.title || "";
      const subSummary = data.fullText || ""; // might be empty if summary is generated later

      if (!pdfChapterId) {
        logger.info("No pdfChapterId found in new doc — skipping creation in subchapters_demo.");
        return;
      }

      // Fetch the parent pdfChapters doc to get `chapterDemoId`
      const chapterRef = admin.firestore().collection("pdfChapters").doc(pdfChapterId);
      const chapterSnap = await chapterRef.get();
      if (!chapterSnap.exists) {
        logger.info(`No pdfChapters doc found for ID: ${pdfChapterId}.`);
        return;
      }

      const chapterData = chapterSnap.data() || {};
      const chapterDemoId = chapterData.chapterDemoId;
      if (!chapterDemoId) {
        logger.info("No chapterDemoId found in pdfChapters doc. Skipping creation in subchapters_demo.");
        return;
      }

      // Create a doc in `subchapters_demo` with the SAME doc ID as subChapterId for easy lookups
      await admin.firestore().collection("subchapters_demo").doc(subChapterId).set({
        subChapterId, // store it so we can easily reference it if needed
        chapterId: chapterDemoId,   // link to the "chapters_demo"
        name: subTitle,
        summary: subSummary,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      logger.info(`Created subchapters_demo/${subChapterId} successfully.`);
    } catch (error) {
      logger.error("Error in createSubChaptersDemoOnCreate:", error);
    }
  }
);

/**
 * 2) UPDATE Trigger: Fires whenever a doc in `pdfSubChapters/{subChapterId}` changes.
 *    - Checks if `fullText` changed between `before` and `after`.
 *    - If changed, updates the matching doc in `subchapters_demo/{subChapterId}`.
 */
exports.updateSubChaptersDemoOnUpdate = onDocumentUpdated(
  "pdfSubChapters/{subChapterId}",
  async (event) => {
    try {
      // In v2, event.data.before and event.data.after are DocumentSnapshots for the old/new versions
      const beforeSnap = event.data.before;
      const afterSnap = event.data.after;

      if (!beforeSnap.exists || !afterSnap.exists) {
        // If the doc was deleted or somehow missing, do nothing
        return;
      }

      const beforeData = beforeSnap.data() || {};
      const afterData = afterSnap.data() || {};

      // Only update if `fullText` actually changed
      if (beforeData.fullText === afterData.fullText) {
        return;
      }

      const newSummary = afterData.fullText || "";
      const subChapterId = event.params.subChapterId;

      // Update the subchapters_demo doc that shares the same ID
      const subDemoRef = admin.firestore().collection("subchapters_demo").doc(subChapterId);
      await subDemoRef.update({
        summary: newSummary,
      });

      logger.info(`Updated subchapters_demo/${subChapterId} with new summary.`);
    } catch (error) {
      logger.error("Error in updateSubChaptersDemoOnUpdate:", error);
    }
  }
);

// You can define other v2 triggers (e.g., onObjectFinalized for Storage) below...