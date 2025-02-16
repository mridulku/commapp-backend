require('dotenv').config();
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { Configuration, OpenAIApi } = require('openai');

// 1. Setup Express
const app = express();
const port = process.env.PORT || 3000;

// 2. Configure Multer to store uploads in "uploads" folder
//    (Multer will create the folder if it doesn't exist)
const upload = multer({ dest: 'uploads/' });

// 3. Setup OpenAI Client
const configuration = new Configuration({
  apiKey: process.env.OPENAI_API_KEY,
});
const openai = new OpenAIApi(configuration);

// 4. Helper function: read file & encode as Base64
function encodeImageToBase64(filePath) {
  const imageBuffer = fs.readFileSync(filePath);
  return Buffer.from(imageBuffer).toString('base64');
}

/**
 * Endpoint: POST /ask-vision
 * Expects: form-data with key="image" containing an image file
 */
app.post('/ask-vision', upload.single('image'), async (req, res) => {
  try {
    // A) Check if a file was actually uploaded
    if (!req.file) {
      return res.status(400).json({ error: 'No image file uploaded.' });
    }

    // B) Convert uploaded file to Base64
    const base64Image = encodeImageToBase64(req.file.path);
    const extension = path.extname(req.file.originalname).replace('.', '') || 'jpeg';

    // C) Construct the "messages" payload with an embedded base64-encoded image
    const messages = [
      {
        role: 'user',
        content: [
          // 1) The text prompt/question
          {
            type: 'text',
            text: 'What is in this image?'
          },
          // 2) The base64-encoded image
          {
            type: 'image_url',
            image_url: {
              url: `data:image/${extension};base64,${base64Image}`,
              // Optionally specify detail: "low", "high", or "auto" (default is "auto")
              detail: 'auto'
            },
          },
        ],
      },
    ];

    // D) Send request to a vision-capable model
    //    e.g., "gpt-4o-mini", "gpt-4o", "o1", or "gpt-4-turbo" (with vision)
    const response = await openai.createChatCompletion({
      model: 'gpt-4o-mini',     // or whichever vision model is appropriate
      messages,
      max_tokens: 300,          // feel free to adjust
    });

    // E) Extract the model’s reply
    const assistantMessage = response.data.choices[0].message.content;

    // F) Cleanup: remove the temporary file after reading
    fs.unlink(req.file.path, (err) => {
      if (err) console.error('Error deleting temp file:', err);
    });

    // G) Send the AI's answer back to the client
    return res.json({
      success: true,
      answer: assistantMessage,
    });

  } catch (error) {
    console.error('Error in /ask-vision route:', error);
    return res.status(500).json({ error: 'Something went wrong processing the image.' });
  }
});

// 5. Start the server
app.listen(port, () => {
  console.log(`Server listening at http://localhost:${port}`);
});