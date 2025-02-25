// routes/rootRoute.js

const express = require("express");
const router = express.Router();

// Move the route logic here
router.get("/", (req, res) => {
  res.send("Backend server is running!");
});

module.exports = router;