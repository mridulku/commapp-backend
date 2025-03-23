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







exports.extractConceptsOnFlag = onDocumentUpdated("subchapters_demo/{docId}", async (event) => {
  const beforeData = event.data.before?.data() || {};
  const afterData = event.data.after?.data() || {};
  const bookId = afterData.bookId || null;
  const docId = event.params.docId;

  // oldVal => conceptExtractionRequested in "before"
  const oldVal = beforeData.conceptExtractionRequested;
  // newVal => conceptExtractionRequested in "after"
  const newVal = afterData.conceptExtractionRequested;

  // If it was not true before and now it's true => run GPT
  if (!oldVal && newVal) {
    console.log(`extractConceptsOnFlag triggered for subchapters_demo/${docId}`);

    // 1) Grab summary from the after data
    const summaryText = afterData.summary || "";
    if (!summaryText) {
      console.log("No summary text found. Skipping GPT concept extraction.");
      return;
    }

    try {
      // 2) Set up GPT
      const openAiKey = process.env.OPENAI_API_KEY;
      if (!openAiKey) {
        throw new Error("OPENAI_API_KEY is not set in environment variables!");
      }
      const configuration = new Configuration({ apiKey: openAiKey });
      const openai = new OpenAIApi(configuration);

      // 3) Build concept-extraction prompt
      const prompt = `
You are an educational content analyst. 
You have the following text from a subchapter:

"""${summaryText}"""

Please do the following:
1. List the major concepts or skills covered in this text. 
   - Provide a short name/title for each concept.
   - Provide a brief 1–2 sentence explanation of its meaning or importance.
2. For each concept, list any sub-points or examples crucial to understanding it.
3. Return your answer in a structured JSON format like:

{
  "concepts": [
    {
      "name": "...",
      "summary": "...",
      "subPoints": ["...", "..."]
    },
    ...
  ]
}

Do not include extra commentary outside the JSON.
`.trim();

      // 4) Call GPT
      const completion = await openai.createChatCompletion({
        model: "gpt-3.5-turbo", // or a model you prefer
        messages: [
          { role: "system", content: "You are a helpful educational assistant." },
          { role: "user", content: prompt },
        ],
        temperature: 0.7,
      });

      const gptOutput = completion.data.choices[0].message.content.trim();
      console.log("GPT concept extraction output:", gptOutput);

      // 5) Parse the JSON
      let parsed;
      try {
        parsed = JSON.parse(gptOutput);
      } catch (parseErr) {
        console.error("Error parsing GPT JSON for concepts:", parseErr);
        // optionally store an error field or revert the flag
        await event.data.after.ref.update({
          conceptExtractionRequested: false,
          conceptExtractionError: "Invalid JSON from GPT"
        });
        return;
      }

      const concepts = parsed.concepts || [];
      console.log(`Extracted ${concepts.length} concepts.`);

      // 6) Store the concepts
      const db = admin.firestore();
      for (const concept of concepts) {
        await db.collection("subchapterConcepts").add({
          subChapterId: docId,
          bookId: bookId, // <-- Add the bookId here
          name: concept.name || "Untitled",
          summary: concept.summary || "",
          subPoints: concept.subPoints || [],
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      }

      // 7) Mark done / reset flags
      await event.data.after.ref.update({
        conceptExtractionRequested: false,
        conceptExtractionComplete: true,
        conceptCount: concepts.length,
        conceptExtractionError: admin.firestore.FieldValue.delete(), // clear any previous error
      });

      console.log(
        `Successfully stored concepts for subchapters_demo/${docId}.`
      );
    } catch (err) {
      console.error("Error in concept extraction function:", err);
      // optionally store error
      await event.data.after.ref.update({
        conceptExtractionRequested: false,
        conceptExtractionError: err.message || "Unknown error"
      });
    }
  }
});








exports.cloneStandardBook = onRequest(async (req, res) => {
  try {
    // 1) Read input
    const { standardBookId, targetUserId } = req.body || {};
    if (!standardBookId || !targetUserId) {
      res.status(400).json({
        error: "Missing parameters: standardBookId, targetUserId",
      });
      return;
    }

    // 2) Fetch the "standard" book
    const standardBookRef = db.collection("books_demo").doc(standardBookId);
    const standardBookSnap = await standardBookRef.get();
    if (!standardBookSnap.exists) {
      res.status(404).json({ error: "Standard book not found." });
      return;
    }
    const standardBookData = standardBookSnap.data() || {};

    // 3) Create the new Book doc for the target user
    const newBookData = {
      name: standardBookData.name || "Untitled Book Copy",
      userId: targetUserId,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    const newBookRef = await db.collection("books_demo").add(newBookData);
    const newBookId = newBookRef.id;

    // 4) Copy chapters_demo for that standard book
    const chaptersSnap = await db
      .collection("chapters_demo")
      .where("bookId", "==", standardBookId)
      .get();

    const chapterIdMap = {};
    for (const chapterDoc of chaptersSnap.docs) {
      const oldChapterId = chapterDoc.id;
      const chapterData = chapterDoc.data() || {};

      const newChapter = {
        name: chapterData.name || "Untitled Chapter",
        bookId: newBookId,
        userId: targetUserId,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      };

      const newChapRef = await db.collection("chapters_demo").add(newChapter);
      const newChapterId = newChapRef.id;

      // Store in map so we know which old chapter maps to which new chapter
      chapterIdMap[oldChapterId] = newChapterId;
    }

    // 5) Copy subchapters_demo; build a subchapterIdMap
    const subchapterIdMap = {}; // oldSubId -> newSubId

    // For each old chapter, find its subchapters
    for (const oldChapterId of Object.keys(chapterIdMap)) {
      const subchapsSnap = await db
        .collection("subchapters_demo")
        .where("chapterId", "==", oldChapterId)
        .get();

      const newChapterId = chapterIdMap[oldChapterId];

      for (const subDoc of subchapsSnap.docs) {
        const oldSubId = subDoc.id;
        const sData = subDoc.data() || {};

        const newSubData = {
          name: sData.name || "Untitled Subchapter",
          summary: sData.summary || "",
          wordCount: sData.wordCount || 0,
          chapterId: newChapterId,
          bookId: newBookId,
          userId: targetUserId,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        };

        const newSubRef = await db.collection("subchapters_demo").add(newSubData);
        const newSubId = newSubRef.id;

        // Record the mapping from old subchapter ID to new subchapter ID
        subchapterIdMap[oldSubId] = newSubId;
      }
    }

    // 6) Copy subchapterConcepts for each old subchapter => new subchapter
    for (const oldSubId of Object.keys(subchapterIdMap)) {
      const newSubId = subchapterIdMap[oldSubId];
      const conceptsSnap = await db
        .collection("subchapterConcepts")
        .where("subChapterId", "==", oldSubId)
        .get();

      if (!conceptsSnap.empty) {
        for (const cDoc of conceptsSnap.docs) {
          const conceptData = cDoc.data() || {};
          const newConcept = {
            subChapterId: newSubId,
            name: conceptData.name || "",
            summary: conceptData.summary || "",
            subPoints: conceptData.subPoints || [],
            createdAt: admin.firestore.FieldValue.serverTimestamp(),

            // (Optional) If you also want to store who owns it, or which book it belongs to:
            userId: targetUserId,
            bookId: newBookId,  // only if that makes sense in your schema
          };

          await db.collection("subchapterConcepts").add(newConcept);
        }
      }
    }

    // 7) Return success
    res.status(200).json({
      message: "Book cloned successfully!",
      newBookId: newBookId,
    });
  } catch (error) {
    logger.error("Error cloning book:", error);
    res.status(500).json({ error: error.message });
  }
});


// Add this to your existing functions/index.js

exports.bulkExtractConceptsForBook = onDocumentUpdated("books_demo/{bookId}", async (event) => {
  const beforeData = event.data.before?.data() || {};
  const afterData = event.data.after?.data() || {};
  const bookId = event.params.bookId;

  // oldVal => conceptExtractionRequested before
  const oldVal = beforeData.conceptExtractionRequested;
  // newVal => conceptExtractionRequested now
  const newVal = afterData.conceptExtractionRequested;

  // Only proceed if it was false/undefined, and now it's true
  if (!oldVal && newVal) {
    console.log(`bulkExtractConceptsForBook triggered for books_demo/${bookId}`);

    try {
      const db = admin.firestore();

      // 1) Query all subchapters in "subchapters_demo" with matching bookId
      const subChaptersSnap = await db
        .collection("subchapters_demo")
        .where("bookId", "==", bookId)
        .get();

      if (subChaptersSnap.empty) {
        console.log(`No subchapters found for book ID = ${bookId}.`);
      } else {
        // 2) For each matching subchapter, set conceptExtractionRequested = true
        //    which triggers your existing "extractConceptsOnFlag" function
        const batch = db.batch();
        subChaptersSnap.docs.forEach((subChapDoc) => {
          batch.update(subChapDoc.ref, { conceptExtractionRequested: true });
        });
        await batch.commit();
        console.log(
          `Set conceptExtractionRequested=true for ${subChaptersSnap.size} subchapters of book ${bookId}.`
        );
      }

      // 3) Reset the book’s flag so we don’t re-trigger
      await event.data.after.ref.update({
        conceptExtractionRequested: false,
      });

      console.log(`bulkExtractConceptsForBook completed for books_demo/${bookId}`);
    } catch (err) {
      console.error("Error in bulkExtractConceptsForBook:", err);
      // Optionally store error info back to the book doc
      await event.data.after.ref.update({
        conceptExtractionError: err.message || "Unknown error",
        conceptExtractionRequested: false,
      });
    }
  }
});




// If you're not on Node 18, uncomment and install node-fetch:
// import fetch from "node-fetch";

/**
 * cloneToeflBooksOnUserCreate
 *
 * A Cloud Function (v2) that triggers whenever a new user doc is created in
 * Firestore (users/{userId}).
 * 
 * It calls your existing "cloneStandardBook" HTTP function four times,
 * once for each standard book ID.
 */

exports.cloneToeflBooksOnUserCreate = onDocumentCreated(
  "users/{userId}",
  async (event) => {
    const userId = event.params.userId;
    if (!userId) return;

    logger.info(`User created => ${userId}`);

    const standardBookIds = [
      "NwNZ8WWCz54Y4BeCli0c",
      "fuyAbhDo3GXLbtEdZ9jj",
      "5UWQEvQet8GgkZmjEwAO",
      "pFAfUSWtwipFZG2RStKg",
    ];

    const cloneFunctionURL =
      "https://us-central1-comm-app-ff74b.cloudfunctions.net/cloneStandardBook";

    const clonedResults = [];

    try {
      for (const stdBookId of standardBookIds) {
        const resp = await fetch(cloneFunctionURL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            standardBookId: stdBookId,
            targetUserId: userId,
          }),
        });

        if (!resp.ok) {
          const text = await resp.text();
          throw new Error(`Clone request failed: ${resp.status} => ${text}`);
        }
        const data = await resp.json();
        clonedResults.push({ oldBookId: stdBookId, newBookId: data.newBookId });
      }

      await event.data.ref.update({
        clonedToeflBooks: clonedResults,
        updatedAt: Date.now(),
      });

      logger.info("Cloned results:", clonedResults);
    } catch (err) {
      logger.error("Clone error:", err);
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






/**
 * 1) onExamPDFUpload
 * ------------------
 * Triggered whenever a PDF is uploaded to Cloud Storage
 * with metadata.category = "examPaper".
 * We parse the PDF text using pdf-parse, then store it in examPdfExtracts.
 */
exports.onExamPDFUpload = onObjectFinalized(async (event) => {
  try {
    const object = event.data;
    if (!object) {
      logger.info("No object data in event, skipping.");
      return;
    }

    const { contentType, name: filePath, bucket } = object;
    const metadata = object.metadata || {};
    const category = metadata.category || "unspecified";
    const userId = metadata.userId || "unknownUser";
    const bookId = metadata.bookId || "unknown Book";
    const examName = metadata.examName || "Unknown Exam";

    // Only proceed if category = "examPaper"
    if (category !== "examPaper") {
      logger.info(`Skipping: category=${category} is not 'examPaper'.`);
      return;
    }

    // Only proceed if it's a PDF
    if (!contentType || !contentType.includes("pdf")) {
      logger.info(`Skipping: contentType is not a PDF: ${contentType}`);
      return;
    }

    logger.info(`Exam paper PDF detected at path: ${filePath}`);

    // 1) Download PDF to /tmp
    const tempFilePath = path.join("/tmp", path.basename(filePath));
    await storage.bucket(bucket).file(filePath).download({ destination: tempFilePath });
    logger.info(`Exam PDF downloaded locally => ${tempFilePath}`);

    // 2) Parse PDF text
    const pdfBuffer = fs.readFileSync(tempFilePath);
    const pdfData = await pdfParse(pdfBuffer);
    const fullText = pdfData.text || "";
    logger.info(`Parsed exam PDF text length: ${fullText.length}`);

    // 3) Store doc in examPdfExtracts
    //    We'll store raw text, the user info, etc.
    const ref = db.collection("examPdfExtracts").doc();
    await ref.set({
      filePath,
      rawText: fullText,
      category: "examPaper",
      userId,
      bookId,
      examName,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    logger.info(`Created examPdfExtracts doc => ${ref.id}`);
  } catch (err) {
    logger.error("Error in onExamPDFUpload for examPaper:", err);
  }
});

/**
 * 2) parseExamPaperIntoQuestions
 * ------------------------------
 * Triggered when a new doc is created in examPdfExtracts/{docId} with category="examPaper".
 * We call GPT to parse the rawText into a JSON array of questions,
 * then store that array in examQuestionSets.
 */

exports.parseExamPaperIntoQuestions = onDocumentCreated("examPdfExtracts/{docId}", async (event) => {
  try {
    const docSnap = event.data;
    if (!docSnap) {
      logger.info("No doc snapshot found in parseExamPaperIntoQuestions event.");
      return;
    }

    const data = docSnap.data() || {};
    const docId = event.params.docId;
    const { category, rawText, userId, bookId, examName } = data;

    // Only proceed if category = "examPaper"
    if (category !== "examPaper") {
      logger.info(`Doc ${docId} not examPaper => skipping parseExamPaperIntoQuestions.`);
      return;
    }

    // If no text, skip
    if (!rawText) {
      logger.info("No rawText found for examPaper doc, skipping GPT parse.");
      return;
    }

    logger.info(`Parsing exam paper => docId=${docId}, examName="${examName}"`);

    // -------------------------------------------------------
    // 1) Set up OpenAI
    // -------------------------------------------------------
    // (A) Option 1: Use environment variable
    // const openAiKey = process.env.OPENAI_API_KEY;

    // (B) Option 2: Use firebase config: functions.config().openai.apikey
    //   if you did: firebase functions:config:set openai.apikey="sk-..."
    // const openAiKey = functions.config().openai.apikey;

    // For this snippet, we assume environment variable:
    const openAiKey = process.env.OPENAI_API_KEY;
    if (!openAiKey) {
      logger.error("OPENAI_API_KEY not set in env!");
      return;
    }

    const configuration = new Configuration({ apiKey: openAiKey });
    const openai = new OpenAIApi(configuration);

    // -------------------------------------------------------
    // 2) Build GPT prompt
    // -------------------------------------------------------
    const prompt = `
You are analyzing an exam question paper.
Extract each question you find and return a JSON array of objects.
Each object should look like:
{
  "questionNumber": (string or number),
  "questionText": "...",
  "options": ["...","..."] // if multiple-choice,
  "marks": "...",
  "section": "...", 
  "instructions": "...",
  "otherInfo": "..."
}

Do NOT include any extra commentary — only valid JSON.

Exam Paper Text:
${rawText}
`.trim();

    // -------------------------------------------------------
    // 3) Call GPT
    // -------------------------------------------------------
    const completion = await openai.createChatCompletion({
      model: "gpt-3.5-turbo",
      messages: [
        { role: "system", content: "You are a structured data extraction assistant." },
        { role: "user", content: prompt },
      ],
      temperature: 0.7,
    });

    let gptOutput = completion.data.choices[0].message.content.trim();
    logger.info("GPT question extraction output (first 200 chars):", gptOutput.slice(0, 200), "...");

    // -------------------------------------------------------
    // 4) Strip any code fences before parse
    // -------------------------------------------------------
    // GPT might return something like:
    // ```json
    // [ { "questionNumber": 1, "questionText": ... } ]
    // ```
    // That leading ``` would break JSON.parse, so remove them:
    const cleanedOutput = gptOutput
      .replace(/^```(\w+)?/, "") // remove ```json or ```
      .replace(/```$/, "")       // remove final ```
      .trim();

    // Attempt to parse the cleaned JSON
    let parsedQuestions = [];
    try {
      parsedQuestions = JSON.parse(cleanedOutput);
    } catch (jsonErr) {
      logger.error("Error parsing GPT question JSON:", jsonErr);
      return;
    }

    // -------------------------------------------------------
    // 5) Store in examQuestionSets
    // -------------------------------------------------------
    // (One doc containing the entire array of extracted questions)
    const ref = await db.collection("examQuestionSets").add({
      examPdfId: docId,
      userId,
      examName,
      bookId,
      questions: parsedQuestions,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    logger.info(
      `Stored ${parsedQuestions.length} questions in examQuestionSets => docId=${ref.id}`
    );
  } catch (err) {
    logger.error("Error in parseExamPaperIntoQuestions:", err);
  }
});


/**
 * 3) splitExamQuestionSets (Optional)
 * -----------------------------------
 * If you want to create one doc per question, you can do so here.
 * We'll listen for new docs in examQuestionSets/{docId}, 
 * then iterate the 'questions' array to create individual docs in examQuestions.
 */
exports.splitExamQuestionSets = onDocumentCreated("examQuestionSets/{setId}", async (event) => {
  try {
    const docSnap = event.data;
    if (!docSnap) {
      logger.info("No doc snapshot in splitExamQuestionSets event.");
      return;
    }

    const setId = event.params.setId;
    const data = docSnap.data() || {};
    const { userId, bookId, examPdfId, examName, questions } = data;

    if (!questions || !Array.isArray(questions)) {
      logger.info(`No 'questions' array found in examQuestionSets docId=${setId}. Skipping.`);
      return;
    }

    // Create a doc per question in examQuestions
    const batch = admin.firestore().batch();

    questions.forEach((qObj) => {
      const newDocRef = db.collection("examQuestions").doc();
      batch.set(newDocRef, {
        examPdfId,
        userId,
        bookId,
        examName,
        questionNumber: qObj.questionNumber || "",
        questionText: qObj.questionText || "",
        options: qObj.options || [],
        marks: qObj.marks || "",
        section: qObj.section || "",
        instructions: qObj.instructions || "",
        otherInfo: qObj.otherInfo || "",
        parentSetId: setId,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    });

    await batch.commit();
    logger.info(
      `Created ${questions.length} examQuestions docs from examQuestionSets/${setId}.`
    );
  } catch (err) {
    logger.error("Error in splitExamQuestionSets:", err);
  }
});




/**
 * onExamGuidelinesPDFUpload:
 *  - Triggered by a PDF upload with metadata.category = "examGuidelines".
 *  - We parse the PDF text with pdf-parse, store in `examGuidelinesExtracts`.
 */
exports.onExamGuidelinesPDFUpload = onObjectFinalized(async (event) => {
  try {
    const object = event.data;
    if (!object) {
      logger.info("No object data in event, skipping onExamGuidelinesPDFUpload.");
      return;
    }

    const { contentType, name: filePath, bucket } = object;
    const metadata = object.metadata || {};
    const category = metadata.category || "unspecified";
    const userId = metadata.userId || "unknownUser";
    const bookId = metadata.bookId || "unknownUser";
    const examTitle = metadata.examTitle || "UnnamedExamGuidelines";

    // 1) Check if category=examGuidelines
    if (category !== "examGuidelines") {
      logger.info(`Not an examGuidelines PDF. Skipping. category=${category}`);
      return;
    }

    // 2) Check it's actually a PDF
    if (!contentType || !contentType.includes("pdf")) {
      logger.info(`File is not a PDF (${contentType}). Skipping examGuidelines parse.`);
      return;
    }

    logger.info(`Exam Guidelines PDF detected: bucket=${bucket}, path=${filePath}`);

    // Download to /tmp
    const tempFilePath = path.join("/tmp", path.basename(filePath));
    await storage.bucket(bucket).file(filePath).download({ destination: tempFilePath });
    logger.info(`Exam guidelines PDF downloaded locally to ${tempFilePath}`);

    // Parse with pdf-parse
    const pdfBuf = fs.readFileSync(tempFilePath);
    const pdfData = await pdfParse(pdfBuf);
    const fullText = pdfData.text || "";

    // Store in examGuidelinesExtracts
    const ref = db.collection("examGuidelinesExtracts").doc();
    await ref.set({
      filePath,
      rawText: fullText,
      category: "examGuidelines",
      userId,
      bookId,
      examTitle,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    logger.info(`Created doc in examGuidelinesExtracts => ${ref.id}, length=${fullText.length}`);
  } catch (err) {
    logger.error("Error in onExamGuidelinesPDFUpload:", err);
  }
});


/**
 * parseExamGuidelines:
 *  - Trigger: new doc in examGuidelinesExtracts
 *  - If category=examGuidelines, calls GPT to parse rawText => structured JSON
 *  - Then stores in examGuidelinesData collection
 */
exports.parseExamGuidelines = onDocumentCreated("examGuidelinesExtracts/{docId}", async (event) => {
  try {
    const docSnap = event.data;
    if (!docSnap) {
      logger.info("No doc snapshot in parseExamGuidelines.");
      return;
    }

    const data = docSnap.data() || {};
    const docId = event.params.docId;
    const { category, rawText, userId, bookId, examTitle } = data;

    if (category !== "examGuidelines") {
      logger.info(`Doc ${docId} is not examGuidelines => skipping parseExamGuidelines.`);
      return;
    }

    if (!rawText) {
      logger.info("No rawText found => skipping GPT parse for guidelines.");
      return;
    }

    // Set up OpenAI
    // Option A: environment variable
    const openAiKey = process.env.OPENAI_API_KEY;
    // Option B: firebase functions config => e.g. functions.config().openai.apikey
    if (!openAiKey) {
      logger.error("OPENAI_API_KEY not set in env!");
      return;
    }

    const configuration = new Configuration({ apiKey: openAiKey });
    const openai = new OpenAIApi(configuration);

    // Build the prompt with a suggested JSON structure:
    const prompt = `
You are analyzing exam guidelines. Return valid JSON ONLY, in this structure:

{
  "examName": "...",
  "format": "...",
  "timeAllowed": "...",
  "passingScore": "...",
  "sections": [
    {
      "sectionName": "...",
      "marks": "...",
      "timeSuggestion": "...",
      "topics": [
        {
          "topicName": "...",
          "subtopics": [
            { "subtopicName": "...", "notes": "", "weightage": "" }
          ],
          "weightage": "",
          "notes": ""
        }
      ],
      "instructions": ""
    }
  ],
  "overallWeightage": [
    { "topic": "...", "percentage": 0 }
  ],
  "resourcesAllowed": "",
  "scoringRubric": "",
  "examDayInstructions": "",
  "unstructuredText": ""
}

- If some field is not found, leave it blank or empty.
- Place any leftover text or info you can't categorize into "unstructuredText".
- Do NOT wrap your JSON in backticks or code fences. 
- NO extra commentary, only JSON.

Exam Guidelines Source Text:
${rawText}
`.trim();

    logger.info(`parseExamGuidelines => docId=${docId}, examTitle="${examTitle}"`);

    // GPT call
    const completion = await openai.createChatCompletion({
      model: "gpt-3.5-turbo",  // or your chosen model
      messages: [
        { role: "system", content: "You are a structured data extraction assistant." },
        { role: "user", content: prompt },
      ],
      temperature: 0.7,
    });

    let gptOutput = completion.data.choices[0].message.content.trim();
    logger.info("GPT guidelines JSON output (first 200 chars):", gptOutput.slice(0, 200), "...");

    // Strip possible code fences (```) or ```json
    const cleanedOutput = gptOutput
      .replace(/^```(\w+)?/, "") // remove leading ``` or ```json
      .replace(/```$/, "")       // remove trailing ```
      .trim();

    let parsedData;
    try {
      parsedData = JSON.parse(cleanedOutput);
    } catch (jsonErr) {
      logger.error("Error parsing GPT examGuidelines JSON:", jsonErr);
      return;
    }

    // Store in examGuidelinesData
    const newRef = await db.collection("examGuidelinesData").add({
      guidelinesExtractId: docId, // link to the source doc
      userId,
      examTitle,
      bookId,
      structuredGuidelines: parsedData,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    logger.info(`Parsed guidelines JSON stored => docId=${newRef.id}`);
  } catch (err) {
    logger.error("Error in parseExamGuidelines:", err);
  }
});



function getOpenAiKey() {
  // Option A: environment variable
  const key = process.env.OPENAI_API_KEY;
  // Option B: from firebase functions config => functions.config().openai.apikey
  if (!key) {
    logger.error("OPENAI_API_KEY not found in environment!");
  }
  return key;
}

/**
 * mapQuestionsToConceptsHTTP (v2)
 * --------------------------------
 * HTTP endpoint you can call with ?bookId=xxx&userId=xxx
 * 1) Gathers book structure from chapters_demo, subchapters_demo, subchapterConcepts
 * 2) Gathers examQuestions for that bookId
 * 3) Calls GPT: returns questionId -> conceptIds mapping
 * 4) Stores in questionConceptMaps
 */
exports.mapQuestionsToConceptsHTTP = onRequest(async (req, res) => {
  try {
    const { bookId, userId } = req.query;
    if (!bookId || !userId) {
      res.status(400).send("Missing bookId or userId in query params.");
      return;
    }

    logger.info(`mapQuestionsToConceptsHTTP => bookId=${bookId}, userId=${userId}`);

    // 1) Fetch chapters, subchapters, concepts for this book
    const chaptersSnap = await db
      .collection("chapters_demo")
      .where("bookId", "==", bookId)
      .get();
    const chapters = [];
    chaptersSnap.forEach((doc) => {
      chapters.push({ id: doc.id, ...doc.data() });
    });

    const subchaptersSnap = await db
      .collection("subchapters_demo")
      .where("bookId", "==", bookId)
      .get();
    const subchapters = [];
    subchaptersSnap.forEach((doc) => {
      subchapters.push({ id: doc.id, ...doc.data() });
    });

    const conceptsSnap = await db
      .collection("subchapterConcepts")
      .where("bookId", "==", bookId)
      .get();
    const concepts = [];
    conceptsSnap.forEach((doc) => {
      concepts.push({ id: doc.id, ...doc.data() });
    });

    // 2) Fetch questions in examQuestions for this bookId
    const questionsSnap = await db
      .collection("examQuestions")
      .where("bookId", "==", bookId)
      .get();
    const questions = [];
    questionsSnap.forEach((qDoc) => {
      questions.push({ id: qDoc.id, ...qDoc.data() });
    });

    logger.info(
      `Found ${chapters.length} chapters, ${subchapters.length} subchaps, `
      + `${concepts.length} concepts, ${questions.length} questions.`
    );

    // 3) Build GPT prompt
    const openAiKey = getOpenAiKey();
    if (!openAiKey) {
      return res.status(500).send("OPENAI_API_KEY not set in environment!");
    }

    const configuration = new Configuration({ apiKey: openAiKey });
    const openai = new OpenAIApi(configuration);

    // Summarize the book structure as text
    let bookStructureText = "BOOK STRUCTURE:\n";
    chapters.forEach((ch) => {
      bookStructureText += `Chapter: ${ch.name || ch.id}\n`;
      const subchOfChap = subchapters.filter((sc) => sc.chapterId === ch.id);
      subchOfChap.forEach((sc) => {
        bookStructureText += `  Subchapter: ${sc.name || sc.id}\n`;
        const cpts = concepts.filter((c) => c.subChapterId === sc.id);
        cpts.forEach((c) => {
          bookStructureText += `    Concept: ${c.name}, conceptId=${c.id}\n`;
        });
      });
    });

    // Summarize questions
    let questionText = "QUESTIONS:\n";
    questions.forEach((q) => {
      questionText += `QuestionID=${q.id}, text="${q.questionText}"\n`;
    });

    const promptText = `
You are mapping questions to concepts.
We have chapters/subchapters/concepts with IDs:
${bookStructureText}

We also have questions:
${questionText}

Return valid JSON ONLY, in this format:
[
  {
    "questionId": "xyz",
    "conceptIds": ["abc", "def"]
  },
  ...
]
If a question doesn't match any concept, use [] for conceptIds.
No code fences or extra commentary!
`.trim();

    const completion = await openai.createChatCompletion({
      model: "gpt-3.5-turbo", 
      messages: [
        { role: "system", content: "You are a structured data extraction assistant." },
        { role: "user", content: promptText },
      ],
      temperature: 0.7,
    });

    let gptOutput = completion.data.choices[0].message.content.trim();
    logger.info("mapQuestionsToConcepts => GPT output (first 200 chars):", gptOutput.slice(0,200), "...");

    // Clean code fences
    const cleanedOutput = gptOutput
      .replace(/^```(\w+)?/, "")
      .replace(/```$/, "")
      .trim();

    let parsedResult = [];
    try {
      parsedResult = JSON.parse(cleanedOutput);
    } catch (err) {
      logger.error("Error parsing GPT question->concept JSON:", err);
      return res.status(500).send("Failed to parse GPT JSON output. Check logs.");
    }

    // 4) Store doc in "questionConceptMaps"
    const mapDocRef = await db.collection("questionConceptMaps").add({
      userId,
      bookId,
      rawMapping: parsedResult,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    logger.info(`mapQuestionsToConceptsHTTP => created docId=${mapDocRef.id} with ${parsedResult.length} items in rawMapping.`);
    return res.status(200).send(`Mapping doc created => ${mapDocRef.id}`);
  } catch (error) {
    logger.error("Error in mapQuestionsToConceptsHTTP:", error);
    return res.status(500).send("Error occurred. Check logs.");
  }
});

/**
 * onQuestionConceptMapCreated (v2 Firestore)
 * ------------------------------------------
 * Triggered when we create a doc in questionConceptMaps.
 * We read rawMapping: an array of {questionId, conceptIds}.
 * For each item, update the question doc -> concepts: [...]
 * and each concept doc -> questionRefs: arrayUnion(questionId).
 */
exports.onQuestionConceptMapCreated = onDocumentCreated("questionConceptMaps/{docId}", async (event) => {
  try {
    const docSnap = event.data;
    if (!docSnap) {
      logger.info("No doc snapshot in onQuestionConceptMapCreated event.");
      return;
    }

    const data = docSnap.data() || {};
    const { rawMapping, bookId, userId } = data;
    if (!rawMapping || !Array.isArray(rawMapping)) {
      logger.info("No valid rawMapping array found => skipping updates.");
      return;
    }

    logger.info(`onQuestionConceptMapCreated => bookId=${bookId}, mapping length=${rawMapping.length}`);

    const batch = db.batch();

    rawMapping.forEach((item) => {
      const { questionId, conceptIds } = item;
      if (!questionId || !Array.isArray(conceptIds)) return;

      // 1) Update question doc in examQuestions => store concept IDs
      const qRef = db.collection("examQuestions").doc(questionId);
      batch.update(qRef, {
        concepts: conceptIds,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      // 2) For each conceptId => arrayUnion the questionId
      conceptIds.forEach((cId) => {
        const cRef = db.collection("subchapterConcepts").doc(cId);
        batch.set(
          cRef,
          {
            questionRefs: admin.firestore.FieldValue.arrayUnion(questionId),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
      });
    });

    await batch.commit();
    logger.info("onQuestionConceptMapCreated => successfully updated question + concept docs.");
  } catch (err) {
    logger.error("Error in onQuestionConceptMapCreated:", err);
  }
});

/**
 * recalculateConceptScores (v2)
 * -----------------------------
 * HTTP endpoint to re-scan all subchapterConcepts for a given bookId,
 * computing examPresenceScore based on # of questionRefs and question marks.
 * We also factor in the question's "marks" if you want to weight by that.
 */

exports.recalculateConceptScores = onRequest(async (req, res) => {
  try {
    const { bookId } = req.query;
    if (!bookId) {
      return res.status(400).send("Missing bookId.");
    }

    logger.info(`recalculateConceptScores => bookId=${bookId}`);

    // 1) Fetch subchapterConcepts for this book
    const cSnap = await db
      .collection("subchapterConcepts")
      .where("bookId", "==", bookId)
      .get();

    // 2) Fetch examQuestions for this book => build questionMap
    const qSnap = await db
      .collection("examQuestions")
      .where("bookId", "==", bookId)
      .get();

    const questionMap = {};
    qSnap.forEach((qDoc) => {
      questionMap[qDoc.id] = qDoc.data();  // includes .marks, .concepts, etc.
    });

    // We'll store partial sums in memory first
    // conceptScores[conceptDoc.id] = numeric partialSum
    const conceptScores = {};

    cSnap.forEach((conceptDoc) => {
      conceptScores[conceptDoc.id] = 0; // initialize to 0
    });

    // First pass: sum partial marks for each concept
    cSnap.forEach((conceptDoc) => {
      const conceptData = conceptDoc.data() || {};
      const questionRefs = conceptData.questionRefs || [];

      let totalMarks = 0;

      questionRefs.forEach((qId) => {
        const qObj = questionMap[qId] || {};
        const qMarks = qObj.marks || 0;
        const qConcepts = qObj.concepts || []; // The array of conceptIds that question references

        if (qConcepts.length > 0) {
          // Dividing the question's total marks among all concepts it references
          const fraction = qMarks / qConcepts.length;
          totalMarks += fraction;
        } else {
          // If somehow question has no .concepts array, fallback
          totalMarks += qMarks;
        }
      });

      // Store this raw sum in conceptScores
      conceptScores[conceptDoc.id] = totalMarks;
    });

    // Second pass: sum ALL partial scores => normalize to 0..100
    let grandTotal = 0;
    Object.values(conceptScores).forEach((val) => {
      grandTotal += val;
    });

    logger.info(`Total partial exam score across all concepts => ${grandTotal}`);

    // We'll do a final batch update
    let batch = db.batch();
    let opsCount = 0;

    // Normalize each concept's score
    for (const cid of Object.keys(conceptScores)) {
      let rawScore = conceptScores[cid];
      let normalized = 0;
      if (grandTotal > 0) {
        normalized = (rawScore / grandTotal) * 100;
      }

      const ref = db.collection("subchapterConcepts").doc(cid);
      batch.update(ref, { examPresenceScore: normalized });
      opsCount++;

      if (opsCount >= 400) {
        await batch.commit();
        batch = db.batch();
        opsCount = 0;
      }
    }

    if (opsCount > 0) {
      await batch.commit();
    }

    logger.info("recalculateConceptScores => done with normalization to 0..100.");
    return res.status(200).send("Concept scores recalculated & normalized (0..100)!");
  } catch (err) {
    logger.error("Error in recalculateConceptScores:", err);
    return res.status(500).send("Error recalculating concept scores. Check logs.");
  }
});




/**
 * mapGuidelinesToConceptScoresHTTP (v2)
 * --------------------------------------
 * An HTTP function called via e.g.
 *   GET/POST ?bookId=xxx&guidelinesDocId=yyy
 * 
 * Steps:
 *  1) Read the doc in `examGuidelinesExtracts` => get rawText
 *  2) Gather all concepts for that `bookId`
 *  3) Prompt GPT: "Here is the guidelines text + concept list => produce an array of { conceptId, presenceScore }"
 *  4) Store that mapping in `guidelinesConceptMaps` => triggers next function
 */




exports.mapGuidelinesToConceptScores2 = onRequest(async (req, res) => {
  try {
    const { bookId, guidelinesDocId } = req.query;
    if (!bookId || !guidelinesDocId) {
      return res.status(400).send("Missing bookId or guidelinesDocId in query params.");
    }

    logger.info(`mapGuidelinesToConceptScoresHTTP => bookId=${bookId}, guidelinesDocId=${guidelinesDocId}`);

    // 1) Read examGuidelinesExtracts/{guidelinesDocId} => rawText
    const guidDoc = await db.collection("examGuidelinesExtracts").doc(guidelinesDocId).get();
    if (!guidDoc.exists) {
      return res.status(404).send("No examGuidelinesExtracts doc found for that guidelinesDocId.");
    }
    const guidData = guidDoc.data() || {};
    const rawText = guidData.rawText || "";
    if (!rawText) {
      return res.status(400).send("No rawText found in that guidelines doc. Cannot proceed.");
    }

    // 2) Gather subchapterConcepts for the book => concept list
    const conceptsSnap = await db
      .collection("subchapterConcepts")
      .where("bookId", "==", bookId)
      .get();
    const concepts = [];
    conceptsSnap.forEach((doc) => {
      concepts.push({ id: doc.id, ...doc.data() });
    });

    logger.info(`Found ${concepts.length} concepts for bookId=${bookId}.`);

    // Build a text summary of concept IDs
    let conceptListText = "Concept List:\n";
    concepts.forEach((c) => {
      conceptListText += `conceptName="${c.name}", conceptId="${c.id}"\n`;
    });

    // 3) Call GPT
    const openAiKey = getOpenAiKey();
    if (!openAiKey) {
      return res.status(500).send("OPENAI_API_KEY not set in environment!");
    }

    const configuration = new Configuration({ apiKey: openAiKey });
    const openai = new OpenAIApi(configuration);

    const prompt = `
We have an exam guidelines text and a list of concepts (with IDs).
Please analyze the guidelines text, and for each conceptId, assign a numeric "presenceScore" from 0..100,
reflecting how important or relevant that concept is according to the guidelines.

Return valid JSON ONLY, in the form:
[
  {
    "conceptId": "...",
    "score": 0
  },
  ...
]

No extra commentary or code fences.

Guidelines Text:
${rawText}

${conceptListText}
`.trim();

    const completion = await openai.createChatCompletion({
      model: "gpt-3.5-turbo",
      messages: [
        { role: "system", content: "You are a structured data extraction assistant." },
        { role: "user", content: prompt },
      ],
      temperature: 0.7,
    });

    let gptOutput = completion.data.choices[0].message.content.trim();
    logger.info("mapGuidelinesToConceptScoresHTTP => GPT output (first 200 chars):", gptOutput.slice(0,200), "...");

    // Clean code fences if present
    const cleaned = gptOutput
      .replace(/^```(\w+)?/, "")
      .replace(/```$/, "")
      .trim();

    let parsedResult = [];
    try {
      parsedResult = JSON.parse(cleaned);
    } catch (err) {
      logger.error("Error parsing GPT guidelines->concept JSON:", err);
      return res.status(500).send("Failed to parse GPT JSON. Check logs.");
    }

    // 5) Store in guidelinesConceptMaps => triggers next function
    const mapDocRef = await db.collection("guidelinesConceptMaps").add({
      bookId,
      guidelinesDocId,
      rawMapping: parsedResult,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    logger.info(`mapGuidelinesToConceptScoresHTTP => created doc in guidelinesConceptMaps => docId=${mapDocRef.id} with ${parsedResult.length} items.`);
    return res.status(200).send(`Guidelines->Concept map doc created => ${mapDocRef.id}`);
  } catch (error) {
    logger.error("Error in mapGuidelinesToConceptScoresHTTP:", error);
    return res.status(500).send("Error occurred. Check logs.");
  }
});

/**
 * onGuidelinesConceptMapCreated (v2)
 * ----------------------------------
 * Firestore trigger for docs in `guidelinesConceptMaps`.
 * We read `rawMapping`: an array of { conceptId, score } from GPT.
 * Then we update each concept doc => `guidelinePresenceScore = score`.
 */



exports.onGuidelinesConceptMapCreated = onDocumentCreated("guidelinesConceptMaps/{docId}", async (event) => {
  try {
    const docSnap = event.data;
    if (!docSnap) {
      logger.info("No doc snapshot in onGuidelinesConceptMapCreated event.");
      return;
    }

    const data = docSnap.data() || {};
    const { rawMapping, bookId, guidelinesDocId } = data;
    if (!Array.isArray(rawMapping)) {
      logger.info("No valid array found in rawMapping => skipping.");
      return;
    }

    logger.info(`onGuidelinesConceptMapCreated => docId=${event.params.docId}, length=${rawMapping.length}`);

    // 1) First, sum all raw scores
    let total = 0;
    rawMapping.forEach((item) => {
      if (item && typeof item.score === "number") {
        total += item.score;
      }
    });

    logger.info(`Sum of all raw GPT scores => ${total}`);

    // 2) We'll do a second pass, compute fraction => store in subchapterConcepts
    const batch = db.batch();
    let opsCount = 0;

    rawMapping.forEach((item) => {
      const { conceptId, score } = item;
      if (!conceptId || typeof score !== "number") return;

      // fraction = (score / total) * 100 if total > 0, else 0
      let fraction = 0;
      if (total > 0) {
        fraction = (score / total) * 100;
      }

      const cRef = db.collection("subchapterConcepts").doc(conceptId);

      // We'll store guidelinePresenceScore as the normalized fraction
      batch.update(cRef, {
        guidelinePresenceScore: fraction,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      opsCount++;

      // if ops get too big, commit partial batch
      if (opsCount >= 400) {
        batch.commit();
        opsCount = 0;
      }
    });

    if (opsCount > 0) {
      await batch.commit();
    }

    logger.info("onGuidelinesConceptMapCreated => normalized & updated guidelinePresenceScore for all concepts.");
  } catch (err) {
    logger.error("Error in onGuidelinesConceptMapCreated:", err);
  }
});




/**
 * classifyQuestionDepthHTTP (v2)
 * ------------------------------
 * Trigger with:  GET/POST ?bookId=xxx&userId=yyy
 *
 * 1) Fetch examQuestions for that bookId & userId
 * 2) For each question:
 *    - gather the subchapter content for the subchapters that are relevant
 *      (based on the question's concept array -> each concept doc -> subChapterId -> subchapters_demo doc)
 *    - build a GPT prompt
 *    - call GPT => parse JSON => store result in the question doc
 */
exports.classifyQuestionDepthHTTP = onRequest(async (req, res) => {
  try {
    const { bookId, userId } = req.query;
    if (!bookId || !userId) {
      return res.status(400).send("Missing bookId or userId in query params.");
    }

    logger.info(`classifyQuestionDepthHTTP => bookId=${bookId}, userId=${userId}`);

    // 1) Fetch examQuestions for this bookId & userId
    const qSnap = await db
      .collection("examQuestions")
      .where("bookId", "==", bookId)
      .where("userId", "==", userId)
      .get();
    if (qSnap.empty) {
      return res.status(200).send("No examQuestions found for that book/user.");
    }

    // 2) We'll also need a quick way to get subchapter content
    //    We'll build a cache: subchapterContents[subChId] = { fullText, name, etc. }
    const subchapterCache = {};

    // 3) We'll set up GPT
    const openAiKey = getOpenAiKey();
    if (!openAiKey) {
      return res.status(500).send("No OPENAI_API_KEY set!");
    }
    const configuration = new Configuration({ apiKey: openAiKey });
    const openai = new OpenAIApi(configuration);

    let processedCount = 0;
    // We'll do a for..of or forEach, but note that async in a forEach can cause concurrency issues.
    // For simplicity, let's do a for..of loop so we can do sequential GPT calls.
    const questionDocs = qSnap.docs;

    for (const qDoc of questionDocs) {
      const questionData = qDoc.data();
      const questionId = qDoc.id;

      logger.info(`Processing questionId=${questionId}`);

      // 2a) Gather subchapter content from the question's concepts
      //     questionData.concepts = [conceptId1, conceptId2...]
      // We'll fetch each concept's doc => subChapterId => subchapters_demo doc => store in subchapterCache
      const conceptIds = questionData.concepts || [];
      const subchapTexts = await buildSubchapterContext(conceptIds, subchapterCache);

      // 2b) Build GPT prompt
      // We'll pass in the question text, marks, type, etc.
      // We'll also pass subchapter context(s).
      const promptText = createPromptForQuestion({
        questionObj: questionData,
        questionId,
        subchapterTexts: subchapTexts,  // array of { subChapterId, subName, fullText, conceptList }
      });

      logger.info(`Prompt length for Q=${questionId} => ${promptText.length} chars.`);

      // 2c) Call GPT
      const completion = await openai.createChatCompletion({
        model: "gpt-3.5-turbo", // or your model
        messages: [
          { role: "system", content: "You are a structured classification assistant." },
          { role: "user", content: promptText },
        ],
        temperature: 0.7,
      });

      const gptOutput = completion.data.choices[0].message.content.trim();
      logger.info(`GPT output for Q=${questionId} (first 200 chars): ${gptOutput.slice(0, 200)}...`);

      // 2d) We expect GPT to return JSON. We'll parse it
      let parsed;
      try {
        const cleaned = gptOutput
          .replace(/^```(\w+)?/, "")
          .replace(/```$/, "")
          .trim();
        parsed = JSON.parse(cleaned);
      } catch (err) {
        logger.error(`Error parsing GPT JSON for questionId=${questionId}`, err);
        // We'll store an error field
        await qDoc.ref.update({
          classificationError: "Failed to parse GPT JSON",
          classificationRaw: gptOutput,
        });
        continue; // move to next question
      }

      // 2e) Now we have something like:
      // {
      //   "questionType": "multipleChoice",
      //   "bloomLevels": ["Understand", "Apply"], 
      //   "reasoning": "...optional explanation..."
      //   ...
      // }
      // We'll store these in the question doc
      await qDoc.ref.update({
        questionType: parsed.questionType || null,
        bloomLevels: parsed.bloomLevels || [],
        classificationJSON: parsed, // keep raw if you want
        classificationTime: admin.firestore.FieldValue.serverTimestamp(),
      });

      processedCount++;
      logger.info(`QuestionId=${questionId} => classification updated in examQuestions.`);

      // (Optional) if you worry about time/cost, you can do a short pause or break early
    }

    return res.status(200).send(`Processed ${processedCount} questions for classification.`);
  } catch (err) {
    logger.error("Error in classifyQuestionDepthHTTP:", err);
    return res.status(500).send("Error. Check logs.");
  }
});

/**
 * buildSubchapterContext
 * ----------------------
 * For each conceptId, fetch concept doc => subChapterId => fetch subchapter doc 
 * => gather subchapter content. We'll store in subchapterCache so we don't re-fetch.
 * 
 * We'll return an array of { subChapterId, subName, fullText, conceptList: [...] } 
 * so we can unify multiple concepts from the same subchapter in one block of text.
 */
async function buildSubchapterContext(conceptIds, cache) {
  // We'll build a map: subChId => { subChapterId, subName, fullText, conceptIds: [] }
  const subMap = {};

  // 1) fetch concept docs
  const conceptDocs = [];
  for (const cId of conceptIds) {
    const cRef = db.collection("subchapterConcepts").doc(cId);
    const cSnap = await cRef.get();
    if (cSnap.exists) {
      const cData = cSnap.data();
      conceptDocs.push({ cId, ...cData });
    }
  }

  // 2) For each concept doc => subChapterId => fetch subchapters_demo doc if not cached
  for (const cObj of conceptDocs) {
    const scId = cObj.subChapterId;
    if (!scId) continue;

    // check subMap
    if (!subMap[scId]) {
      // fetch from cache or Firestore
      if (!cache[scId]) {
        // fetch from subchapters_demo
        const scRef = db.collection("subchapters_demo").doc(scId);
        const scSnap = await scRef.get();
        if (!scSnap.exists) {
          cache[scId] = { subChapterId: scId, name: `subch(${scId})`, fullText: "No content found." };
        } else {
          const scData = scSnap.data();
          const scName = scData.name || `subch(${scId})`;
          const scContent = scData.fullText || scData.content || "No subchapter text found.";
          cache[scId] = { subChapterId: scId, name: scName, fullText: scContent };
        }
      }
      // create subMap entry
      subMap[scId] = {
        subChapterId: scId,
        subName: cache[scId].name,
        fullText: cache[scId].fullText,
        conceptIds: [],
      };
    }

    // add this concept to subMap[scId].conceptIds
    subMap[scId].conceptIds.push({ conceptId: cObj.cId, conceptName: cObj.name || cObj.id });
  }

  // 3) return array
  return Object.values(subMap).map((obj) => {
    return {
      subChapterId: obj.subChapterId,
      subName: obj.subName,
      fullText: obj.fullText,
      conceptList: obj.conceptIds, 
    };
  });
}

/**
 * createPromptForQuestion
 * -----------------------
 * Build the prompt text for GPT. We include:
 *  - question text
 *  - question marks
 *  - subchapter content
 *  - concept list
 * Then we instruct GPT to classify question type & bloom level, returning JSON.
 */
function createPromptForQuestion({ questionObj, questionId, subchapterTexts }) {
  // questionObj might have questionText, marks, options if MCQ, etc.
  const qText = questionObj.questionText || "No question text";
  const qMarks = questionObj.marks || 0;
  const qOptions = questionObj.options || []; // if it's a multipleChoice style
  let optionsBlock = "";
  if (qOptions.length > 0) {
    optionsBlock = "\nOptions:\n" + qOptions.map((opt, i) => ` - ${opt}`).join("\n");
  }

  // subchapterTexts is an array of { subChapterId, subName, fullText, conceptList:[{conceptId, conceptName}]}
  let subchBlock = "";
  subchapterTexts.forEach((sc) => {
    subchBlock += `\n--- Subchapter: ${sc.subName} (ID=${sc.subChapterId})\n`;
    subchBlock += `Concepts:\n`;
    sc.conceptList.forEach((c) => {
      subchBlock += `   - ${c.conceptName} (conceptId=${c.conceptId})\n`;
    });
    subchBlock += `Content:\n${sc.fullText}\n\n`;
  });

  // The final instructions:
  const instructions = `
You are classifying a single exam question in detail. 
We provide:
 - The question text and marks
 - Possibly MCQ options
 - Subchapter contents + concept info to show context

Return valid JSON ONLY with fields:
{
  "questionType": "...",   // e.g. "multipleChoice", "shortAnswer", "longForm", ...
  "bloomLevels": ["..."],  // array of one or more Bloom's taxonomy levels ("Remember","Understand","Apply","Analyze","Evaluate","Create")
  "notes": "short explanation if needed"
}

No code fences, no extra commentary—only valid JSON.

Question:
ID=${questionId}, marks=${qMarks}
Text: ${qText}
${optionsBlock}

Subchapter Context:
${subchBlock}
`.trim();

  return instructions;
}