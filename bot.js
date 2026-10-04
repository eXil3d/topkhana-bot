// --- 1. RESOLVE TELEGRAF CONSTRUCTOR ---
const express = require('express');
const admin = require('firebase-admin');
let TelegrafModule;

try {
  TelegrafModule = require('telegraf');
} catch (e) {
  console.error("❌ CRITICAL: 'telegraf' module could not be required.");
  process.exit(1);
}

// Extract Telegraf class safely
const Telegraf = TelegrafModule.Telegraf || TelegrafModule;
if (!Telegraf) {
  console.error("❌ CRITICAL: Could not find a valid Telegraf constructor.");
  process.exit(1);
}

// --- 2. INITIALIZE BOT & FIREBASE ---
const token = process.env.TELEGRAM_TOKEN;
if (!token) {
  console.error("❌ CRITICAL ERROR: TELEGRAM_TOKEN environment variable is missing!");
  process.exit(1);
}

// Initialize Telegraf bot instance safely
let bot;
try {
  bot = new Telegraf(token);
  console.log("✅ Telegraf bot initialized successfully!");
} catch (error) {
  console.error("❌ Failed to instantiate Telegraf:", error.message);
  process.exit(1);
}

// Initialize Firebase securely via Render Environment Variables
try {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY ? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n') : undefined,
    })
  });
  console.log("✅ Firebase Admin initialized successfully!");
} catch (error) {
  console.error("❌ Firebase Initialization Error:", error.message);
}

const db = admin.firestore();
const formatWord = (str) => str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();

// --- 3. RENDER HEALTH CHECK & WEBHOOK SERVER ---
const app = express();
app.use(express.json());

// Main Health Check
app.get('/', (req, res) => res.send('Topkhana Bot is running 24/7!'));

// Render requires binding to 0.0.0.0
const port = process.env.PORT || 3000;
app.listen(port, '0.0.0.0', async () => {
  console.log(`🚀 Web server listening on port \${port}`);
  
  // Set up Telegraf handling for webhook requests or long polling safely
  try {
    if (process.env.RENDER_EXTERNAL_URL) {
      const webhookUrl = `\({process.env.RENDER_EXTERNAL_URL}/bot\){token}`;
      await bot.telegram.setWebhook(webhookUrl);
      console.log(`📡 Webhook configured successfully to: \${webhookUrl}`);
      
      // Hook up the express router handling for Telegraf updates securely
      app.use(bot.webhookCallback(`/bot\${token}`));
    } else {
      // Fallback to long polling if not running on Render environment variables
      bot.launch();
      console.log("🔄 Started bot using long polling mode.");
    }
  } catch (err) {
    console.error("⚠️ Bot launch notification failed:", err.message);
  }
});

// --- 4. ADD SPENDING COMMAND (Supports multiple amounts) ---
// Telegraf uses hears() or raw text matching hooks instead of onText regex patterns
bot.hears(/^add\s+([a-zA-Z]+)\s+([a-zA-Z]+)\s+([\d\.\s]+)$/i, async (ctx) => {
  const chatId = ctx.chat.id;
  const match = ctx.match;
  
  const person = formatWord(match[1]);
  const category = formatWord(match[2]);
  
  const amountString = match[3].trim();
  const amountArray = amountString.split(/\s+/).map(Number);
  const totalAmount = amountArray.reduce((sum, curr) => sum + curr, 0);

  const validMembers = ["Aomy", "Mahin", "Piash", "Sayem", "Inan", "Pulok"];
  const validCategories = ["Bazar", "Electricity", "Gas", "Water", "Internet"];

  if (!validMembers.includes(person)) return ctx.reply(`❌ Invalid person. Must be: \${validMembers.join(", ")}`);
  if (!validCategories.includes(category)) return ctx.reply(`❌ Invalid category. Must be: \${validCategories.join(", ")}`);
  if (isNaN(totalAmount) || totalAmount <= 0) return ctx.reply(`❌ Invalid amounts provided.`);

  try {
    await db.collection("topkhana_expenses").add({
      person,
      category,
      amount: totalAmount,
      createdAt: Date.now()
    });
    
    const calculationNote = amountArray.length > 1 ? ` (amountArray.join(" + ") = {totalAmount})` : ``;
    ctx.reply(`✅ Added ${totalAmount} Tk${calculationNote} for ${person} in ${category}!`);
  } catch (error) {
    ctx.reply(`❌ Error saving to database: ${error.message}`);
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
bot.hears(/^summary\$/i, async (ctx) => {
  try {
    const metaDoc = await db.collection("topkhana").doc("metadata").get();
    const currentMonthName = metaDoc.exists ? metaDoc.data().currentMonthName : "Current Month";
    
    const snapshot = await db.collection("topkhana_expenses").get();
    if (snapshot.empty) return ctx.reply(`No expenses recorded for ${currentMonthName} yet.`);
    
    const expenses = snapshot.docs.map(doc => doc.data());
    ctx.replyWithMarkdown(generateSummaryText(currentMonthName, expenses));
  } catch (error) {
    ctx.reply(`❌ Error fetching summary: ${error.message}`);
  }
});

// --- 6. ARCHIVED MONTH SUMMARY COMMAND ---
bot.hears(/^summary\s+([a-zA-Z]+)\s+(\d{4})\$/i, async (ctx) => {
  const match = ctx.match;
  const searchTitle = `${formatWord(match[1])} ${match[2]}`;
  
  try {
    const snapshot = await db.collection("topkhana_history").get();
    const targetMonth = snapshot.docs.map(d => d.data()).find(h => h.title === searchTitle);
    
    if (!targetMonth) return ctx.reply(`❌ Could not find an archive for "${searchTitle}".`);

    ctx.replyWithMarkdown(generateSummaryText(targetMonth.title, targetMonth.expenses));
  } catch (error) {
    ctx.reply(`❌ Error fetching history: ${error.message}`);
  }
});

// Prevent Render instances from hard crashing during transient network connection drops
process.on('unhandledRejection', (reason, promise) => {
  console.error('⚠️ Unhandled Rejection at:', promise, 'reason:', reason);
});

console.log("Topkhana Telegram Bot system active!");
