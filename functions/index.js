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

    // 4) Store GPT JSON in "pdfSummaries"
    await db.collection("pdfSummaries").add({
      pdfDocId, // reference to pdfExtracts
      summary: gptJson,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    logger.info(`Stored JSON summary in pdfSummaries for pdfDocId=${pdfDocId}.`);
  } catch (error) {
    logger.error("Error in addMarkersAndSummarize:", error);
  }
});
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

    // 2) Get the pdfExtracts doc to find courseName, etc.
    const pdfExtractDoc = await db.collection("pdfExtracts").doc(pdfDocId).get();
    if (!pdfExtractDoc.exists) {
      logger.warn(`pdfExtract doc not found for docId=${pdfDocId}`);
      return;
    }
    const pdfExtractData = pdfExtractDoc.data() || {};
    const courseName = pdfExtractData.courseName || "";

    // 3) Find the matching book in books_demo
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

    // 4) For each chapter, fetch pages from startPage to endPage, combine text, create docs
    for (const chapter of chapters) {
      const { title, summary, startPage, endPage } = chapter;

      // (A) Fetch the pages from pdfPages that are in [startPage..endPage]
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
      const chapterRef = await db.collection("pdfChapters").add({
        pdfDocId,
        title,
        summary,
        startPage,
        endPage,
        fullText: combinedText, // store the combined page text here
        fullTextMarkers: combinedText, // store the combined page text here
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      // (C) Create doc in chapters_demo
      const newChapterDemoRef = await db.collection("chapters_demo").add({
        bookId,
        name: title,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      // (D) Cross-reference
      await chapterRef.update({
        chapterDemoId: newChapterDemoRef.id,
      });
    }

    logger.info(`Created pdfChapters + chapters_demo docs for all ${chapters.length} chapters.`);
  } catch (error) {
    logger.error("Error in segmentChapters function:", error);
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

    if (!pdfChapterId || !subChaptersJson) {
      logger.warn("Missing pdfChapterId or subChaptersJson in pdfSubSummaries doc.");
      return;
    }

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

    for (const subChapter of subChaptersArr) {
      const { title, summary, startMarker, endMarker } = subChapter;

      await db.collection("pdfSubChapters").add({
        pdfChapterId,
        title: title || "Untitled Sub-chapter",
        summary: summary || "",
        startMarker: startMarker || "",
        endMarker: endMarker || "",
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      logger.info(`Created pdfSubChapters doc for sub-chapter="${title}" (pdfChapterId=${pdfChapterId}).`);
    }

    logger.info(`Successfully stored ${subChaptersArr.length} sub-chapters in pdfSubChapters.`);
  } catch (error) {
    logger.error("Error in segmentSubChapters function:", error);
  }
});
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
        console.info("No pdfChapterId found in new doc — skipping creation in subchapters_demo.");
        return;
      }

      // Fetch parent pdfChapters doc to get chapterDemoId
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
        console.info("No chapterDemoId found in pdfChapters doc. Skipping creation in subchapters_demo.");
        return;
      }

      // Create in subchapters_demo with same doc ID (optional)
      await db.collection("subchapters_demo").doc(subChapterId).set({
        subChapterId,
        chapterId: chapterDemoId,
        name: subTitle,
        summary: "", // will be filled when we slice + update
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      console.log(`Created subchapters_demo/${subChapterId} successfully.`);
    } catch (error) {
      console.error("Error in createSubChaptersDemoOnCreate:", error);
    }
  }
);
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

