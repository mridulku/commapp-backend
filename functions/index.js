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



function getDaysBetween(startDate, endDate) {
  const msInDay = 24 * 60 * 60 * 1000;
  return Math.ceil((endDate - startDate) / msInDay);
}





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





// Example placeholders (replace with real code as needed):
function getDaysBetween(d1, d2) {
  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.ceil((d2 - d1) / msPerDay);
}



function mapPlanTypeToStages(planType) {
  // planType might be "none-basic", "some-moderate", "strong-advanced", etc.
  switch (planType) {
    // ----- none + (basic|moderate|advanced) -----
    case "none-basic":
      return { startStage: "remember", finalStage: "understand" };
    case "none-moderate":
      return { startStage: "remember", finalStage: "apply" };
    case "none-advanced":
      return { startStage: "remember", finalStage: "analyze" };

    // ----- some + (basic|moderate|advanced) -----
    case "some-basic":
      // user claims partial knowledge => start at "understand"
      // goal is "basic" => final => "understand"
      return { startStage: "understand", finalStage: "understand" };
    case "some-moderate":
      return { startStage: "understand", finalStage: "apply" };
    case "some-advanced":
      return { startStage: "understand", finalStage: "analyze" };

    // ----- strong + (basic|moderate|advanced) -----
    case "strong-basic":
      // user claims strong knowledge => start at "apply"
      // for "basic," final is "understand," but that might not make sense 
      // if "apply" is actually a higher stage than "understand."
      // If you want to skip or invert that logic, adjust accordingly.
      // For example, you might do start="apply", final="apply" if "basic" is truly lower
      return { startStage: "apply", finalStage: "apply" };

    case "strong-moderate":
      return { startStage: "apply", finalStage: "apply" };
    case "strong-advanced":
      return { startStage: "apply", finalStage: "analyze" };

    // fallback
    default:
      // If you have an unrecognized planType, 
      // just assume from "remember" to "analyze" as a catch-all
      return { startStage: "remember", finalStage: "analyze" };
  }
}

// Stage helpers
function stageToNumber(s) {
  switch (s) {
    case "none": return 0;
    case "remember": return 1;
    case "understand": return 2;
    case "apply": return 3;
    case "analyze": return 4;
    default: return 0;
  }
}
function numberToStage(n) {
  switch (n) {
    case 1: return "remember";
    case 2: return "understand";
    case 3: return "apply";
    case 4: return "analyze";
    default: return "none";
  }
}


function getActivitiesForSub2(sub, {
  userCurrentStage,   // e.g. "none"|"remember"|"understand"|"apply"|"analyze"
  startStage,
  finalStage,
  wpm,
  quizTime = 5
}) {
  const stageIndex = stageToNumber(userCurrentStage);
  const startIndex = stageToNumber(startStage);
  const finalIndex = stageToNumber(finalStage);

  // If user is beyond final => no tasks
  if (stageIndex >= finalIndex) {
    return [];
  }

  const tasks = [];

  // A) If user is behind "remember", add READ
  if (stageIndex < 1 && startIndex <= 1) {
    // reading time logic
    const readTime = sub.wordCount 
      ? Math.ceil(sub.wordCount / wpm)
      : 5;
    tasks.push({
      type: "READ",
      timeNeeded: readTime
    });
  }

  // B) For each stage from max(stageIndex+1, startIndex) up to finalIndex => QUIZ only
  let currentNeededStart = Math.max(stageIndex + 1, startIndex);
  for (let st = currentNeededStart; st <= finalIndex; st++) {
    tasks.push({
      type: "QUIZ",
      quizStage: numberToStage(st),
      timeNeeded: quizTime
    });
  }

  return tasks;
}

