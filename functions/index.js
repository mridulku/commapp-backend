const { onObjectFinalized } = require("firebase-functions/v2/storage");
const { onDocumentCreated, onDocumentUpdated } = require("firebase-functions/v2/firestore");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");
const pdfParse = require("pdf-parse");
const { Storage } = require("@google-cloud/storage");
const fs = require("fs");
const path = require("path");
const openaiPackage = require("openai");
const Configuration = openaiPackage.Configuration;
const OpenAIApi = openaiPackage.OpenAIApi;
const { onRequest } = require("firebase-functions/v2/https");
const { Tiktoken } = require("@dqbd/tiktoken");
const cl100k = require("@dqbd/tiktoken/encoders/cl100k_base.json");
admin.initializeApp();
const storage = new Storage();




/**
 * --------------------------------------------------------------------------------------
 * onPDFUpload
 *
 * Trigger Type:
 *   - onObjectFinalized(async (event))
 *     => Fires whenever a new file (object) is finalized in the Cloud Storage bucket.
 *        Specifically, we check if it's a PDF based on "contentType".
 *
 * Brief Summary:
 *   - Downloads the uploaded PDF to a local /tmp directory.
 *   - Parses the PDF text using "pdf-parse" into lines/paragraphs.
 *   - Creates a doc in "pdfExtracts" with metadata about the PDF (filePath, userId, etc.).
 *   - Also creates multiple docs in "pdfPages" (one doc per paragraph) referencing the same pdfDocId.
 *   - Essentially breaks the PDF content into paragraphs and stores them in "pdfPages"
 *     while recording overall info in "pdfExtracts".
 *
 * Where Data Is Written:
 *   1) "pdfPages" collection:
 *      - Multiple documents created, each containing:
 *          pdfDocId (linking back to the pdfExtracts doc)
 *          pageNumber (index or paragraphNumber)
 *          text (the paragraph text)
 *          createdAt (timestamp)
 *
 *   2) "pdfExtracts" collection:
 *      - One document with a new random ID (pdfDocId) storing:
 *          filePath, text, category, courseName, userId, createdAt
 *
 * --------------------------------------------------------------------------------------
 */