/*

function getWordCount(text = "") {
  // Trim and split by any sequence of whitespace.
  // Filter out any empty strings to avoid counting extra.
  const words = text.trim().split(/\s+/).filter(Boolean);
  return words.length;
}
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
exports.generateAdaptivePlan = onRequest(async (req, res) => {
  try {
    // For demonstration, hardcode these. Or pull from req.query, etc.
    const wpm = 200;
    const dailyTime = 10;
    const wordsPerDay = wpm * dailyTime;

    const db = admin.firestore();

    // ~~~~~~~~~ 1) Fetch all books from "books_demo" ~~~~~~~~~
    const booksSnap = await db.collection("books_demo").get();
    const booksData = [];

    for (const bookDoc of booksSnap.docs) {
      const bookId = bookDoc.id;
      const book = {
        id: bookId,
        ...bookDoc.data(),
      };

      // ~~~~~~~~~ 2) Fetch chapters for this book ~~~~~~~~~
      const chaptersSnap = await db
        .collection("chapters_demo")
        .where("bookId", "==", bookId)
        .get();

      const chaptersData = [];
      for (const chapterDoc of chaptersSnap.docs) {
        const chapterId = chapterDoc.id;
        const chapter = {
          id: chapterId,
          ...chapterDoc.data(),
        };

        // ~~~~~~~~~ 3) Fetch subchapters for this chapter ~~~~~~~~~
        const subSnap = await db
          .collection("subchapters_demo")
          .where("chapterId", "==", chapterId)
          .get();

        const subData = subSnap.docs.map((subDoc) => ({
          id: subDoc.id,
          ...subDoc.data(),
        }));

        // Sort subchapters (optional)
        const sortedSubs = sortByNameWithNumericAware(subData);
        chapter.subchapters = sortedSubs;
        chaptersData.push(chapter);
      }

      // Sort chapters (optional)
      const sortedChapters = sortByNameWithNumericAware(chaptersData);
      book.chapters = sortedChapters;

      booksData.push(book);
    }

    // ~~~~~~~~~ 4) Build "day-by-day" reading plan for each book ~~~~~~~~~
    // We'll store them in memory, then create the final "sessions" array across all books.
    // If you want a separate plan per book, you'll adapt the logic accordingly.
    const allSessions = []; // We'll accumulate subchapter IDs across "days"
    let dayIndex = 1;
    let currentDaySubchapIds = [];
    let currentDayWordCount = 0;

    // Helper function to "push" the current day into allSessions
    const pushCurrentDay = () => {
      if (currentDaySubchapIds.length > 0) {
        // We'll store subchapter IDs with sessionLabel = dayIndex
        allSessions.push({
          sessionLabel: dayIndex.toString(),
          subChapterIds: [...currentDaySubchapIds],
        });
        dayIndex += 1;
        currentDaySubchapIds = [];
        currentDayWordCount = 0;
      }
    };

    // We'll iterate across each book, each chapter, each subchapter
    for (const book of booksData) {
      if (!book.chapters) continue;
      for (const chapter of book.chapters) {
        if (!chapter.subchapters) continue;
        for (const sub of chapter.subchapters) {
          const subWordCount = sub.wordCount || 0;
          // If adding this subchapter exceeds the daily limit, push the current day
          if (
            currentDayWordCount + subWordCount > wordsPerDay &&
            currentDayWordCount > 0
          ) {
            pushCurrentDay();
          }
          // Add this subchapter to the current day
          currentDaySubchapIds.push(sub.id);
          currentDayWordCount += subWordCount;
        }
      }
    }

    // If there's a leftover partial day
    if (currentDaySubchapIds.length > 0) {
      pushCurrentDay();
    }

    // ~~~~~~~~~ 5) Write to "adaptive_demo" in the format:
    // {
    //   createdAt: timestamp,
    //   sessions: [ { sessionLabel, subChapterIds: [...] }, ...]
    // }
    // ~~~~~~~~~
    const planDoc = {
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      sessions: allSessions,
      planName: "Generated plan from Cloud Function",
    };

    await db.collection("adaptive_demo").add(planDoc);

    // ~~~~~~~~~ 6) Return a success response ~~~~~~~~~
    res.status(200).json({
      message: "Successfully generated an adaptive plan and stored in 'adaptive_demo'.",
      planDoc,
    });
  } catch (error) {
    console.error("Error generating adaptive plan:", error);
    res.status(500).json({ error: error.message });
  }
});

*/






// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
// 1) Helper Functions for Sorting

// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
// 3) Main Function (V2 HTTP Trigger)
// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

const db = admin.firestore(); // Assuming you've already initialized admin




/**
 * Expand a subchapter into an ordered array of activities
 * based on its proficiency.
 */
function getActivitiesForSub(sub, wpm) {
  // possible statuses: "unread" -> [READ, QUIZ, REVISE]
  //                   "read"   -> [QUIZ, REVISE]
  //                   "proficient" -> [REVISE]
  //                   "mastered"   -> []
  const activities = [];
  const proficiency = sub.proficiency || "unread";

  // 1) READ
  if (proficiency === "unread") {
    const wordCount = sub.wordCount || 0;
    const minutesNeeded = wordCount > 0 ? (wordCount / wpm) : 0;
    activities.push({
      subChapterId: sub.id,
      type: "READ",
      timeNeeded: Math.ceil(minutesNeeded), // round up
    });
  }

  // 2) QUIZ
  if (proficiency === "unread" || proficiency === "read") {
    // fixed 1 minute
    activities.push({
      subChapterId: sub.id,
      type: "QUIZ",
      timeNeeded: 1,
    });
  }

  // 3) REVISE
  if (
    proficiency === "unread" ||
    proficiency === "read" ||
    proficiency === "proficient"
  ) {
    // fixed 1 minute
    activities.push({
      subChapterId: sub.id,
      type: "REVISE",
      timeNeeded: 1,
    });
  }

  return activities;
}