/*
// The main plan generation function
exports.generateAdaptivePlan2 = onRequest(async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Headers", "Content-Type,Authorization");
  res.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");

  if (req.method === "OPTIONS") {
    return res.status(204).send("");
  }

  try {
    // ------------------------------------------------------
    // A) Basic Input
    // ------------------------------------------------------
    const userId = req.query.userId || req.body.userId;
    if (!userId) {
      return res.status(400).json({ error: "Missing userId." });
    }

    const targetDateStr = req.query.targetDate || req.body.targetDate;
    if (!targetDateStr) {
      return res.status(400).json({ error: "Missing targetDate." });
    }
    const targetDate = new Date(targetDateStr);
    if (isNaN(targetDate.getTime())) {
      return res.status(400).json({ error: "Invalid targetDate format." });
    }

    const today = new Date();
    let defaultMaxDayCount = getDaysBetween(today, targetDate);
    if (defaultMaxDayCount < 0) defaultMaxDayCount = 0;

    // ------------------------------------------------------
    // B) Optional overrides
    // ------------------------------------------------------
    const maxDaysOverride = (req.body.maxDays !== undefined) ? Number(req.body.maxDays) : null;
    const wpmOverride = (req.body.wpm !== undefined) ? Number(req.body.wpm) : null;
    const dailyReadingTimeOverride = (req.body.dailyReadingTime !== undefined)
      ? Number(req.body.dailyReadingTime)
      : null;

    // We fix quizTime=5 by default (no revise)
    const quizTimeOverride = (req.body.quizTime !== undefined) ? Number(req.body.quizTime) : 5;

    const level = req.body.planType || "none-basic";

    const selectedBooks = Array.isArray(req.body.selectedBooks) ? req.body.selectedBooks : null;
    const selectedChapters = Array.isArray(req.body.selectedChapters) ? req.body.selectedChapters : null;
    const selectedSubChapters = Array.isArray(req.body.selectedSubChapters) ? req.body.selectedSubChapters : null;
    const singleBookIdFromBody = req.body.bookId || "";

    // ------------------------------------------------------
    // C) Fetch Persona
    // ------------------------------------------------------
    const personaSnap = await db
      .collection("learnerPersonas")
      .where("userId", "==", userId)
      .limit(1)
      .get();
    if (personaSnap.empty) {
      return res.status(404).json({ error: `No learner persona found for userId: ${userId}` });
    }
    const personaData = personaSnap.docs[0].data() || {};
    if (!personaData.wpm || !personaData.dailyReadingTime) {
      return res.status(400).json({ error: "Persona doc must have 'wpm' and 'dailyReadingTime'." });
    }

    const finalWpm = wpmOverride || personaData.wpm;
    const finalDailyReadingTime = dailyReadingTimeOverride || personaData.dailyReadingTime;
    let maxDayCount = (maxDaysOverride !== null) ? maxDaysOverride : defaultMaxDayCount;

    // ------------------------------------------------------
    // D) Fetch Books
    // ------------------------------------------------------
    let arrayOfBookIds = [];
    if (selectedBooks && selectedBooks.length > 0) {
      arrayOfBookIds = selectedBooks;
    } else if (singleBookIdFromBody) {
      arrayOfBookIds = [singleBookIdFromBody];
    }

    let booksSnap;
    if (arrayOfBookIds.length > 0) {
      booksSnap = await db
        .collection("books_demo")
        .where(admin.firestore.FieldPath.documentId(), "in", arrayOfBookIds)
        .get();
    } else {
      booksSnap = await db.collection("books_demo").get();
    }

    const booksData = [];
    for (const bookDoc of booksSnap.docs) {
      const bookId = bookDoc.id;
      const book = { id: bookId, ...bookDoc.data() };

      // E) fetch chapters
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
        const chapter = { id: chapterId, ...chapterDoc.data() };

        // F) fetch subchapters
        let subSnap;
        if (selectedSubChapters && selectedSubChapters.length > 0) {
          subSnap = await db
            .collection("subchapters_demo")
            .where("chapterId", "==", chapterId)
            .where(admin.firestore.FieldPath.documentId(), "in", selectedSubChapters)
            .get();
        } else {
          subSnap = await db
            .collection("subchapters_demo")
            .where("chapterId", "==", chapterId)
            .get();
        }

        const subData = subSnap.docs.map(d => ({ id: d.id, ...d.data() }));

        // sort subchapters
        chapter.subchapters = sortByNameWithNumericAware(subData);
        chaptersData.push(chapter);
      }
      book.chapters = sortByNameWithNumericAware(chaptersData);
      booksData.push(book);
    }

    // ------------------------------------------------------
    // G) Build array of tasks (READ + QUIZ, no revise)
    // ------------------------------------------------------
    const { startStage, finalStage } = mapPlanTypeToStages(level);
    const allActivities = [];

    for (const book of booksData) {
      if (!book.chapters) continue;
      for (const chapter of book.chapters) {
        if (!chapter.subchapters) continue;
        for (const sub of chapter.subchapters) {
          const userCurrentStage = sub.currentStage || "none";

          // We only do reading + quiz (no revise)
          const subActs = getActivitiesForSub2(sub, {
            userCurrentStage,
            startStage,
            finalStage,
            wpm: finalWpm,
            quizTime: quizTimeOverride
          });
          for (const act of subActs) {
            allActivities.push({
              ...act,
              level,
              bookId: book.id,
              bookName: book.name || "",
              chapterId: chapter.id,
              chapterName: chapter.name || "",
              subChapterId: sub.id,
              subChapterName: sub.name || ""
            });
          }
        }
      }
    }

    // ------------------------------------------------------
    // H) Distribute into sessions => prefer 1 activity/subChapter,
    //    fallback to fill leftover if no new subchap can fit
    // ------------------------------------------------------
    const dailyTimeMins = finalDailyReadingTime;
    let dayIndex = 1;
    const sessions = [];

    let pendingTasks = [...allActivities];

    function buildNextDay() {
      return {
        sessionLabel: dayIndex.toString(),
        activities: [],
        timeUsed: 0,
        usedSubs: new Set()
      };
    }
    let currentDay = buildNextDay();

    function finalizeDay() {
      if (currentDay.activities.length > 0) {
        sessions.push({
          sessionLabel: currentDay.sessionLabel,
          activities: currentDay.activities
        });
        dayIndex++;
      }
      currentDay = buildNextDay();
    }

    while (pendingTasks.length > 0 && dayIndex <= maxDayCount) {
      let placed = false;

      // Try new sub-chapter first
      for (let i = 0; i < pendingTasks.length; i++) {
        const t = pendingTasks[i];
        const actTime = t.timeNeeded || 1;
        const leftover = dailyTimeMins - currentDay.timeUsed;
        if (actTime <= leftover && !currentDay.usedSubs.has(t.subChapterId)) {
          // place
          currentDay.activities.push(t);
          currentDay.timeUsed += actTime;
          currentDay.usedSubs.add(t.subChapterId);
          pendingTasks.splice(i, 1);
          placed = true;
          break;
        }
      }

      if (!placed) {
        // fallback => see if we can place same sub-chapter again to fill leftover
        let placedSame = false;
        for (let i = 0; i < pendingTasks.length; i++) {
          const t = pendingTasks[i];
          const actTime = t.timeNeeded || 1;
          const leftover = dailyTimeMins - currentDay.timeUsed;
          if (actTime <= leftover) {
            currentDay.activities.push(t);
            currentDay.timeUsed += actTime;
            currentDay.usedSubs.add(t.subChapterId);
            pendingTasks.splice(i, 1);
            placedSame = true;
            break;
          }
        }
        if (!placedSame) {
          // no tasks fit leftover => finalize day
          finalizeDay();
        }
      }

      if (currentDay.timeUsed >= dailyTimeMins) {
        finalizeDay();
      }
    }

    // finalize last day
    if (currentDay.activities.length > 0 && dayIndex <= maxDayCount) {
      finalizeDay();
    }

    // I) Write planDoc
    let singleBookId = "";
    if (singleBookIdFromBody) {
      singleBookId = singleBookIdFromBody;
    } else if (selectedBooks && selectedBooks.length > 0) {
      singleBookId = selectedBooks[0];
    }

    const planDoc = {
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      planName: `Adaptive Plan (v2) for User ${userId}`,
      userId,
      targetDate: targetDateStr,
      sessions,
      maxDayCount,
      wpmUsed: finalWpm,
      dailyReadingTimeUsed: finalDailyReadingTime,
      level,
      bookId: singleBookId
    };

    const newRef = await db.collection("adaptive_demo").add(planDoc);

    return res.status(200).json({
      message: "Successfully generated plan in 'adaptive_demo'.",
      planId: newRef.id,
      planDoc
    });
  } catch (error) {
    console.error("Error generating adaptive plan v2:", error);
    return res.status(500).json({ error: error.message });
  }
});
*/


