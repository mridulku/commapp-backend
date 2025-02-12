const admin = require("firebase-admin");
const bcrypt = require("bcryptjs");

// Import the Firebase service account key
const serviceAccount = require("./firebase-key.json");

// Initialize Firebase Admin
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

// Function to add a user
async function addUser(username, password, role, preferences) {
  try {
    // Hash the password for security
    const hashedPassword = await bcrypt.hash(password, 10);

    // Add the user to the Firestore "users" collection
    await db.collection("users").add({
      username,
      password: hashedPassword,
      role,
      preferences,
    });

    console.log(`User ${username} added successfully!`);
  } catch (error) {
    console.error("Error adding user:", error);
  }
}

// Add users by calling addUser() with desired data
async function main() {
//  await addUser("john_doe", "password123", "admin", { theme: "dark" });
//  await addUser("jane_smith", "secure456", "user", { theme: "light" });
await addUser("ycombinator1", "password123", "user", { theme: "dark" });
await addUser("ycombinator2", "password123", "user", { theme: "dark" });
await addUser("ycombinator3", "password123", "user", { theme: "dark" });
await addUser("ycombinator4", "password123", "user", { theme: "dark" });
await addUser("ycombinator5", "password123", "user", { theme: "dark" });
  process.exit(); // Exit the script once done
}

main();
