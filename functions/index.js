/**
 * index.js
 *
 * This Cloud Function triggers on PDF uploads, parses the PDF using
 * "pdf-parse", and stores the extracted text in Firestore.
 */

const{onObjectFinalized}=require("firebase-functions/v2/storage");
const logger=require("firebase-functions/logger");
const admin=require("firebase-admin");
const pdfParse=require("pdf-parse");
const{Storage}=require("@google-cloud/storage");
const fs=require("fs");
const path=require("path");

admin.initializeApp();

const storage=new Storage();

exports.onPDFUpload=onObjectFinalized(
  async(event)=>{
    try {
      const object=event.data;
      const bucketName=object.bucket;
      const filePath=object.name;
      const contentType=object.contentType;

      if(!contentType||!contentType.includes("pdf")) {
        logger.info("Not a PDF, ignoring...");
        return;
      }

      logger.info(`PDF detected at path: ${filePath}`);

      const tempFilePath=path.join(
        "/tmp",
        path.basename(filePath)
      );

      await storage.bucket(bucketName).file(filePath)
        .download({destination: tempFilePath});

      logger.info(`PDF downloaded locally to ${tempFilePath}`);

      const dataBuffer=fs.readFileSync(tempFilePath);
      const parsed=await pdfParse(dataBuffer);
      const rawText=parsed.text;

      logger.info(`Parsed PDF text length: ${rawText.length}`);

      const db=admin.firestore();
      await db.collection("pdfExtracts").add({
        filePath,
        text: rawText,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      logger.info("Successfully stored PDF text in Firestore.");
    } catch(error) {
      logger.error("Error in onPDFUpload function:", error);
    }
  }
);