exports.generateAdaptivePlan2 = onRequest(async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Headers", "Content-Type,Authorization");
  res.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");

  if (req.method === "OPTIONS") {
    return res.status(204).send("");
  }

  // ------------------------
  // A) Basic Input
  // ------------------------
  try {
    const userId = req.query.userId || req.body.userId;
    if (!userId) {
      return res.status(400).json({ error: "Missing userId." });
    }

    const targetDateStr = req.query.targetDate || req.body.targetDate;
    if (!targetDateStr) {
      return res.status(400).json({ error: "Missing targetDate." });
    }
    const targetDate = new Date(targetDateStr);
    if (isNaN(targetDate.getTime())) {
      return res.status(400).json({ error: "Invalid targetDate format." });
    }

    // Exam ID (defaults to "general" if empty)
    const examId = req.query.examId || req.body.examId || "general";

    const today = new Date();
    let defaultMaxDayCount = getDaysBetween(today, targetDate);
    if (defaultMaxDayCount < 0) defaultMaxDayCount = 0;

    // ------------------------
    // B) Optional overrides
    // ------------------------
    const maxDaysOverride =
      req.body.maxDays !== undefined ? Number(req.body.maxDays) : null;
    const wpmOverride =
      req.body.wpm !== undefined ? Number(req.body.wpm) : null;
    const dailyReadingTimeOverride =
      req.body.dailyReadingTime !== undefined
        ? Number(req.body.dailyReadingTime)
        : null;

    // We fix quizTime=5 by default (no revise)
    const quizTimeOverride =
      req.body.quizTime !== undefined ? Number(req.body.quizTime) : 5;

    // planType => e.g. "none-basic", "some-advanced", etc.
    const level = req.body.planType || "none-basic";

    const selectedBooks = Array.isArray(req.body.selectedBooks)
      ? req.body.selectedBooks
      : null;
    const selectedChapters = Array.isArray(req.body.selectedChapters)
      ? req.body.selectedChapters
      : null;
    const selectedSubChapters = Array.isArray(req.body.selectedSubChapters)
      ? req.body.selectedSubChapters
      : null;
    const singleBookIdFromBody = req.body.bookId || "";

    // ------------------------
    // C) Fetch Persona
    // ------------------------
    const db = admin.firestore();
    const personaSnap = await db
      .collection("learnerPersonas")
      .where("userId", "==", userId)
      .limit(1)
      .get();
    if (personaSnap.empty) {
      return res
        .status(404)
        .json({ error: `No learner persona found for userId: ${userId}` });
    }
    const personaData = personaSnap.docs[0].data() || {};
    if (!personaData.wpm || !personaData.dailyReadingTime) {
      return res
        .status(400)
        .json({ error: "Persona doc must have 'wpm' and 'dailyReadingTime'." });
    }

    const finalWpm = wpmOverride || personaData.wpm;
    const finalDailyReadingTime =
      dailyReadingTimeOverride || personaData.dailyReadingTime;
    let maxDayCount =
      maxDaysOverride !== null ? maxDaysOverride : defaultMaxDayCount;

    // ------------------------
    // D) Fetch exam config
    // ------------------------
    // If examId is "general" or empty => we'll try examConfigs/general
    const examDocRef = db.collection("examConfigs").doc(examId);
    const examDocSnap = await examDocRef.get();

    if (!examDocSnap.exists) {
      // If they asked for something other than "general" but it doesn't exist, error
      if (examId !== "general") {
        return res
          .status(400)
          .json({ error: `No exam config found for examId='${examId}'.` });
      } else {
        return res
          .status(400)
          .json({ error: "No 'general' exam config found in examConfigs." });
      }
    }

    const examConfig = examDocSnap.data() || {};
    if (!examConfig.stages || !examConfig.planTypes) {
      return res
        .status(400)
        .json({ error: `Exam config doc for '${examId}' is missing 'stages' or 'planTypes'.` });
    }

    // Helper to convert stage string -> numeric index
    function stageToNumber(stageStr) {
      const idx = examConfig.stages.indexOf(stageStr);
      return idx >= 0 ? idx : 0; // if not found, default 0
    }

    // Helper to convert numeric index -> stage string
    function numberToStage(idx) {
      if (idx < 0) return examConfig.stages[0];
      if (idx >= examConfig.stages.length) {
        return examConfig.stages[examConfig.stages.length - 1];
      }
      return examConfig.stages[idx];
    }

    // This replaces the old mapPlanTypeToStages() function
    function getPlanTypeStages(planType) {
      const mapping = examConfig.planTypes[planType];
      if (!mapping) {
        // fallback: from the first stage to the last stage in the array
        return {
          startStage: examConfig.stages[0],
          finalStage: examConfig.stages[examConfig.stages.length - 1],
        };
      }
      return mapping;
    }

    // This replaces the old getActivitiesForSub2() function
    function getActivitiesForSub2(sub, {
      userCurrentStage, // e.g. "none"|"remember"|"understand"|"apply"|"analyze"
      startStage,
      finalStage,
      wpm,
      quizTime = 5
    }) {
      const stageIndex = stageToNumber(userCurrentStage);
      const startIndex = stageToNumber(startStage);
      const finalIndex = stageToNumber(finalStage);

      // If user is beyond final => no tasks
      if (stageIndex >= finalIndex) {
        return [];
      }

      const tasks = [];

      // A) If user is behind "remember", add READ
      // i.e. if examConfig includes a "remember" stage
      const rememberIndex = examConfig.stages.indexOf("remember");
      if (rememberIndex !== -1) {
        // If user is behind the "remember" stage, and the plan includes it
        if (stageIndex < rememberIndex && startIndex <= rememberIndex) {
          // reading time logic
          const readTime = sub.wordCount
            ? Math.ceil(sub.wordCount / wpm)
            : 5;
          tasks.push({
            type: "READ",
            timeNeeded: readTime
          });
        }
      }

      // B) For each stage from max(stageIndex+1, startIndex) up to finalIndex => QUIZ only
      let currentNeededStart = Math.max(stageIndex + 1, startIndex);
      for (let st = currentNeededStart; st <= finalIndex; st++) {
        tasks.push({
          type: "QUIZ",
          quizStage: numberToStage(st),
          timeNeeded: quizTime
        });
      }

      return tasks;
    }

    // ------------------------
    // E) Fetch Books
    // ------------------------
    let arrayOfBookIds = [];
    if (selectedBooks && selectedBooks.length > 0) {
      arrayOfBookIds = selectedBooks;
    } else if (singleBookIdFromBody) {
      arrayOfBookIds = [singleBookIdFromBody];
    }

    let booksSnap;
    if (arrayOfBookIds.length > 0) {
      booksSnap = await db
        .collection("books_demo")
        .where(admin.firestore.FieldPath.documentId(), "in", arrayOfBookIds)
        .get();
    } else {
      booksSnap = await db.collection("books_demo").get();
    }

    const booksData = [];
    for (const bookDoc of booksSnap.docs) {
      const bookId = bookDoc.id;
      const book = { id: bookId, ...bookDoc.data() };

      // F) fetch chapters
      let chaptersSnap;
      if (selectedChapters && selectedChapters.length > 0) {
        chaptersSnap = await db
          .collection("chapters_demo")
          .where("bookId", "==", bookId)
          .where(
            admin.firestore.FieldPath.documentId(),
            "in",
            selectedChapters
          )
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
        const chapter = { id: chapterId, ...chapterDoc.data() };

        // G) fetch subchapters
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
      book.chapters = sortByNameWithNumericAware(chaptersData);
      booksData.push(book);
    }

    // ------------------------
    // H) Build array of tasks
    // ------------------------
    const { startStage, finalStage } = getPlanTypeStages(level);
    const allActivities = [];

    for (const book of booksData) {
      if (!book.chapters) continue;
      for (const chapter of book.chapters) {
        if (!chapter.subchapters) continue;
        for (const sub of chapter.subchapters) {
          const userCurrentStage = sub.currentStage || "none";

          // We only do reading + quiz (no revise) => use getActivitiesForSub2
          const subActs = getActivitiesForSub2(sub, {
            userCurrentStage,
            startStage,
            finalStage,
            wpm: finalWpm,
            quizTime: quizTimeOverride
          });

          for (const act of subActs) {
            allActivities.push({
              ...act,
              level,
              bookId: book.id,
              bookName: book.name || "",
              chapterId: chapter.id,
              chapterName: chapter.name || "",
              subChapterId: sub.id,
              subChapterName: sub.name || ""
            });
          }
        }
      }
    }

    // ------------------------
    // I) Distribute into sessions
    // ------------------------
    const dailyTimeMins = finalDailyReadingTime;
    let dayIndex = 1;
    const sessions = [];

    let pendingTasks = [...allActivities];

    function buildNextDay() {
      return {
        sessionLabel: dayIndex.toString(),
        activities: [],
        timeUsed: 0,
        usedSubs: new Set(),
      };
    }
    let currentDay = buildNextDay();

    function finalizeDay() {
      if (currentDay.activities.length > 0) {
        sessions.push({
          sessionLabel: currentDay.sessionLabel,
          activities: currentDay.activities,
        });
        dayIndex++;
      }
      currentDay = buildNextDay();
    }

    while (pendingTasks.length > 0 && dayIndex <= maxDayCount) {
      let placed = false;

      // Try new sub-chapter first
      for (let i = 0; i < pendingTasks.length; i++) {
        const t = pendingTasks[i];
        const actTime = t.timeNeeded || 1;
        const leftover = dailyTimeMins - currentDay.timeUsed;
        if (
          actTime <= leftover &&
          !currentDay.usedSubs.has(t.subChapterId)
        ) {
          // place
          currentDay.activities.push(t);
          currentDay.timeUsed += actTime;
          currentDay.usedSubs.add(t.subChapterId);
          pendingTasks.splice(i, 1);
          placed = true;
          break;
        }
      }

      if (!placed) {
        // fallback => see if we can place same sub-chapter again to fill leftover
        let placedSame = false;
        for (let i = 0; i < pendingTasks.length; i++) {
          const t = pendingTasks[i];
          const actTime = t.timeNeeded || 1;
          const leftover = dailyTimeMins - currentDay.timeUsed;
          if (actTime <= leftover) {
            currentDay.activities.push(t);
            currentDay.timeUsed += actTime;
            currentDay.usedSubs.add(t.subChapterId);
            pendingTasks.splice(i, 1);
            placedSame = true;
            break;
          }
        }
        if (!placedSame) {
          // no tasks fit leftover => finalize day
          finalizeDay();
        }
      }

      if (currentDay.timeUsed >= dailyTimeMins) {
        finalizeDay();
      }
    }

    // finalize last day
    if (currentDay.activities.length > 0 && dayIndex <= maxDayCount) {
      finalizeDay();
    }

    // ------------------------
    // J) Write planDoc
    // ------------------------
    let singleBookId = "";
    if (singleBookIdFromBody) {
      singleBookId = singleBookIdFromBody;
    } else if (selectedBooks && selectedBooks.length > 0) {
      singleBookId = selectedBooks[0];
    }

    const planDoc = {
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      planName: `Adaptive Plan (v2) for User ${userId}`,
      userId,
      targetDate: targetDateStr,
      sessions,
      maxDayCount,
      wpmUsed: finalWpm,
      dailyReadingTimeUsed: finalDailyReadingTime,
      level,
      bookId: singleBookId,
      examId, // <-- store the exam type as well
    };

    const newRef = await db.collection("adaptive_demo").add(planDoc);

    return res.status(200).json({
      message: "Successfully generated plan in 'adaptive_demo'.",
      planId: newRef.id,
      planDoc,
    });
  } catch (error) {
    console.error("Error generating adaptive plan v2:", error);
    return res.status(500).json({ error: error.message });
  }
});