exports.generateAdaptivePlan = onRequest(async (req, res) => {
  // ---------------- CORS HEADERS ----------------
  res.set("Access-Control-Allow-Origin", "*"); // or restrict to "http://localhost:3000"
  res.set("Access-Control-Allow-Headers", "Content-Type,Authorization");
  res.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");

  // If it's an OPTIONS request, respond immediately
  if (req.method === "OPTIONS") {
    return res.status(204).send("");
  }

  try {
    // ---------------------------------------------------------
    // A) Extract Inputs
    // ---------------------------------------------------------
    const userId = req.query.userId || req.body.userId;
    if (!userId) {
      return res.status(400).json({
        error: "Missing userId in request (req.query or req.body).",
      });
    }

    // Target date
    const targetDateStr = req.query.targetDate || req.body.targetDate;
    if (!targetDateStr) {
      return res.status(400).json({
        error: "Missing targetDate in request (req.query or req.body).",
      });
    }

    const targetDate = new Date(targetDateStr);
    if (isNaN(targetDate.getTime())) {
      return res.status(400).json({
        error:
          "Invalid targetDate format. Provide a valid date string (e.g. '2025-07-20').",
      });
    }

    // Current date
    const today = new Date();
    let maxDayCount = getDaysBetween(today, targetDate);
    if (maxDayCount < 0) maxDayCount = 0;

    // ---------------------------------------------------------
    // B) Fetch User Persona -> get wpm, dailyReadingTime
    // ---------------------------------------------------------
    const personaQuery = await db
      .collection("learnerPersonas")
      .where("userId", "==", userId)
      .limit(1)
      .get();

    if (personaQuery.empty) {
      return res.status(404).json({
        error: `No learner persona found for userId: ${userId}`,
      });
    }

    // Grab the first matching document
    const personaSnap = personaQuery.docs[0];
    const { wpm, dailyReadingTime } = personaSnap.data() || {};

    if (!wpm || !dailyReadingTime) {
      return res.status(400).json({
        error: "Persona document must contain 'wpm' and 'dailyReadingTime'.",
      });
    }

    // ---------------------------------------------------------
    // C) Fetch & Sort Books/Chapters/Subchapters
    // ---------------------------------------------------------
    const booksSnap = await db.collection("books_demo").get();
    const booksData = [];

    for (const bookDoc of booksSnap.docs) {
      const bookId = bookDoc.id;
      const book = {
        id: bookId,
        ...bookDoc.data(),
      };

      // fetch chapters
      const chaptersSnap = await db
        .collection("chapters_demo")
        .where("bookId", "==", bookId)
        .get();

      const chaptersData = [];
      for (const chapterDoc of chaptersSnap.docs) {
        const chapterId = chapterDoc.id;
        const chapter = {
          id: chapterId,
          ...chapterDoc.data(),
        };

        // fetch subchapters
        const subSnap = await db
          .collection("subchapters_demo")
          .where("chapterId", "==", chapterId)
          .get();

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
    // D) Generate a Single Ordered Array of Activities
    // ---------------------------------------------------------
    const allActivities = [];
    for (const book of booksData) {
      if (!book.chapters) continue;
      for (const chapter of book.chapters) {
        if (!chapter.subchapters) continue;
        for (const sub of chapter.subchapters) {
          // For each subchapter, get READ/QUIZ/REVISE in the correct order
          const subActivities = getActivitiesForSub(sub, wpm);

          // Collect them in a single array (with metadata)
          for (const activity of subActivities) {
            allActivities.push({
              ...activity,
              bookId: book.id,
              chapterId: chapter.id,
              subChapterName: sub.name || "",
              // you can also store book/chapter names if desired
            });
          }
        }
      }
    }

    // ---------------------------------------------------------
    // E) Distribute Activities into Days (a.k.a. sessions)
    // ---------------------------------------------------------
    const dailyTimeMins = dailyReadingTime;
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

    for (let i = 0; i < allActivities.length; i++) {
      if (dayIndex > maxDayCount && maxDayCount > 0) {
        // Option 1: break out if you don't want to schedule past targetDate
        // break;

        // Option 2: Or just keep scheduling beyond target date
      }

      const activity = allActivities[i];

      // If adding this activity exceeds daily limit and we already have something in this day...
      if (
        currentDayTime + activity.timeNeeded > dailyTimeMins &&
        currentDayTime > 0
      ) {
        pushCurrentDay();
      }

      // Add the activity to the current day
      currentDayActivities.push(activity);
      currentDayTime += activity.timeNeeded;
    }

    // leftover in final day
    if (currentDayActivities.length > 0) {
      pushCurrentDay();
    }

    // ---------------------------------------------------------
    // F) Write Plan to Firestore
    // ---------------------------------------------------------
    const planDoc = {
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      planName: `Adaptive Plan for User ${userId}`,
      userId,
      targetDate: targetDateStr,
      sessions,
      maxDayCount,
    };

    const newRef = await db.collection("adaptive_demo").add(planDoc);

    // ---------------------------------------------------------
    // G) Return Success
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




// 1) Helper for numeric-aware sorting
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

// 2) Helper: always create READ, QUIZ, REVISE ignoring proficiency
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

// 3) Helper: get # of days between two dates (rounding up)
function getDaysBetween(startDate, endDate) {
  const msInDay = 24 * 60 * 60 * 1000;
  return Math.ceil((endDate - startDate) / msInDay);
}







exports.generateBookPlan = onRequest(async (req, res) => {
  try {
    // A) Extract Inputs
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
        error: "Invalid targetDate format. Provide a valid date string (e.g. '2025-07-20').",
      });
    }

    // Calculate maxDayCount
    const today = new Date();
    let maxDayCount = getDaysBetween(today, targetDate);
    if (maxDayCount < 0) maxDayCount = 0;

    // B) Fetch user persona (using a .where() query)
    const db = admin.firestore();
    const personaQuery = await db
      .collection("learnerPersonas")
      .where("userId", "==", userId)
      .limit(1)
      .get();

    if (personaQuery.empty) {
      return res.status(404).json({
        error: `No learner persona found for userId: ${userId}`,
      });
    }

    // Grab the first (and presumably only) matching doc
    const personaSnap = personaQuery.docs[0];
    const personaData = personaSnap.data() || {};
    const { wpm } = personaData;
    if (!wpm) {
      return res.status(400).json({
        error: "Persona document must contain 'wpm'.",
      });
    }

    // C) Fetch Books -> Chapters -> Subchapters
    const booksSnap = await db.collection("books_demo").get();
    const booksData = [];

    for (const bookDoc of booksSnap.docs) {
      const bookId = bookDoc.id;
      const bookData = bookDoc.data();

      // fetch chapters
      const chaptersSnap = await db
        .collection("chapters_demo")
        .where("bookId", "==", bookId)
        .get();

      const chapters = [];
      for (const chapterDoc of chaptersSnap.docs) {
        const chapterId = chapterDoc.id;
        const chapterData = chapterDoc.data();

        // fetch subchapters
        const subSnap = await db
          .collection("subchapters_demo")
          .where("chapterId", "==", chapterId)
          .get();

        const subchapters = subSnap.docs.map((subDoc) => ({
          id: subDoc.id,
          bookId,
          chapterId,
          ...subDoc.data(),
        }));

        // sort subchapters
        const sortedSubs = sortByNameWithNumericAware(subchapters);

        chapters.push({
          id: chapterId,
          ...chapterData,
          subchapters: sortedSubs,
        });
      }

      // sort chapters
      const sortedChapters = sortByNameWithNumericAware(chapters);

      // add final "book" object
      booksData.push({
        id: bookId,
        ...bookData,
        chapters: sortedChapters,
      });
    }

    // D) Build "sessions" (1 session = 1 book)
    const sessions = [];
    let sessionCounter = 1;

    for (const book of booksData) {
      // gather ALL subchapters from all chapters in the same order
      const allActivities = [];

      if (book.chapters) {
        for (const chapter of book.chapters) {
          if (!chapter.subchapters) continue;

          for (const sub of chapter.subchapters) {
            // Generate [READ, QUIZ, REVISE]
            const subActivities = getAlwaysAllActivities(sub, wpm).map((act) => ({
              ...act,
              bookName: book.name || "",
              chapterName: chapter.name || "",
            }));
            allActivities.push(...subActivities);
          }
        }
      }

      sessions.push({
        sessionLabel: sessionCounter.toString(),
        activities: allActivities,
      });

      sessionCounter++;
    }

    // E) Write plan doc
    const planDoc = {
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      planName: `Book Plan for User ${userId}`,
      userId,
      targetDate: targetDateStr,
      sessions,
      maxDayCount,
    };

    const newRef = await db.collection("adaptive_books").add(planDoc);

    // F) Return final JSON
    return res.status(200).json({
      message: "Successfully generated a book-based plan (1 book = 1 session) in 'adaptive_books'.",
      planId: newRef.id,
      planDoc,
      sessions,
      userId,
      targetDate: targetDateStr,
      maxDayCount,
    });
  } catch (error) {
    logger.error("Error generating book-based plan", error);
    return res.status(500).json({ error: error.message });
  }
});