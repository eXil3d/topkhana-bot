const botApi = require('node-telegram-bot-api');
const admin = require('firebase-admin');
const express = require('express');

// --- 1. BULLETPROOF CONSTRUCTOR EXTRACTION ---
// Resolves the 'is not a constructor' bug across different deployment setups
let TelegramBot;
if (typeof botApi === 'function') {
  TelegramBot = botApi;
} else if (botApi && typeof botApi.default === 'function') {
  TelegramBot = botApi.default;
} else {
  console.error("❌ CRITICAL: Could not find a valid TelegramBot constructor in node-telegram-bot-api.");
  process.exit(1); 
}

// --- 2. RENDER HEALTH CHECK SERVER ---
const app = express();
app.use(express.json()); // Prepares the server if you transition to webhooks later

app.get('/', (req, res) => res.send('Topkhana Bot is running 24/7!'));

const port = process.env.PORT || 3000;
// Render containers strictly require binding to 0.0.0.0 to pass health checks
app.listen(port, '0.0.0.0', () => {
  console.log(`🚀 Web server listening on port \${port}`);
});

// --- 3. INITIALIZE BOT & FIREBASE ---
const token = process.env.TELEGRAM_TOKEN;

if (!token) {
  console.error("❌ CRITICAL ERROR: TELEGRAM_TOKEN environment variable is missing in Render!");
  process.exit(1);
}

// Initialize the bot safely
let bot;
try {
  bot = new TelegramBot(token, { polling: true });
  console.log("✅ TelegramBot initialized successfully!");
} catch (error) {
  console.error("❌ Failed to instantiate TelegramBot:", error.message);
  process.exit(1);
}

// Initialize Firebase securely via Render Environment Variables
try {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      // Fixed potential newline rendering issues common in environment strings
      privateKey: process.env.FIREBASE_PRIVATE_KEY ? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n') : undefined,
    })
  });
  console.log("✅ Firebase Admin initialized successfully!");
} catch (error) {
  console.error("❌ Firebase Initialization Error:", error.message);
}

const db = admin.firestore();
const formatWord = (str) => str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();

// --- 4. ADD SPENDING COMMAND (Supports multiple amounts) ---
bot.onText(/^add\s+([a-zA-Z]+)\s+([a-zA-Z]+)\s+([\d\.\s]+)$/i, async (msg, match) => {
  const chatId = msg.chat.id;
  const person = formatWord(match[1]);
  const category = formatWord(match[2]);
  
  const amountString = match[3].trim();
  const amountArray = amountString.split(/\s+/).map(Number);
  const totalAmount = amountArray.reduce((sum, curr) => sum + curr, 0);

  const validMembers = ["Aomy", "Mahin", "Piash", "Sayem", "Inan", "Pulok"];
  const validCategories = ["Bazar", "Electricity", "Gas", "Water", "Internet"];

  if (!validMembers.includes(person)) return bot.sendMessage(chatId, `❌ Invalid person. Must be: \${validMembers.join(", ")}`);
  if (!validCategories.includes(category)) return bot.sendMessage(chatId, `❌ Invalid category. Must be: \${validCategories.join(", ")}`);
  if (isNaN(totalAmount) || totalAmount <= 0) return bot.sendMessage(chatId, `❌ Invalid amounts provided.`);

  try {
    await db.collection("topkhana_expenses").add({
      person,
      category,
      amount: totalAmount,
      createdAt: Date.now()
    });
    
    const calculationNote = amountArray.length > 1 ? ` (amountArray.join(" + ") = {totalAmount})` : ``;
    bot.sendMessage(chatId, `✅ Added ${totalAmount} Tk${calculationNote} for ${person} in ${category}!`);
  } catch (error) {
    bot.sendMessage(chatId, `❌ Error saving to database: ${error.message}`);
  }
});

// --- HELPER FUNCTION: GENERATE SUMMARY TEXT ---
const generateSummaryText = (title, expenses) => {
  const bazarTotal = expenses.filter(e => e.category === "Bazar").reduce((sum, e) => sum + e.amount, 0);
  const billsTotal = expenses.filter(e => e.category !== "Bazar").reduce((sum, e) => sum + e.amount, 0);
  const total = bazarTotal + billsTotal;

  let text = `📊 *${title} Summary*\n\n`;
  text += `🛒 *Total Bazar: ${bazarTotal.toFixed(2)} Tk*\n`;
  
  const bazarMap = {};
  expenses.filter(e => e.category === "Bazar").forEach(e => {
    bazarMap[e.person] = (bazarMap[e.person] || 0) + e.amount;
  });
  for (const [p, amt] of Object.entries(bazarMap)) {
    text += `  • ${p}: ${amt} Tk\n`;
  }

  text += `\n💡 *Total Bills: ${billsTotal.toFixed(2)} Tk*\n`;
  
  const billsMap = {};
  expenses.filter(e => e.category !== "Bazar").forEach(e => {
    billsMap[e.person] = (billsMap[e.person] || 0) + e.amount;
  });
  for (const [p, amt] of Object.entries(billsMap)) {
    const pBills = expenses.filter(e => e.person === p && e.category !== "Bazar").map(e => `${e.category}: ${e.amount}`).join(", ");
    text += `  • ${p} (${pBills}): ${amt} Tk\n`;
  }

  text += `\n💰 *Grand Total: ${total.toFixed(2)} Tk*`;
  return text;
};

// --- 5. CURRENT MONTH SUMMARY COMMAND ---
bot.onText(/^summary\$/i, async (msg) => {
  const chatId = msg.chat.id;
  try {
    const metaDoc = await db.collection("topkhana").doc("metadata").get();
    const currentMonthName = metaDoc.exists ? metaDoc.data().currentMonthName : "Current Month";
    
    const snapshot = await db.collection("topkhana_expenses").get();
    if (snapshot.empty) return bot.sendMessage(chatId, `No expenses recorded for ${currentMonthName} yet.`);
    
    const expenses = snapshot.docs.map(doc => doc.data());
    bot.sendMessage(chatId, generateSummaryText(currentMonthName, expenses), { parse_mode: 'Markdown' });
  } catch (error) {
    bot.sendMessage(chatId, `❌ Error fetching summary: ${error.message}`);
  }
});

// --- 6. ARCHIVED MONTH SUMMARY COMMAND ---
bot.onText(/^summary\s+([a-zA-Z]+)\s+(\d{4})\$/i, async (msg, match) => {
  const chatId = msg.chat.id;
  const searchTitle = `${formatWord(match[1])} ${match[2]}`;
  
  try {
    const snapshot = await db.collection("topkhana_history").get();
    const targetMonth = snapshot.docs.map(d => d.data()).find(h => h.title === searchTitle);
    
    if (!targetMonth) return bot.sendMessage(chatId, `❌ Could not find an archive for "${searchTitle}".`);

    bot.sendMessage(chatId, generateSummaryText(targetMonth.title, targetMonth.expenses), { parse_mode: 'Markdown' });
  } catch (error) {
    bot.sendMessage(chatId, `❌ Error fetching history: ${error.message}`);
  }
});

// Global runtime error handler to prevent Render from crashing completely on minor network drops
process.on('unhandledRejection', (reason, promise) => {
  console.error('⚠️ Unhandled Rejection at:', promise, 'reason:', reason);
});

console.log("Topkhana Telegram Bot system active!");