exports.onPDFUpload = onObjectFinalized(async (event) => {
  // These imports are typically at top-level, but shown here for clarity
  const logger = require("firebase-functions/logger");
  const admin = require("firebase-admin");
  const { Storage } = require("@google-cloud/storage");
  const fs = require("fs");
  const path = require("path");
  const pdf = require("pdf-parse");

  // Ensure this is only done once per file
  // e.g. if (!admin.apps.length) admin.initializeApp();
  const storage = new Storage();

  try {
    const object = event.data;
    const customMetadata = object.metadata || {};
    const category = customMetadata.category || "unspecified";
    const courseName = customMetadata.courseName || "untitled-course";
    const userId = customMetadata.userId || "unknown-user"; // or "anonymous"

    const bucketName = object.bucket;
    const filePath = object.name;
    const contentType = object.contentType;

    // Skip if not a PDF
    if (!contentType || !contentType.includes("pdf")) {
      logger.info("Not a PDF. Skipping onPDFUpload.");
      return;
    }

    logger.info(`PDF detected at path: ${filePath}`);

    // 1) Download PDF to local /tmp
    const tempFilePath = path.join("/tmp", path.basename(filePath));
    await storage.bucket(bucketName).file(filePath).download({
      destination: tempFilePath,
    });
    logger.info(`PDF downloaded locally to ${tempFilePath}`);

    // 2) Parse PDF -> full text
    const dataBuffer = fs.readFileSync(tempFilePath);
    const pdfData = await pdf(dataBuffer);
    const fullText = pdfData.text || "";
    logger.info(`Parsed PDF text length: ${fullText.length}`);

    // 3) Split text into lines, then lines → paragraphs
    const lines = fullText.split(/\r?\n/);
    const paragraphs = [];
    let currentPara = [];

    lines.forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed) {
        // Blank line => end of paragraph
        if (currentPara.length > 0) {
          paragraphs.push(currentPara.join(" "));
          currentPara = [];
        }
      } else {
        currentPara.push(trimmed);
      }
    });
    // leftover lines
    if (currentPara.length > 0) {
      paragraphs.push(currentPara.join(" "));
    }

    // Optionally build a combined string of labeled paragraphs
    // (if you want to store in pdfExtracts for reference)
    let finalText = "<<<< Page Number>>>>>\n\n";
    paragraphs.forEach((para, idx) => {
      finalText += `${idx + 1}: ${para}\n\n`;
    });

    // 4) Pre-generate a doc reference for pdfExtracts (DO NOT write yet)
    const db = admin.firestore();
    const pdfExtractRef = db.collection("pdfExtracts").doc();
    const pdfDocId = pdfExtractRef.id;

    // 5) Create pdfPages docs referencing pdfDocId
    //    One doc per paragraph (or "page"), with pageNumber and text
    for (let i = 0; i < paragraphs.length; i++) {
      const paraText = paragraphs[i];
      await db.collection("pdfPages").add({
        pdfDocId,             // link to the upcoming pdfExtracts doc
        pageNumber: i + 1,    // or "paragraphNumber"
        text: paraText,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }

    // 6) Finally, set the doc in "pdfExtracts"
    //    => This triggers any onCreate logic that expects pdfPages to be in place.
    await pdfExtractRef.set({
      filePath,
      text: finalText, // or omit this if you only want separate docs
      category,
      courseName,
      userId, // store the user ID as well
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    logger.info(
      `Created ${paragraphs.length} docs in "pdfPages", then wrote pdfExtracts/${pdfDocId}.`
    );
  } catch (error) {
    logger.error("Error in onPDFUpload (paragraph-based parsing):", error);
  }
});

/**
 * --------------------------------------------------------------------------------------
 * countTokens
 *
 * Trigger Type:
 *   - onDocumentCreated("pdfExtracts/{docId}")
 *     => Fires whenever a new document is created in the "pdfExtracts" collection.
 *
 * Brief Summary:
 *   - Reads the "markerText" field from the newly created doc.
 *   - Uses the Tiktoken library to count how many tokens are in that markerText.
 *   - Logs the token count for debugging.
 *   - Updates the same "pdfExtracts/{docId}" doc with:
 *       tokenCount      (numeric number of tokens)
 *       tokenCountedAt  (timestamp indicating when token count was recorded)
 *
 * Where Data Is Written:
 *   - Collection: "pdfExtracts"
 *   - Document:   The same doc that triggered the function (identified by docId)
 *   - Fields Updated: tokenCount, tokenCountedAt
 * --------------------------------------------------------------------------------------
 */
exports.countTokens = onDocumentCreated("pdfExtracts/{docId}", async (event) => {
  try {
    const docSnap = event.data;
    if (!docSnap) {
      logger.warn("No document snapshot found in event.");
      return;
    }

    const data = docSnap.data() || {};
    const markerText = data.markerText || ""; // we store the combined text under 'markerText'

    if (!markerText) {
      logger.warn("No 'markerText' to count tokens for.");
      return;
    }

    const encoder = new Tiktoken(
      cl100k.bpe_ranks,
      cl100k.special_tokens,
      cl100k.pat_str
    );

    const tokens = encoder.encode(markerText);
    const tokenCount = tokens.length;
    encoder.free();

    logger.info(`Token count for doc ${event.params.docId}: ${tokenCount}`);

    await db.collection("pdfExtracts").doc(event.params.docId).update({
      tokenCount,
      tokenCountedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (error) {
    logger.error("Error in countTokens:", error);
  }
});


/**
 * --------------------------------------------------------------------------------------
 * addMarkersAndSummarize
 *
 * Trigger Type:
 *   - onDocumentCreated("pdfExtracts/{docId}")
 *     => Fires whenever a new document is created in the "pdfExtracts" collection.
 *
 * Brief Summary:
 *   1) Fetches all related "pdfPages" (by pdfDocId) and concatenates their text with page labels.
 *   2) Updates the "pdfExtracts/{docId}" doc with a "markerText" field (the combined text).
 *   3) Calls GPT to analyze the combined text and produce a JSON structure of top-level chapters.
 *   4) Stores the resulting GPT JSON in "pdfSummaries" (one doc per summary).
 *
 * Where Data Is Written:
 *   - "pdfExtracts/{docId}" (the same doc that triggered the function) is updated:
 *       markerText         (the concatenated page-based text)
 *       markersCreatedAt   (timestamp)
 *
 *   - "pdfSummaries" (new doc):
 *       pdfDocId           (link back to pdfExtracts)
 *       summary            (the JSON from GPT)
 *       createdAt          (timestamp)
 * --------------------------------------------------------------------------------------
 */

exports.addMarkersAndSummarize = onDocumentCreated("pdfExtracts/{docId}", async (event) => {
  try {
    const docSnap = event.data;
    if (!docSnap) {
      logger.warn("No document snapshot found in event.");
      return;
    }

    const data = docSnap.data() || {};
    const pdfDocId = event.params.docId;
    const { pageCount, courseName, category } = data;

    // 1) Fetch all pages from "pdfPages" for this pdfDocId
    const db = admin.firestore();
    const pagesSnap = await db
      .collection("pdfPages")
      .where("pdfDocId", "==", pdfDocId)
      .orderBy("pageNumber", "asc")
      .get();

    if (pagesSnap.empty) {
      logger.warn(`No pages found in pdfPages for pdfDocId=${pdfDocId}. Skipping GPT summarization.`);
      return;
    }
    

    // 2) Build the concatenated text, referencing page numbers
    let combinedText = "";
    pagesSnap.forEach((pDoc) => {
      const pData = pDoc.data();
      combinedText += `\nPage ${pData.pageNumber}:\n${pData.text}\n`;
    });

    // Store that in pdfExtracts (field = markerText, to keep naming consistent)
    const pdfExtractDocRef = db.collection("pdfExtracts").doc(pdfDocId);
    await pdfExtractDocRef.update({
      markerText: combinedText,
      markersCreatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    logger.info(`Stored combined page-based text in pdfExtracts/${pdfDocId}.`);

    // 3) Call GPT
    const openAiKey = process.env.OPENAI_API_KEY;
    if (!openAiKey) {
      throw new Error("OPENAI_API_KEY is not set in environment variables!");
    }
    const configuration = new Configuration({ apiKey: openAiKey });
    const openai = new OpenAIApi(configuration);

    // New prompt: We want startPage and endPage instead of marker indexes
    const prompt = `
You are a structured assistant. I have a text organized by page numbers. Please analyze it and divide it into top-level **chapters**, returning a JSON structure that indicates each chapter's start and end **page** (not character indexes). Follow these rules:

**JSON Structure**:
{
  "chapters": [
    {
      "title": "...",
      "summary": "...",
      "startPage": 1,
      "endPage": 3
    },
    ...
  ]
}

**Requirements**:
1. The first chapter must start at page 1.
2. The last chapter should end at the final page.
3. Provide a logical number of chapters that reflect the content structure.
4. Only return valid JSON. Do not include extra commentary.
5. Have the titles of the chapters starting with numbers 1. x, 2. xetc


Text (with pages labeled):
${combinedText}
`.trim();

    const completion = await openai.createChatCompletion({
      model: "gpt-4o-mini", // or your preferred model
      messages: [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: prompt },
      ],
      temperature: 0.7,
    });

    const gptJson = completion.data.choices[0].message.content.trim();
    logger.info("GPT JSON output (chapters with page ranges):", gptJson);

    // (A) Retrieve the bookDemoId (if any) from the pdfExtract doc to store in pdfSummaries
    const pdfExtractDocSnap = await pdfExtractDocRef.get();
    const pdfExtractData2 = pdfExtractDocSnap.data() || {};
    const bookId = pdfExtractData2.bookDemoId || null; // fallback if not present

    // 4) Store GPT JSON in "pdfSummaries" (now also including bookId)
    await db.collection("pdfSummaries").add({
      pdfDocId,         // reference to pdfExtracts
      bookId,           // <-- new field to link back to the book
      summary: gptJson,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    logger.info(
      `Stored JSON summary in pdfSummaries for pdfDocId=${pdfDocId}, bookId=${bookId}.`
    );
  } catch (error) {
    logger.error("Error in addMarkersAndSummarize:", error);
  }
});

/**
 * --------------------------------------------------------------------------------------
 * segmentChapters
 *
 * Trigger Type:
 *   - onDocumentCreated("pdfSummaries/{summaryId}")
 *     => Fires whenever a new document is created in the "pdfSummaries" collection.
 *
 * Brief Summary:
 *   1) Reads the GPT-generated JSON summary (from "pdfSummaries/{summaryId}") which
 *      contains an array of chapters with { title, summary, startPage, endPage }.
 *   2) Fetches the matching "pdfExtracts" doc to get courseName, then locates
 *      the corresponding book in "books_demo".
 *   3) For each chapter in the JSON:
 *        - Fetches the relevant pages from "pdfPages" (based on startPage..endPage),
 *          concatenates the text into a "combinedText".
 *        - Creates a "pdfChapters" doc with that combined text (fullText, etc.).
 *        - Also creates a matching "chapters_demo" doc (the user-facing version),
 *          storing bookId, name, etc.
 *        - Cross-references the newly created doc IDs so that pdfChapters references
 *          its corresponding chapters_demo.
 *
 * Where Data Is Written:
 *   - "pdfChapters": multiple new docs, each containing:
 *       pdfDocId, title, summary, startPage, endPage,
 *       fullText (combined page text), fullTextMarkers,
 *       createdAt, and chapterDemoId (added afterward).
 *
 *   - "chapters_demo": multiple new docs, each containing:
 *       bookId, name, createdAt
 *       (the 'id' is then referenced by pdfChapters.chapterDemoId)
 *
 * --------------------------------------------------------------------------------------
 */


exports.segmentChapters = onDocumentCreated("pdfSummaries/{summaryId}", async (event) => {
  try {
    const docSnap = event.data;
    if (!docSnap) {
      logger.warn("No document snapshot found in segmentChapters event.");
      return;
    }

    const data = docSnap.data() || {};
    const pdfDocId = data.pdfDocId;
    const summaryJson = data.summary;
    // We want to also track the "summaryId" that triggered this, so we can store that in pdfChapters
    const pdfSummariesDocId = event.params.summaryId;

    if (!pdfDocId || !summaryJson) {
      logger.warn("Missing pdfDocId or summaryJson in pdfSummaries doc.");
      return;
    }

    // 1) Clean and parse GPT JSON
    let cleanJson = summaryJson.replace(/^```json/, "").replace(/```$/, "").trim();
    let parsed;
    try {
      parsed = JSON.parse(cleanJson);
    } catch (jsonErr) {
      logger.error("Error parsing GPT JSON in segmentChapters:", jsonErr);
      return;
    }

    // We expect { "chapters": [ { title, summary, startPage, endPage }, ... ] }
    const chapters = parsed.chapters || [];
    logger.info(`Parsed chapters length: ${chapters.length}`);

    const db = admin.firestore();

    // 2) Get the pdfExtracts doc => We'll use "bookDemoId" to identify the correct book
    const pdfExtractDoc = await db.collection("pdfExtracts").doc(pdfDocId).get();
    if (!pdfExtractDoc.exists) {
      logger.warn(`pdfExtract doc not found for docId=${pdfDocId}`);
      return;
    }
    const pdfExtractData = pdfExtractDoc.data() || {};

    // The key difference: we read "bookDemoId" directly from the PDF extract
    const bookId = pdfExtractData.bookDemoId;
    if (!bookId) {
      logger.warn(`No "bookDemoId" found in pdfExtracts/${pdfDocId}. Cannot proceed.`);
      return;
    }

    // We may still fallback to userId from pdfExtract or from the book doc
    const fallbackUserId = pdfExtractData.userId || "unknownUser";

    // 3) Fetch the matching "books_demo" doc by ID
    const bookSnap = await db.collection("books_demo").doc(bookId).get();
    if (!bookSnap.exists) {
      logger.warn(`books_demo doc not found for id="${bookId}".`);
      return;
    }

    const bookData = bookSnap.data() || {};
    // If the book doc has a userId, we prefer that. Otherwise fallback
    const userId = bookData.userId || fallbackUserId;

    // 4) For each chapter from GPT, fetch pages => create pdfChapters => create chapters_demo
    for (const chapter of chapters) {
      const { title, summary, startPage, endPage } = chapter;

      // (A) Fetch pages from pdfPages in [startPage..endPage], then combine text
      const pagesSnap = await db
        .collection("pdfPages")
        .where("pdfDocId", "==", pdfDocId)
        .where("pageNumber", ">=", startPage)
        .where("pageNumber", "<=", endPage)
        .orderBy("pageNumber", "asc")
        .get();

      let combinedText = "";
      pagesSnap.forEach((pDoc) => {
        const pData = pDoc.data();
        combinedText += `\nPage ${pData.pageNumber}:\n${pData.text}\n`;
      });

      // (B) Create doc in pdfChapters
      // Now includes "bookId" and "pdfSummariesDocId" for traceability
      const chapterRef = await db.collection("pdfChapters").add({
        pdfDocId,
        pdfSummariesDocId, // New field: which pdfSummaries doc created this
        bookId,            // New field: which book it belongs to
        title,
        summary,
        startPage,
        endPage,
        fullText: combinedText,       // store combined page text
        fullTextMarkers: combinedText, // store markers as well
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      // (C) Create doc in chapters_demo (use bookId & userId)
      const newChapterDemoRef = await db.collection("chapters_demo").add({
        bookId,
        userId,
        name: title,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      // (D) Cross-reference
      await chapterRef.update({
        chapterDemoId: newChapterDemoRef.id,
      });
    }

    logger.info(
      `Created pdfChapters + chapters_demo docs for all ${chapters.length} chapters (pdfSummariesDocId=${pdfSummariesDocId}).`
    );
  } catch (error) {
    logger.error("Error in segmentChapters function:", error);
  }
});

/**
 * --------------------------------------------------------------------------------------
 * createBookDoc
 *
 * Trigger Type:
 *   - onDocumentCreated("pdfExtracts/{docId}")
 *     => Fires whenever a new document is created in the "pdfExtracts" collection.
 *
 * Brief Summary:
 *   1) Reads "courseName" and "category" from the newly created pdfExtracts doc.
 *   2) Looks up the matching category doc in "categories_demo" (by name) to find categoryId.
 *   3) Creates a new doc in "books_demo" with that categoryId, the courseName, userId, etc.
 *   4) Updates the original "pdfExtracts/{docId}" doc to record which "books_demo" doc
 *      it corresponds to (bookDemoId).
 *
 * Where Data Is Written:
 *   - "books_demo":
 *       A single new doc is created containing:
 *         categoryId, name (the courseName), userId, createdAt
 *
 *   - "pdfExtracts/{docId}":
 *       Updated to have bookDemoId (the ID of the newly created books_demo doc).
 * --------------------------------------------------------------------------------------
 */

exports.createBookDoc = onDocumentCreated("pdfExtracts/{docId}", async (event) => {
  try {
    const docSnap = event.data;
    if (!docSnap) {
      logger.info("No document snapshot found in event.");
      return;
    }

    const data = docSnap.data() || {};
    const courseName = data.courseName || "Untitled";
    const userId = data.userId || "Untitled";


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
      userId: userId,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    logger.info(`Created books_demo doc id=${newBookRef.id}`);

    // 3) Cross-reference in pdfExtracts
    await db.collection("pdfExtracts").doc(docId).update({
      bookDemoId: newBookRef.id,
    });

    logger.info(`Updated pdfExtracts/${docId} with bookDemoId=${newBookRef.id}`);
  } catch (error) {
    logger.error("Error in createBookDoc function:", error);
  }
});

/**
 * --------------------------------------------------------------------------------------
 * sliceMarkerTextForChapter
 *
 * Trigger Type:
 *   - onDocumentCreated("pdfChapters/{chapterId}")
 *     => Fires whenever a new document is created in the "pdfChapters" collection.
 *
 * Brief Summary:
 *   - Primarily checks if the new doc has a 'fullText' field.
 *   - Logs the length of fullText if present, otherwise logs that there's nothing to slice.
 *   - In this code, no actual slicing or reprocessing is performed; it's effectively a placeholder.
 *
 * Where Data Is Written:
 *   - No additional data is written or updated. The function just reads and logs info
 *     about the newly created pdfChapters doc.
 * --------------------------------------------------------------------------------------
 */
exports.sliceMarkerTextForChapter = onDocumentCreated("pdfChapters/{chapterId}", async (event) => {
  try {
    const chapterSnap = event.data;
    if (!chapterSnap) {
      logger.warn("No document snapshot found in pdfChapters.");
      return;
    }

    // In the new page-based approach, we already store combined text in 'fullText'.
    // We'll just confirm it or do minimal reprocessing.
    const chapterData = chapterSnap.data() || {};
    const existingFullText = chapterData.fullText || "";
    if (!existingFullText) {
      logger.info("No 'fullText' found. There's nothing to slice in page-based logic.");
      return;
    }

    // If you needed to do something else, you could. 
    // For now, we’ll just log that we have the text.
    logger.info(`pdfChapters/${event.params.chapterId} => fullText length=${existingFullText.length}`);
  } catch (error) {
    logger.error("Error in sliceMarkerTextForChapter:", error);
  }
});

/**
 * --------------------------------------------------------------------------------------
 * addMarkersToFullText
 *
 * Trigger Type:
 *   - onDocumentUpdated("pdfChapters/{chapterId}")
 *     => Fires whenever a "pdfChapters" document is updated.
 *
 * Activation Condition:
 *   - Specifically checks if "fullText" changed to a new or different value.
 *
 * Brief Summary:
 *   1) Compares the old "fullText" vs. the updated "fullText".
 *   2) If there's a new or changed "fullText", we insert markers every 500 characters
 *      (like [INDEX=500]) to segment the text.
 *   3) Writes this marker-annotated version into "fullTextMarkers" and sets markersCreatedAt.
 *
 * Where Data Is Written:
 *   - The same "pdfChapters/{chapterId}" doc is updated with:
 *       fullTextMarkers     (the text containing inserted markers)
 *       markersCreatedAt    (timestamp)
 * --------------------------------------------------------------------------------------
 */
exports.addMarkersToFullText = onDocumentUpdated("pdfChapters/{chapterId}", async (event) => {
  try {
    const beforeData = event.data.before?.data() || {};
    const afterData = event.data.after?.data() || {};

    const oldFullText = beforeData.fullText || "";
    const newFullText = afterData.fullText || "";

    // If no newFullText or it's unchanged, skip
    if (!newFullText || oldFullText === newFullText) {
      logger.info("No updated fullText to mark up. Skipping.");
      return;
    }

    logger.info(`Detected updated fullText in pdfChapters/${event.params.chapterId}. Inserting markers...`);

    // Insert artificial markers (like [INDEX=500]) every 500 chars 
    // (You can skip or adapt as needed.)
    function insertMarkers(originalText, step = 500) {
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

    const markedText = insertMarkers(newFullText, 500);

    // Update the doc with fullTextMarkers
    const db = admin.firestore();
    await db
      .collection("pdfChapters")
      .doc(event.params.chapterId)
      .update({
        fullTextMarkers: markedText,
        markersCreatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

    logger.info(`Inserted markers into pdfChapters/${event.params.chapterId} -> fullTextMarkers.`);
  } catch (error) {
    logger.error("Error in addMarkersToFullText function:", error);
  }
});

/**
 * --------------------------------------------------------------------------------------
 * summarizeFullTextMarkers
 *
 * Trigger Type:
 *   - onDocumentCreated("pdfChapters/{chapterId}")
 *     => Fires whenever a new "pdfChapters" doc is created.
 *
 * Activation Condition:
 *   - Checks if "fullTextMarkers" exists in the newly created doc.
 *   - If present, it proceeds to call GPT to further break down the chapter into "subChapters."
 *
 * Brief Summary:
 *   1) Reads "fullTextMarkers" from the new pdfChapters doc.
 *   2) Sends that text to GPT to produce a JSON structure of subChapters (with page markers).
 *   3) Stores the resulting JSON in "pdfSubSummaries" as "subChaptersJson."
 *
 * Where Data Is Written:
 *   - "pdfSubSummaries": a new doc is created containing:
 *       pdfChapterId, subChaptersJson (the JSON from GPT), createdAt
 *
 *   - The original "pdfChapters/{chapterId}" is only read, not updated in this function.
 * --------------------------------------------------------------------------------------
 */

exports.summarizeFullTextMarkers = onDocumentCreated("pdfChapters/{chapterId}", async (event) => {
  try {
    const docSnap = event.data;
    if (!docSnap) return;
    const data = docSnap.data() || {};

    const pdfChapterId = event.params.chapterId;
    const markers = data.fullTextMarkers || "";

    // If no markers, skip
    if (!markers) {
      console.log("No fullTextMarkers on creation. Skipping summarizeFullTextMarkers.");
      return;
    }

    console.log(`New doc created in pdfChapters/${pdfChapterId} with fullTextMarkers. Summarizing...`);

    // 1) Call GPT
    const openAiKey = process.env.OPENAI_API_KEY;
    if (!openAiKey) throw new Error("OPENAI_API_KEY is not set!");
    const configuration = new Configuration({ apiKey: openAiKey });
    const openai = new OpenAIApi(configuration);

    const prompt = `


You are a structured assistant. I have a text organized by page numbers. Please analyze it and divide it into a reasonable number of suchapters returning a JSON structure that indicates each chapter's start and end **page** (not character indexes). Follow these rules:

**JSON Structure**:
{
  "subChapters": [
    {
      "title": "...",
      "summary": "...",
      "startMarker": 1,
      "endMarker": 3
    },
    ...
  ]
}

**Requirements**:
1. The first subchapter must start at the first page number mentioned.
2. The last chapter should end at the final page mentioned in the text.
3. Provide a logical number of chapters that reflect the content structure.
4. Only return valid JSON. Do not include extra commentary.
5. Have the titles of the subchapters starting with numbers 1. x, 2. xetc




${markers}
`.trim();

    const completion = await openai.createChatCompletion({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: prompt },
      ],
      temperature: 0.7,
    });

    const gptJson = completion.data.choices[0].message.content.trim();
    console.log("GPT sub-chapters JSON output:", gptJson);

    // 2) Store in pdfSubSummaries
    const db = admin.firestore();
    await db.collection("pdfSubSummaries").add({
      pdfChapterId,
      subChaptersJson: gptJson,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    console.log(`Stored GPT sub-chapters JSON in pdfSubSummaries for chapterId=${pdfChapterId}.`);
  } catch (error) {
    console.error("Error in summarizeFullTextMarkersOnCreate function:", error);
  }
});

/**
 * --------------------------------------------------------------------------------------
 * segmentSubChapters
 *
 * Trigger Type:
 *   - onDocumentCreated("pdfSubSummaries/{subSummaryId}")
 *     => Fires whenever a new document is created in the "pdfSubSummaries" collection.
 *
 * Brief Summary:
 *   1) Reads "subChaptersJson" (GPT-created JSON) from the new doc.
 *   2) Parses it to get an array of subChapters with { title, summary, startMarker, endMarker }.
 *   3) For each subChapter, creates a new doc in "pdfSubChapters", storing:
 *       pdfChapterId, title, summary, startMarker, endMarker, etc.
 *
 * Where Data Is Written:
 *   - "pdfSubChapters": multiple new docs, each containing:
 *       pdfChapterId, title, summary, startMarker, endMarker, createdAt
 *     => These represent the sub-chapters for the given pdfChapterId.
 * --------------------------------------------------------------------------------------
 */
exports.segmentSubChapters = onDocumentCreated("pdfSubSummaries/{subSummaryId}", async (event) => {
  try {
    const docSnap = event.data;
    if (!docSnap) {
      logger.warn("No doc snapshot found in segmentSubChapters event.");
      return;
    }

    const data = docSnap.data() || {};
    const pdfChapterId = data.pdfChapterId;
    const subChaptersJson = data.subChaptersJson;
    // Also read the doc ID in pdfSubSummaries:
    const pdfSubSummariesDocId = event.params.subSummaryId;

    if (!pdfChapterId || !subChaptersJson) {
      logger.warn("Missing pdfChapterId or subChaptersJson in pdfSubSummaries doc.");
      return;
    }

    // 1) Parse the GPT-generated JSON
    let cleanJson = subChaptersJson.replace(/^```json/, "").replace(/```$/, "").trim();
    let parsed;
    try {
      parsed = JSON.parse(cleanJson);
    } catch (jsonErr) {
      logger.error("Error parsing subChapters JSON:", jsonErr);
      return;
    }

    const subChaptersArr = parsed.subChapters || [];
    logger.info(`Parsed ${subChaptersArr.length} sub-chapters from GPT JSON.`);

    const db = admin.firestore();

    // 2) Fetch the parent pdfChapters doc to see if it has bookId, pdfSummariesDocId, etc.
    const chapterRef = db.collection("pdfChapters").doc(pdfChapterId);
    const chapterSnap = await chapterRef.get();
    if (!chapterSnap.exists) {
      logger.warn(`No pdfChapters doc found for pdfChapterId=${pdfChapterId}. Cannot attach bookId, etc.`);
    }

    let bookId = null;
    let pdfSummariesDocId = null;
    if (chapterSnap.exists) {
      const chapterData = chapterSnap.data() || {};
      bookId = chapterData.bookId || null;                // from the updated segmentChapters
      pdfSummariesDocId = chapterData.pdfSummariesDocId || null;
    }

    // 3) Create each pdfSubChapters doc with additional fields
    for (const subChapter of subChaptersArr) {
      const { title, summary, startMarker, endMarker } = subChapter;

      // Insert more references: bookId, pdfSummariesDocId, pdfSubSummariesDocId
      await db.collection("pdfSubChapters").add({
        pdfChapterId,             // existing field
        pdfSubSummariesDocId,     // new: which pdfSubSummaries doc triggered this
        pdfSummariesDocId,        // new: from the parent pdfChapters doc (if set)
        bookId,                   // new: from the parent pdfChapters doc
        title: title || "Untitled Sub-chapter",
        summary: summary || "",
        startMarker: startMarker || "",
        endMarker: endMarker || "",
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      logger.info(
        `Created pdfSubChapters doc for sub-chapter="${title}" 
         (pdfChapterId=${pdfChapterId}, pdfSubSummariesDocId=${pdfSubSummariesDocId}).`
      );
    }

    logger.info(
      `Successfully stored ${subChaptersArr.length} sub-chapters in pdfSubChapters. 
       (Triggered by pdfSubSummaries/${pdfSubSummariesDocId})`
    );
  } catch (error) {
    logger.error("Error in segmentSubChapters function:", error);
  }
});

/**
 * --------------------------------------------------------------------------------------
 * sliceMarkerTextForSubchapter
 *
 * Trigger Type:
 *   - onDocumentCreated("pdfSubChapters/{subChapterId}")
 *     => Fires whenever a new doc is created in "pdfSubChapters".
 *
 * Brief Summary:
 *   1) Reads the subchapter's pdfChapterId, startMarker, endMarker.
 *   2) Fetches the parent "pdfChapters" doc to get pdfDocId.
 *   3) Queries "pdfPages" for all pages in [startMarker..endMarker].
 *   4) Concatenates the text of those pages into a single fullText.
 *   5) Updates the same subchapter doc with that combined text (stored in fullText)
 *      and sets textCreatedAt to track when it was done.
 *
 * Where Data Is Written:
 *   - "pdfSubChapters/{subChapterId}": updated with:
 *       fullText, textCreatedAt
 *
 * --------------------------------------------------------------------------------------
 */
exports.sliceMarkerTextForSubchapter = onDocumentCreated(
  "pdfSubChapters/{subChapterId}",
  async (event) => {
    try {
      const subChapterSnap = event.data;
      if (!subChapterSnap) {
        console.warn("No document snapshot for newly created pdfSubChapters doc.");
        return;
      }

      const subChapterData = subChapterSnap.data() || {};
      const { pdfChapterId, startMarker, endMarker } = subChapterData;

      // 1) Validate required fields
      if (!pdfChapterId) {
        console.warn("No pdfChapterId in sub-chapter doc. Cannot reference pdfChapters.");
        return;
      }
      if (typeof startMarker !== "number" || typeof endMarker !== "number") {
        console.warn(
          `startMarker/endMarker must be numeric. startMarker=${startMarker}, endMarker=${endMarker}`
        );
        return;
      }

      // 2) Fetch the parent pdfChapters doc to get pdfDocId
      const db = admin.firestore();
      const chapterRef = db.collection("pdfChapters").doc(pdfChapterId);
      const chapterSnap = await chapterRef.get();
      if (!chapterSnap.exists) {
        console.warn(`pdfChapters doc not found for docId=${pdfChapterId}`);
        return;
      }

      const chapterData = chapterSnap.data() || {};
      const pdfDocId = chapterData.pdfDocId;
      if (!pdfDocId) {
        console.warn(
          `No pdfDocId in pdfChapters/${pdfChapterId}. Cannot query pdfPages.`
        );
        return;
      }

      // 3) Query pdfPages for pages in [startMarker..endMarker]
      const pagesSnap = await db
        .collection("pdfPages")
        .where("pdfDocId", "==", pdfDocId)
        .where("pageNumber", ">=", startMarker)
        .where("pageNumber", "<=", endMarker)
        .orderBy("pageNumber", "asc")
        .get();

      if (pagesSnap.empty) {
        console.warn(
          `No pages found in pdfPages for pdfDocId=${pdfDocId} in range ${startMarker}-${endMarker}.`
        );
        return;
      }

      // 4) Combine text from all pages
      let combinedText = "";
      pagesSnap.forEach((pageDoc) => {
        const pData = pageDoc.data() || {};
        combinedText += `\nPage ${pData.pageNumber}:\n${pData.text}\n`;
      });

      // 5) Store combined text in the sub-chapter doc
      await subChapterSnap.ref.update({
        fullText: combinedText,
        textCreatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      console.log(
        `Stored fullText for sub-chapter=${event.params.subChapterId}, pdfDocId=${pdfDocId}, pages=[${startMarker}..${endMarker}].`
      );
    } catch (error) {
      console.error("Error in sliceMarkerTextForSubchapter:", error);
    }
  }
);

/**
 * --------------------------------------------------------------------------------------
 * createSubChaptersDemoOnCreate
 *
 * Trigger Type:
 *   - onDocumentCreated("pdfSubChapters/{subChapterId}")
 *     => Fires whenever a new document is created in "pdfSubChapters".
 *
 * Brief Summary:
 *   1) Reads the new pdfSubChapters doc (pdfChapterId, title, etc.).
 *   2) Fetches the parent pdfChapters doc to find its chapterDemoId (the user-facing chapter).
 *   3) Creates a corresponding doc in "subchapters_demo" (the final user-facing collection),
 *      using the same subChapterId (optionally). Initializes the summary as empty.
 *
 * Where Data Is Written:
 *   - "subchapters_demo/{subChapterId}" (new doc):
 *       subChapterId, chapterId (chapterDemoId), name (subTitle),
 *       summary (empty initially), createdAt
 * --------------------------------------------------------------------------------------
 */

exports.createSubChaptersDemoOnCreate = onDocumentCreated(
  "pdfSubChapters/{subChapterId}",
  async (event) => {
    try {
      const docSnap = event.data;
      if (!docSnap) return;

      const subChapterId = event.params.subChapterId;
      const data = docSnap.data() || {};

      const pdfChapterId = data.pdfChapterId;
      const subTitle = data.title || "";

      if (!pdfChapterId) {
        console.info(
          "No pdfChapterId found in new doc — skipping creation in subchapters_demo."
        );
        return;
      }

      // 1) Fetch the pdfChapters doc to get chapterDemoId
      const db = admin.firestore();
      const chapterRef = db.collection("pdfChapters").doc(pdfChapterId);
      const chapterSnap = await chapterRef.get();
      if (!chapterSnap.exists) {
        console.info(`No pdfChapters doc found for ID: ${pdfChapterId}.`);
        return;
      }

      const chapterData = chapterSnap.data() || {};
      const chapterDemoId = chapterData.chapterDemoId;
      if (!chapterDemoId) {
        console.info(
          "No chapterDemoId found in pdfChapters doc. Skipping creation in subchapters_demo."
        );
        return;
      }

      // 2) Fetch the corresponding chapters_demo doc to retrieve bookId, userId
      const chapterDemoRef = db.collection("chapters_demo").doc(chapterDemoId);
      const chapterDemoSnap = await chapterDemoRef.get();
      if (!chapterDemoSnap.exists) {
        console.info(`No chapters_demo doc found for ID: ${chapterDemoId}.`);
        return;
      }

      const chapterDemoData = chapterDemoSnap.data() || {};
      const bookId = chapterDemoData.bookId || null;
      const userId = chapterDemoData.userId || null;

      // 3) Create in subchapters_demo with the same doc ID (optional)
      //    Now including bookId, userId.
      await db.collection("subchapters_demo").doc(subChapterId).set({
        subChapterId,
        chapterId: chapterDemoId,
        bookId,
        userId,
        name: subTitle,
        summary: "", // will be filled when we slice + update
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      console.log(
        `Created subchapters_demo/${subChapterId} successfully with bookId=${bookId}, userId=${userId}.`
      );
    } catch (error) {
      console.error("Error in createSubChaptersDemoOnCreate:", error);
    }
  }
);

/**
 * --------------------------------------------------------------------------------------
 * repurposeSubChapterWithContext
 *
 * Trigger Type:
 *   - onDocumentUpdated("pdfSubChapters/{subChapterId}")
 *     => Fires whenever an existing "pdfSubChapters" document is updated.
 *
 * Activation Condition:
 *   - Specifically checks if "fullText" changed (new or modified text).
 *
 * Brief Summary:
 *   1) Reads the updated fullText for the subchapter and gathers "context" from
 *      the previous/next page in "pdfPages" to avoid abrupt starts/ends.
 *   2) Calls GPT to rewrite the subchapter text in a continuous manner,
 *      preserving style/meaning while ignoring the actual previous/next text content.
 *   3) Writes the final, repurposed text to "fullTextFinal" in the same subchapter doc.
 *
 * Where Data Is Written:
 *   - The same "pdfSubChapters/{subChapterId}" doc is updated:
 *       fullTextFinal        (the GPT-rewritten subchapter)
 *       repurposeContextAt   (timestamp indicating when rewriting completed)
 * --------------------------------------------------------------------------------------
 */
exports.repurposeSubChapterWithContext = onDocumentUpdated("pdfSubChapters/{subChapterId}", async (event) => {
  try {
    const beforeData = event.data.before?.data() || {};
    const afterData = event.data.after?.data() || {};

    // If `fullText` hasn't changed, skip
    const oldText = beforeData.fullText || "";
    const newText = afterData.fullText || "";
    if (!newText || newText === oldText) {
      logger.info("No new/updated `fullText` to process. Skipping repurposeSubChapterWithContext.");
      return;
    }

    const subChapterId = event.params.subChapterId;

    // (A) Read subChapter info: pdfChapterId, startMarker, endMarker
    const { pdfChapterId, startMarker, endMarker } = afterData;
    if (!pdfChapterId || typeof startMarker !== "number" || typeof endMarker !== "number") {
      logger.warn(`Missing or invalid pdfChapterId/startMarker/endMarker in doc ${subChapterId}.`);
      return;
    }

    // (B) Fetch parent pdfChapters doc to find pdfDocId
    const db = admin.firestore();
    const chapterRef = db.collection("pdfChapters").doc(pdfChapterId);
    const chapterSnap = await chapterRef.get();
    if (!chapterSnap.exists) {
      logger.warn(`No pdfChapters doc found for docId=${pdfChapterId}. Cannot proceed.`);
      return;
    }
    const chapterData = chapterSnap.data() || {};
    const pdfDocId = chapterData.pdfDocId;
    if (!pdfDocId) {
      logger.warn(`pdfChapter=${pdfChapterId} has no pdfDocId. Cannot query pdfPages.`);
      return;
    }

    // (C) Identify previous & next page
    // Example logic: if startMarker=5 => prevPage=4, nextPage=endMarker+1
    const prevPage = startMarker > 1 ? startMarker - 1 : null;
    const nextPage = endMarker + 1; // Could check if it doesn't exceed total page count

    // (D) Fetch text from the relevant pages in `pdfPages`

    // Helper function to fetch an array of pages in the range [start..end]
    async function fetchPagesInRange(docId, start, end) {
      const snap = await db
        .collection("pdfPages")
        .where("pdfDocId", "==", docId)
        .where("pageNumber", ">=", start)
        .where("pageNumber", "<=", end)
        .orderBy("pageNumber", "asc")
        .get();

      if (snap.empty) return "";
      let combined = "";
      snap.forEach((pDoc) => {
        const pData = pDoc.data() || {};
        combined += `\nPage ${pData.pageNumber}:\n${pData.text}\n`;
      });
      return combined.trim();
    }

    // 1) Sub-chapter pages (the core content)
    const coreText = newText.trim(); // we already have it in fullText, but you could re-fetch if you wish

    // 2) Previous page
    let prevContext = "";
    if (prevPage) {
      prevContext = await fetchPagesInRange(pdfDocId, prevPage, prevPage);
    }

    // 3) Next page
    // Could check if nextPage doesn't exceed the total # of pages in pdfDoc, 
    // but for now we'll just do it blindly:
    let nextContext = "";
    if (nextPage) {
      const nextSnap = await db
        .collection("pdfPages")
        .where("pdfDocId", "==", pdfDocId)
        .where("pageNumber", "==", nextPage)
        .limit(1)
        .get();
      if (!nextSnap.empty) {
        nextContext = "";
        nextSnap.forEach((pDoc) => {
          const pData = pDoc.data() || {};
          nextContext += `\nPage ${pData.pageNumber}:\n${pData.text}\n`;
        });
      }
    }

    // (E) Build GPT prompt
    const openAiKey = process.env.OPENAI_API_KEY;
    if (!openAiKey) throw new Error("OPENAI_API_KEY not set!");
    const configuration = new Configuration({ apiKey: openAiKey });
    const openai = new OpenAIApi(configuration);

    const prompt = `
You are helping build an educational app that segments books into sub-chapters. 
We have a sub-chapter spanning pages ${startMarker} to ${endMarker} (the "core" content). 
We also provide the previous page and next page as context, 
because some sentences might cross page boundaries. 
Your job: 
- Rewrite the sub-chapter content (pages ${startMarker}-${endMarker} only) 
- Use the context from the previous/next pages to make transitions smooth
  (i.e., no abrupt starts or endings).
- Keep the approximate word count close to the original sub-chapter. 
- Do NOT add or blend text from the previous or next page into the final sub-chapter. 
  They are only for context to avoid cutting off sentences abruptly.
- Remove any leftover references to page numbers or "Page X" lines.
- Return only the updated sub-chapter text. Do not add headings or JSON.

## CONTEXT
[PREVIOUS PAGE CONTENT if any]
${prevContext}

[SUB-CHAPTER PAGES ${startMarker}..${endMarker} - original text]
${coreText}

[NEXT PAGE CONTENT if any]
${nextContext}

## INSTRUCTIONS
Rewrite the sub-chapter content into one cohesive block, removing abrupt starts or stops. 
Maintain the original meaning and style as closely as possible, 
but ensure it feels like a single continuous passage in an educational text.
`.trim();

    logger.info(`Sending sub-chapter text for docId=${subChapterId} to GPT with context.`);

    const completion = await openai.createChatCompletion({
      model: "gpt-4o-mini", // or "gpt-3.5-turbo"
      messages: [
        { role: "system", content: "You are a helpful rewriting assistant." },
        { role: "user", content: prompt },
      ],
      temperature: 0.7,
    });

    const gptOutput = completion.data.choices[0].message.content.trim() || "";
    logger.info(`GPT repurposed subchapter length = ${gptOutput.length}`);

    // (F) Store the final text in `fullTextFinal`
    await event.data.after.ref.update({
      fullTextFinal: gptOutput,
      repurposeContextAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    logger.info(
      `Wrote "fullTextFinal" to subChapter doc ${subChapterId} after integrating context from pages ${prevPage} & ${nextPage}.`
    );
  } catch (err) {
    logger.error("Error in repurposeSubChapterWithContext:", err);
  }
});

/**
 * --------------------------------------------------------------------------------------
 * updateSubChaptersDemoOnUpdate
 *
 * Trigger Type:
 *   - onDocumentUpdated("pdfSubChapters/{subChapterId}")
 *     => Fires whenever a doc in "pdfSubChapters" is updated.
 *
 * Activation Condition:
 *   - Specifically checks if "fullTextFinal" changed. If so, we proceed.
 *
 * Brief Summary:
 *   1) Reads the newly updated "fullTextFinal" from pdfSubChapters.
 *   2) Computes the word count of that final text.
 *   3) Updates the corresponding doc in "subchapters_demo" (by the same subChapterId)
 *      with:
 *         summary (the final text)
 *         wordCount
 *
 * Where Data Is Written:
 *   - "subchapters_demo/{subChapterId}" is updated with:
 *       summary, wordCount
 * --------------------------------------------------------------------------------------
 */

function getWordCount(text = "") {
  // Trim the text, split by any sequence of whitespace, and filter out empty strings
  const words = text.trim().split(/\s+/).filter(Boolean);
  return words.length;
}

exports.updateSubChaptersDemoOnUpdate = onDocumentUpdated(
  "pdfSubChapters/{subChapterId}",
  async (event) => {
    try {
      const beforeSnap = event.data.before;
      const afterSnap = event.data.after;
      if (!beforeSnap.exists || !afterSnap.exists) return;

      const beforeData = beforeSnap.data() || {};
      const afterData = afterSnap.data() || {};

      // If 'fullTextFinal' did not change, do nothing
      if (beforeData.fullTextFinal === afterData.fullTextFinal) {
        return;
      }

      const newSummary = afterData.fullTextFinal || "";
      const subChapterId = event.params.subChapterId;

      // =========================
      //   1) Compute Word Count
      // =========================
      const wordCount = getWordCount(newSummary);

      // =========================
      //   2) Update Firestore
      // =========================
      const db = admin.firestore();
      const subDemoRef = db.collection("subchapters_demo").doc(subChapterId);
      await subDemoRef.update({
        summary: newSummary,  // store the full text
        wordCount: wordCount, // store the computed word count
      });

      console.log(
        `Updated subchapters_demo/${subChapterId} with new summary & wordCount=${wordCount}.`
      );
    } catch (error) {
      console.error("Error in updateSubChaptersDemoOnUpdate:", error);
    }
  }
);





const db = admin.firestore(); // Assuming you've already initialized admin



/**
 * --------------------------------------------------------------------------------------
 * getActivitiesForSub
 *
 * Purpose:
 *   - Generates an array of learning "activities" (READ, QUIZ, REVISE) for a subchapter,
 *     based on its proficiency and word count.
 *
 * Parameters:
 *   - sub (object): A subchapter object, expected to have fields:
 *       id            (unique ID)
 *       wordCount     (number of words)
 *       proficiency   (e.g. "unread", "read", or "proficient")
 *   - wpm, quizTime, reviseTime (numeric overrides)
 *
 * Logic:
 *   1) If proficiency is "unread", we add a READ activity with time = wordCount / wpm.
 *   2) If proficiency is "unread" or "read", we add a QUIZ activity (time=quizTime).
 *   3) If proficiency is "unread", "read", or "proficient", we add a REVISE activity (time=reviseTime).
 *
 * Returns:
 *   - An array of objects (activities), each containing:
 *       subChapterId, type (READ/QUIZ/REVISE), and timeNeeded
 *
 * Example:
 *   getActivitiesForSub(
 *     { id: "abc", wordCount: 1000, proficiency: "unread" },
 *     { wpm: 200, quizTime: 5, reviseTime: 5 }
 *   )
 *   => [
 *        { subChapterId: "abc", type: "READ", timeNeeded: 5 },
 *        { subChapterId: "abc", type: "QUIZ", timeNeeded: 5 },
 *        { subChapterId: "abc", type: "REVISE", timeNeeded: 5 }
 *      ]
 * --------------------------------------------------------------------------------------
 */


function getActivitiesForSub(sub, { wpm, quizTime, reviseTime }) {
  const activities = [];
  const proficiency = sub.proficiency || "unread";
  
  // READ 
  if (proficiency === "unread") {
    const wordCount = sub.wordCount || 0;
    const minutesNeeded = wordCount > 0 ? Math.ceil(wordCount / wpm) : 0;
    activities.push({
      subChapterId: sub.id,
      type: "READ",
      timeNeeded: minutesNeeded,
    });
  }

  // QUIZ
  if (proficiency === "unread" || proficiency === "read") {
    activities.push({
      subChapterId: sub.id,
      type: "QUIZ",
      timeNeeded: quizTime, // use the override
    });
  }

  // REVISE
  if (proficiency === "unread" || proficiency === "read" || proficiency === "proficient") {
    activities.push({
      subChapterId: sub.id,
      type: "REVISE",
      timeNeeded: reviseTime, // use the override
    });
  }

  return activities;
}


/**
 * --------------------------------------------------------------------------------------
 * generateAdaptivePlan (onRequest)
 *
 * Trigger Type:
 *   - onRequest(async (req, res))
 *     => This is an HTTPS callable function, typically accessed via a URL.
 *
 * Brief Summary:
 *   1) Reads user inputs (userId, targetDate, optional overrides like wpm, dailyReadingTime).
 *   2) Fetches the user's "learnerPersona" doc to get defaults (wpm, dailyReadingTime).
 *   3) Retrieves all books from "books_demo" (or a subset if selectedBooks provided).
 *   4) For each book, retrieves chapters ("chapters_demo"), then subchapters ("subchapters_demo").
 *   5) Builds a list of "activities" (READ, QUIZ, REVISE) per subchapter, factoring in
 *      proficiency, wordCount, quizTime, and reviseTime.
 *   6) Distributes these activities into day-based "sessions," ensuring daily time
 *      doesn't exceed the user's reading limit.
 *   7) Writes a final "planDoc" to "adaptive_demo," containing all sessions.
 *
 * Where Data Is Written:
 *   - "adaptive_demo" collection:
 *       A single doc containing:
 *         createdAt, planName, userId, targetDate, sessions[],
 *         maxDayCount, wpmUsed, dailyReadingTimeUsed, level, etc.
 *
 * Return (HTTP Response):
 *   - JSON including:
 *       { message, planId, planDoc }
 *     indicating success and referencing the newly created plan document.
 *
 * --------------------------------------------------------------------------------------
 */

exports.generateAdaptivePlan = onRequest(async (req, res) => {
  // ---------------- CORS HEADERS ----------------
  res.set("Access-Control-Allow-Origin", "*"); // or restrict to your domain
  res.set("Access-Control-Allow-Headers", "Content-Type,Authorization");
  res.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");

  // Handle preflight
  if (req.method === "OPTIONS") {
    return res.status(204).send("");
  }

  try {
    // ---------------------------------------------------------
    // A) Basic Required Input
    // ---------------------------------------------------------
    const userId = req.query.userId || req.body.userId;
    if (!userId) {
      return res.status(400).json({
        error: "Missing userId in request (req.query or req.body).",
      });
    }

    const targetDateStr = req.query.targetDate || req.body.targetDate;
    if (!targetDateStr) {
      return res.status(400).json({
        error: "Missing targetDate in request (req.query or req.body).",
      });
    }

    const targetDate = new Date(targetDateStr);
    if (isNaN(targetDate.getTime())) {
      return res.status(400).json({
        error: "Invalid targetDate format. Use something like '2025-07-20'.",
      });
    }

    // Current date => used to default maxDayCount
    const today = new Date();
    let defaultMaxDayCount = getDaysBetween(today, targetDate);
    if (defaultMaxDayCount < 0) defaultMaxDayCount = 0;

    // ---------------------------------------------------------
    // B) Optional Overrides
    // ---------------------------------------------------------
    const maxDaysOverride =
      req.body.maxDays !== undefined ? Number(req.body.maxDays) : null;
    const wpmOverride =
      req.body.wpm !== undefined ? Number(req.body.wpm) : null;
    const dailyReadingTimeOverride =
      req.body.dailyReadingTime !== undefined
        ? Number(req.body.dailyReadingTime)
        : null;

    const quizTimeOverride =
      req.body.quizTime !== undefined ? Number(req.body.quizTime) : 1;
    const reviseTimeOverride =
      req.body.reviseTime !== undefined ? Number(req.body.reviseTime) : 1;

    // If not provided, default to "revision" or any string you prefer.
    const level = req.body.level || "revision";

    // optional arrays for filtering
    const selectedBooks = Array.isArray(req.body.selectedBooks)
      ? req.body.selectedBooks
      : null;
    const selectedChapters = Array.isArray(req.body.selectedChapters)
      ? req.body.selectedChapters
      : null;
    const selectedSubChapters = Array.isArray(req.body.selectedSubChapters)
      ? req.body.selectedSubChapters
      : null;

    // If the front-end is sending just a single `bookId` instead of `selectedBooks`,
    // we can read it here:
    const singleBookIdFromBody = req.body.bookId || "";

    // ---------------------------------------------------------
    // C) Fetch Persona for default wpm/dailyReadingTime
    // ---------------------------------------------------------
    const personaSnap = await db
      .collection("learnerPersonas")
      .where("userId", "==", userId)
      .limit(1)
      .get();
    if (personaSnap.empty) {
      return res.status(404).json({
        error: `No learner persona found for userId: ${userId}`,
      });
    }
    const personaData = personaSnap.docs[0].data() || {};
    if (!personaData.wpm || !personaData.dailyReadingTime) {
      return res.status(400).json({
        error:
          "Persona document must contain 'wpm' and 'dailyReadingTime' fields.",
      });
    }

    // Final wpm/dailyTime
    const finalWpm = wpmOverride || personaData.wpm;
    const finalDailyReadingTime =
      dailyReadingTimeOverride || personaData.dailyReadingTime;

    // maxDayCount
    let maxDayCount =
      maxDaysOverride !== null ? maxDaysOverride : defaultMaxDayCount;

    // ---------------------------------------------------------
    // D) Fetch Books
    // ---------------------------------------------------------
    let booksSnap;
    // If front-end didn't pass an array in selectedBooks but did pass a single bookId,
    // we can manually build an array. 
    let arrayOfBookIds = [];
    if (selectedBooks && selectedBooks.length > 0) {
      arrayOfBookIds = selectedBooks;
    } else if (singleBookIdFromBody) {
      // wrap the single string in an array
      arrayOfBookIds = [singleBookIdFromBody];
    }

    if (arrayOfBookIds.length > 0) {
      // Only fetch these book doc IDs
      booksSnap = await db
        .collection("books_demo")
        .where(admin.firestore.FieldPath.documentId(), "in", arrayOfBookIds)
        .get();
    } else {
      // otherwise fetch all
      booksSnap = await db.collection("books_demo").get();
    }

    const booksData = [];
    for (const bookDoc of booksSnap.docs) {
      const bookId = bookDoc.id;
      const book = {
        id: bookId,
        ...bookDoc.data(),
      };

      // -------------------------------------------------------
      // E) Fetch Chapters for this book
      // -------------------------------------------------------
      let chaptersSnap;
      if (selectedChapters && selectedChapters.length > 0) {
        chaptersSnap = await db
          .collection("chapters_demo")
          .where("bookId", "==", bookId)
          .where(admin.firestore.FieldPath.documentId(), "in", selectedChapters)
          .get();
      } else {
        chaptersSnap = await db
          .collection("chapters_demo")
          .where("bookId", "==", bookId)
          .get();
      }

      const chaptersData = [];
      for (const chapterDoc of chaptersSnap.docs) {
        const chapterId = chapterDoc.id;
        const chapter = {
          id: chapterId,
          ...chapterDoc.data(),
        };

        // -----------------------------------------------------
        // F) Fetch Subchapters for this chapter
        // -----------------------------------------------------
        let subSnap;
        if (selectedSubChapters && selectedSubChapters.length > 0) {
          subSnap = await db
            .collection("subchapters_demo")
            .where("chapterId", "==", chapterId)
            .where(
              admin.firestore.FieldPath.documentId(),
              "in",
              selectedSubChapters
            )
            .get();
        } else {
          subSnap = await db
            .collection("subchapters_demo")
            .where("chapterId", "==", chapterId)
            .get();
        }

        const subData = subSnap.docs.map((d) => ({
          id: d.id,
          ...d.data(),
        }));

        // sort subchapters
        chapter.subchapters = sortByNameWithNumericAware(subData);
        chaptersData.push(chapter);
      }

      // sort chapters
      book.chapters = sortByNameWithNumericAware(chaptersData);
      booksData.push(book);
    }

    // ---------------------------------------------------------
    // G) Build a Single Ordered Array of Activities
    // ---------------------------------------------------------
    const allActivities = [];
    for (const book of booksData) {
      if (!book.chapters) continue;
      for (const chapter of book.chapters) {
        if (!chapter.subchapters) continue;
        for (const sub of chapter.subchapters) {
          // generate sub-activities (READ, QUIZ, REVISE)
          const subActivities = getActivitiesForSub(sub, {
            wpm: finalWpm,
            quizTime: quizTimeOverride,
            reviseTime: reviseTimeOverride,
          });
          // attach the "level", plus book and chapter info
          for (const activity of subActivities) {
            allActivities.push({
              ...activity,
              level,                    // <--- the new field
              bookId: book.id,
              bookName: book.name || "",
              chapterId: chapter.id,
              chapterName: chapter.name || "",
              subChapterName: sub.name || "",
            });
          }
        }
      }
    }

    // ---------------------------------------------------------
    // H) Distribute into Sessions (Day X)
    // ---------------------------------------------------------
    const dailyTimeMins = finalDailyReadingTime;
    let dayIndex = 1;
    let currentDayTime = 0;
    let currentDayActivities = [];
    const sessions = [];

    function pushCurrentDay() {
      if (currentDayActivities.length > 0) {
        sessions.push({
          sessionLabel: dayIndex.toString(),
          activities: [...currentDayActivities],
        });
        dayIndex += 1;
        currentDayTime = 0;
        currentDayActivities = [];
      }
    }

    for (const activity of allActivities) {
      if (dayIndex > maxDayCount && maxDayCount > 0) {
        // Option 1: break;
        // Option 2: keep scheduling
      }

      if (
        currentDayTime + activity.timeNeeded > dailyTimeMins &&
        currentDayTime > 0
      ) {
        pushCurrentDay();
      }

      currentDayActivities.push(activity);
      currentDayTime += activity.timeNeeded;
    }

    if (currentDayActivities.length > 0) {
      pushCurrentDay();
    }

    // ---------------------------------------------------------
    // I) Write Plan to Firestore
    // ---------------------------------------------------------
    // We'll figure out a singleBookId from whichever approach was used
    // (bookId in the body OR the first element of selectedBooks).
    let singleBookId = "";
    // If the user sent `bookId` in the body, we already have singleBookIdFromBody
    if (singleBookIdFromBody) {
      singleBookId = singleBookIdFromBody;
    }
    // Otherwise, if they used selectedBooks: [...]
    else if (selectedBooks && selectedBooks.length > 0) {
      singleBookId = selectedBooks[0];
    }

    const planDoc = {
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      planName: `Adaptive Plan for User ${userId}`,
      userId,
      targetDate: targetDateStr,
      sessions,
      maxDayCount,
      wpmUsed: finalWpm,
      dailyReadingTimeUsed: finalDailyReadingTime,
      level,
      bookId: singleBookId, // store one single ID
    };

    const newRef = await db.collection("adaptive_demo").add(planDoc);

    // ---------------------------------------------------------
    // J) Return Success
    // ---------------------------------------------------------
    return res.status(200).json({
      message: "Successfully generated an adaptive plan in 'adaptive_demo'.",
      planId: newRef.id,
      planDoc,
    });
  } catch (error) {
    logger.error("Error generating adaptive plan", error);
    return res.status(500).json({ error: error.message });
  }
});

/**
 * --------------------------------------------------------------------------------------
 * generatePlanStats
 *
 * Trigger Type:
 *   - onDocumentCreated({ document: "adaptive_demo/{planId}" })
 *     => Fires whenever a new document is created in the "adaptive_demo" collection.
 *
 * Brief Summary:
 *   1) Reads the newly created plan document (which contains an array of sessions[]).
 *   2) Iterates over each session, summing up times for READ, QUIZ, REVISE, etc.
 *   3) Computes day-by-day stats (readingTime, quizTime, reviseTime, totalTime).
 *   4) Computes overall summaries (totalDays, overallTime, totalReadingTime, etc.).
 *   5) Writes a corresponding stats doc into "adaptive_demo_stats" using the same planId.
 *
 * Where Data Is Written:
 *   - "adaptive_demo_stats/{planId}" (new doc), storing:
 *       planId, createdAt, totalDays, overallTime,
 *       totalReadingTime, totalQuizTime, totalReviseTime, dayStats (array)
 *
 * --------------------------------------------------------------------------------------
 */

exports.generatePlanStats = onDocumentCreated({
  document: "adaptive_demo/{planId}"
}, async (event) => {
  try {
    const doc = event.data;
    if (!doc) {
      logger.error("No document data in onDocumentCreated trigger.");
      return;
    }

    const planData = doc.data();
    if (!planData.sessions || !Array.isArray(planData.sessions)) {
      logger.error("No 'sessions' array found in the new plan document.");
      return;
    }

    // We'll compute:
    // 1) totalDays (simply planData.sessions.length)
    // 2) dayStats = array of daily breakdown
    //    each dayStats[i] => { dayIndex, totalTime, readingTime, quizTime, reviseTime }
    // 3) any other aggregates you want

    const dayStats = [];
    let totalDays = planData.sessions.length;

    for (let i = 0; i < totalDays; i++) {
      const daySession = planData.sessions[i];
      const activities = daySession.activities || [];

      let readingTime = 0;
      let quizTime = 0;
      let reviseTime = 0;
      let otherTime = 0; // if you have other activity types in future

      // Sum up times by type
      for (const activity of activities) {
        const time = activity.timeNeeded || 0;
        if (activity.type === "READ") {
          readingTime += time;
        } else if (activity.type === "QUIZ") {
          quizTime += time;
        } else if (activity.type === "REVISE") {
          reviseTime += time;
        } else {
          otherTime += time;
        }
      }

      const totalTime = readingTime + quizTime + reviseTime + otherTime;

      dayStats.push({
        dayIndex: daySession.sessionLabel, // or parseInt if you prefer a number
        totalTime,
        readingTime,
        quizTime,
        reviseTime,
      });
    }

    // Summaries
    const totalReadingTime = dayStats.reduce((sum, ds) => sum + ds.readingTime, 0);
    const totalQuizTime = dayStats.reduce((sum, ds) => sum + ds.quizTime, 0);
    const totalReviseTime = dayStats.reduce((sum, ds) => sum + ds.reviseTime, 0);
    const overallTime = totalReadingTime + totalQuizTime + totalReviseTime;

    // Create a stats doc in "adaptive_demo_stats" 
    // We can reuse the same planId from the path param or create a new random doc ID
    const planId = event.params.planId; // from {planId} in the path
    const statsDocRef = db.collection("adaptive_demo_stats").doc(planId);

    const statsPayload = {
      planId,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      totalDays,
      overallTime,
      totalReadingTime,
      totalQuizTime,
      totalReviseTime,
      dayStats
    };

    await statsDocRef.set(statsPayload);

    logger.info(`Stats generated for planId: ${planId}`, statsPayload);
  } catch (error) {
    logger.error("Error in generatePlanStats trigger:", error);
  }
});


/**
 * --------------------------------------------------------------------------------------
 * parseLeadingSections
 *
 * Purpose:
 *   - Parses the leading sections of a string (split by ".") and converts each part to an integer,
 *     stopping once a part is not a number.
 *   - Used to identify numeric prefixes like "1.2.3" from a name ("1.2.3 Some Title").
 *
 * Returns:
 *   - An array of numeric values, e.g. [1, 2, 3].
 *   - If no numeric prefix is found, returns [Infinity], which is used in sorting logic.
 * --------------------------------------------------------------------------------------
 */

function parseLeadingSections(str) {
  const parts = str.split(".").map((p) => p.trim());
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


/**
 * --------------------------------------------------------------------------------------
 * compareSections
 *
 * Purpose:
 *   - Compares two arrays of numeric sections (like [1,2,3] vs. [1,2,5]) to decide which
 *     should come first in sorted order.
 *   - If all compared sections match, returns 0 (tie).
 *   - If one differs, returns the difference (aVal - bVal).
 *
 * Returns:
 *   - A negative, zero, or positive number for sorting logic.
 * --------------------------------------------------------------------------------------
 */

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


/**
 * --------------------------------------------------------------------------------------
 * sortByNameWithNumericAware
 *
 * Purpose:
 *   - Sorts an array of items by their "name" field in a way that handles leading numeric
 *     sections properly, so "10.2 Something" doesn't come before "2.1 Something".
 *   - First uses parseLeadingSections + compareSections for numeric prefixes,
 *     then falls back to a normal localeCompare if needed.
 *
 * Returns:
 *   - The same array of items, sorted in place by name with numeric-aware ordering.
 * --------------------------------------------------------------------------------------
 */

function sortByNameWithNumericAware(items) {
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


/**
 * --------------------------------------------------------------------------------------
 * getAlwaysAllActivities
 *
 * Purpose:
 *   - Generates an array of [READ, QUIZ, REVISE] activities for a subchapter, ignoring
 *     proficiency. This always adds all three activity types.
 *
 * Parameters:
 *   - subchapter: An object with fields (id, name, wordCount, bookId, chapterId, etc.)
 *   - wpm: Words per minute (numeric).
 *
 * Returns:
 *   - An array of activities, each object containing:
 *       type (READ, QUIZ, REVISE),
 *       timeNeeded (READ = wordCount/wpm, QUIZ=1, REVISE=1),
 *       subChapterId, bookId, chapterId, subChapterName, etc.
 * --------------------------------------------------------------------------------------
 */

function getAlwaysAllActivities(subchapter, wpm) {
  const wordCount = subchapter.wordCount || 0;
  const readTime = wordCount > 0 ? Math.ceil(wordCount / wpm) : 0;

  return [
    {
      type: "READ",
      timeNeeded: readTime,
      bookId: subchapter.bookId,
      chapterId: subchapter.chapterId,
      subChapterId: subchapter.id,
      subChapterName: subchapter.name || "",
    },
    {
      type: "QUIZ",
      timeNeeded: 1,
      bookId: subchapter.bookId,
      chapterId: subchapter.chapterId,
      subChapterId: subchapter.id,
      subChapterName: subchapter.name || "",
    },
    {
      type: "REVISE",
      timeNeeded: 1,
      bookId: subchapter.bookId,
      chapterId: subchapter.chapterId,
      subChapterId: subchapter.id,
      subChapterName: subchapter.name || "",
    },
  ];
}

/**
 * --------------------------------------------------------------------------------------
 * getDaysBetween
 *
 * Purpose:
 *   - Calculates the number of days between two Date objects, rounding up.
 *   - For example, if startDate=2025-07-01 and endDate=2025-07-04, returns 3 or 4
 *     depending on the inclusive or exclusive logic. In this code, it typically returns 3
 *     if the difference is 3.1 days, we do Math.ceil for partial days.
 *
 * Returns:
 *   - The integer number of days (ceiling).
 * --------------------------------------------------------------------------------------
 */

function getDaysBetween(startDate, endDate) {
  const msInDay = 24 * 60 * 60 * 1000;
  return Math.ceil((endDate - startDate) / msInDay);
}




/**
 * --------------------------------------------------------------------------------------
 * generateBookPlan (onRequest)
 *
 * Trigger Type:
 *   - onRequest(async (req, res))
 *     => An HTTPS endpoint typically called by a client.
 *
 * Brief Summary:
 *   1) Reads user inputs (userId, targetDate, optional overrides like wpm, dailyReadingTime).
 *   2) Fetches the user's "learnerPersona" doc to get default wpm/dailyReadingTime if overrides
 *      aren’t provided.
 *   3) Retrieves books from "books_demo" (or a subset if selectedBooks is passed).
 *   4) For each book, gathers chapters ("chapters_demo") and subchapters ("subchapters_demo"),
 *      possibly filtered if selectedChapters / selectedSubChapters are given.
 *   5) Builds an array of activities for each subchapter (READ, QUIZ, REVISE), factoring
 *      in the user’s reading speed and quiz/revise times.
 *   6) Unlike the day-based plan, here we create one "session" per book, with all
 *      subchapter activities for that book.
 *   7) Writes the final plan doc to "adaptive_books", storing metadata like planName,
 *      targetDate, sessions[] (one session per book), etc.
 *
 * Where Data Is Written:
 *   - "adaptive_books" collection:
 *       A new doc with fields like:
 *         createdAt, planName, userId, targetDate, sessions[], maxDayCount,
 *         wpmUsed, dailyReadingTimeUsed, level, etc.
 *
 * Return (HTTP Response):
 *   - JSON containing:
 *       { message, planId, planDoc }
 *     indicating success and referencing the newly created doc in "adaptive_books".
 *
 * --------------------------------------------------------------------------------------
 */


exports.generateBookPlan = onRequest(async (req, res) => {
  // ---------------- CORS HEADERS (Optional, if needed) ----------------
  // If you need the same CORS approach as generateAdaptivePlan, uncomment:
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Headers", "Content-Type,Authorization");
  res.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  //
  // // Handle preflight
   if (req.method === "OPTIONS") {
   return res.status(204).send("");
  }

  try {
    // ---------------------------------------------------------
    // A) Basic Required Input
    // ---------------------------------------------------------
    const userId = req.query.userId || req.body.userId;
    if (!userId) {
      return res.status(400).json({
        error: "Missing userId in request (req.query or req.body).",
      });
    }

    const targetDateStr = req.query.targetDate || req.body.targetDate;
    if (!targetDateStr) {
      return res.status(400).json({
        error: "Missing targetDate in request (req.query or req.body).",
      });
    }

    const targetDate = new Date(targetDateStr);
    if (isNaN(targetDate.getTime())) {
      return res.status(400).json({
        error: "Invalid targetDate format. Use something like '2025-07-20'.",
      });
    }

    // ---------------------------------------------------------
    // B) Calculate default maxDayCount from today's date
    // ---------------------------------------------------------
    const today = new Date();
    let defaultMaxDayCount = getDaysBetween(today, targetDate);
    if (defaultMaxDayCount < 0) defaultMaxDayCount = 0;

    // ---------------------------------------------------------
    // C) Optional Overrides
    // ---------------------------------------------------------
    const maxDaysOverride =
      req.body.maxDays !== undefined ? Number(req.body.maxDays) : null;
    const wpmOverride = req.body.wpm !== undefined ? Number(req.body.wpm) : null;
    const dailyReadingTimeOverride =
      req.body.dailyReadingTime !== undefined
        ? Number(req.body.dailyReadingTime)
        : null;

    const quizTimeOverride =
      req.body.quizTime !== undefined ? Number(req.body.quizTime) : 1;
    const reviseTimeOverride =
      req.body.reviseTime !== undefined ? Number(req.body.reviseTime) : 1;

    // You can store a “level” if you like (e.g. “mastery”, “revision”)
    const level = req.body.level || "revision";

    // Optional arrays for filtering
    const selectedBooks = Array.isArray(req.body.selectedBooks)
      ? req.body.selectedBooks
      : null;
    const selectedChapters = Array.isArray(req.body.selectedChapters)
      ? req.body.selectedChapters
      : null;
    const selectedSubChapters = Array.isArray(req.body.selectedSubChapters)
      ? req.body.selectedSubChapters
      : null;

    // Final maxDayCount
    let maxDayCount =
      maxDaysOverride !== null ? maxDaysOverride : defaultMaxDayCount;

    // ---------------------------------------------------------
    // D) Fetch Learner Persona to get default WPM, reading time
    // ---------------------------------------------------------
    const db = admin.firestore();
    const personaSnap = await db
      .collection("learnerPersonas")
      .where("userId", "==", userId)
      .limit(1)
      .get();

    if (personaSnap.empty) {
      return res.status(404).json({
        error: `No learner persona found for userId: ${userId}`,
      });
    }

    const personaData = personaSnap.docs[0].data() || {};
    if (!personaData.wpm || !personaData.dailyReadingTime) {
      return res.status(400).json({
        error:
          "Persona document must contain 'wpm' and 'dailyReadingTime' fields.",
      });
    }

    // Final WPM and daily reading time
    const finalWpm = wpmOverride || personaData.wpm;
    const finalDailyReadingTime =
      dailyReadingTimeOverride || personaData.dailyReadingTime;

    // ---------------------------------------------------------
    // E) Fetch Books (filtered if selectedBooks is provided)
    // ---------------------------------------------------------
    let booksSnap;
    if (selectedBooks && selectedBooks.length > 0) {
      booksSnap = await db
        .collection("books_demo")
        .where(admin.firestore.FieldPath.documentId(), "in", selectedBooks)
        .get();
    } else {
      booksSnap = await db.collection("books_demo").get();
    }

    // Prepare array of books with nested chapters/subchapters
    const booksData = [];
    for (const bookDoc of booksSnap.docs) {
      const bookId = bookDoc.id;
      const book = {
        id: bookId,
        ...bookDoc.data(),
      };

      // -------------------------------------------------------
      // F) Fetch Chapters (filtered if selectedChapters)
      // -------------------------------------------------------
      let chaptersSnap;
      if (selectedChapters && selectedChapters.length > 0) {
        chaptersSnap = await db
          .collection("chapters_demo")
          .where("bookId", "==", bookId)
          .where(admin.firestore.FieldPath.documentId(), "in", selectedChapters)
          .get();
      } else {
        chaptersSnap = await db
          .collection("chapters_demo")
          .where("bookId", "==", bookId)
          .get();
      }

      const chaptersData = [];
      for (const chapterDoc of chaptersSnap.docs) {
        const chapterId = chapterDoc.id;
        const chapter = {
          id: chapterId,
          ...chapterDoc.data(),
        };

        // -----------------------------------------------------
        // G) Fetch Subchapters (filtered if selectedSubChapters)
        // -----------------------------------------------------
        let subSnap;
        if (selectedSubChapters && selectedSubChapters.length > 0) {
          subSnap = await db
            .collection("subchapters_demo")
            .where("chapterId", "==", chapterId)
            .where(
              admin.firestore.FieldPath.documentId(),
              "in",
              selectedSubChapters
            )
            .get();
        } else {
          subSnap = await db
            .collection("subchapters_demo")
            .where("chapterId", "==", chapterId)
            .get();
        }

        // Build subchapter array + sort
        const subData = subSnap.docs.map((d) => ({
          id: d.id,
          ...d.data(),
        }));
        const sortedSubs = sortByNameWithNumericAware(subData);

        chapter.subchapters = sortedSubs;
        chaptersData.push(chapter);
      }

      // Sort chapters
      book.chapters = sortByNameWithNumericAware(chaptersData);
      booksData.push(book);
    }

    // ---------------------------------------------------------
    // H) Build "sessions" => 1 book per session
    // ---------------------------------------------------------
    const sessions = [];
    let sessionCounter = 1;

    for (const book of booksData) {
      const bookName = book.name || `Book ${book.id}`;

      // Step 1: Build an array of all subchapter-based activities
      const allActivities = [];

      if (book.chapters) {
        for (const chapter of book.chapters) {
          if (!chapter.subchapters) continue;

          for (const sub of chapter.subchapters) {
            // Generate sub-activities [READ, QUIZ, REVISE] or whatever you prefer
            const subActivities = getActivitiesForSub(sub, {
              wpm: finalWpm,
              quizTime: quizTimeOverride,
              reviseTime: reviseTimeOverride,
            });

            // Attach additional metadata if you like
            for (const activity of subActivities) {
              allActivities.push({
                ...activity,
                level, // the “level” override
                bookId: book.id,
                bookName,
                chapterId: chapter.id,
                chapterName: chapter.name || "",
                subChapterName: sub.name || "",
              });
            }
          }
        }
      }

      // Step 2: Create a single session with all subchapter activities for this book
      sessions.push({
        sessionLabel: sessionCounter.toString(), // e.g. "1", "2", ...
        activities: allActivities,
      });

      sessionCounter++;
    }

    // ---------------------------------------------------------
    // I) Write Plan to Firestore
    // ---------------------------------------------------------
    const planDoc = {
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      planName: `Book Plan for User ${userId}`,
      userId,
      targetDate: targetDateStr,
      sessions,
      maxDayCount, // We store it even if we don’t necessarily do day-based distribution
      wpmUsed: finalWpm,
      dailyReadingTimeUsed: finalDailyReadingTime,
      level, // optional
    };

    const newRef = await db.collection("adaptive_books").add(planDoc);

    // ---------------------------------------------------------
    // J) Return the plan
    // ---------------------------------------------------------
    return res.status(200).json({
      message: "Successfully generated a book-based plan (1 book = 1 session) in 'adaptive_books'.",
      planId: newRef.id,
      planDoc,
    });
  } catch (error) {
    logger.error("Error generating book-based plan", error);
    return res.status(500).json({ error: error.message });
  }
});