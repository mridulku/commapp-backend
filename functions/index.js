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
    const bucketName = object.bucket;
    const filePath = object.name;
    const contentType = object.contentType;

    if (!contentType || !contentType.includes("pdf")) {
      logger.info("Not a PDF. Skipping.");
      return;
    }

    logger.info(`PDF detected at path: ${filePath}`);

    const tempFilePath = path.join("/tmp", path.basename(filePath));
    await storage.bucket(bucketName).file(filePath).download({ destination: tempFilePath });
    logger.info(`PDF downloaded locally to ${tempFilePath}`);

    const dataBuffer = fs.readFileSync(tempFilePath);
    const parsed = await pdfParse(dataBuffer);
    const rawText = parsed.text;
    logger.info(`Parsed PDF text length: ${rawText.length}`);

    const db = admin.firestore();
    await db.collection("pdfExtracts").add({
      filePath,
      text: rawText,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    logger.info("Stored PDF text in Firestore (pdfExtracts).");
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

Do NOT include any additional commentary outside the JSON. Only return valid JSON so I can parse it.

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