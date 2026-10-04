const TelegramBot = require('node-telegram-bot-api');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const express = require('express');

// --- 1. RENDER HEALTH CHECK SERVER ---
const app = express();
app.get('/', (req, res) => res.send('Topkhana Bot is running 24/7!'));
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Web server listening on port ${port}`));

// --- 2. INITIALIZE BOT & FIREBASE ---
const token = process.env.TELEGRAM_TOKEN;

if (!token) {
  console.error("❌ CRITICAL ERROR: TELEGRAM_TOKEN environment variable is missing!");
  process.exit(1);
}

const bot = new TelegramBot(token, { polling: true });

initializeApp({
  credential: cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY ? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n') : undefined,
  })
});
const db = getFirestore();

const formatWord = (str) => str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
const members = ["Aomy", "Mahin", "Piash", "Sayem", "Inan", "Pulok"];

// --- 3. ADD SPENDING COMMAND (Supports multiple amounts) ---
bot.onText(/^add\s+([a-zA-Z]+)\s+([a-zA-Z]+)\s+([\d\.\s]+)$/i, async (msg, match) => {
  const chatId = msg.chat.id;
  const person = formatWord(match[1]);
  const category = formatWord(match[2]);
  
  const amountString = match[3].trim();
  const amountArray = amountString.split(/\s+/).map(Number);
  const totalAmount = amountArray.reduce((sum, curr) => sum + curr, 0);

  const validCategories = ["Bazar", "Electricity", "Gas", "Water", "Internet"];

  if (!members.includes(person)) return bot.sendMessage(chatId, `❌ Invalid person. Must be: ${members.join(", ")}`);
  if (!validCategories.includes(category)) return bot.sendMessage(chatId, `❌ Invalid category. Must be: ${validCategories.join(", ")}`);
  if (isNaN(totalAmount) || totalAmount <= 0) return bot.sendMessage(chatId, `❌ Invalid amounts provided.`);

  try {
    await db.collection("topkhana_expenses").add({
      person,
      category,
      amount: totalAmount,
      createdAt: Date.now()
    });
    
    const calculationNote = amountArray.length > 1 ? ` (${amountArray.join(" + ")} = ${totalAmount})` : ``;
    bot.sendMessage(chatId, `✅ Added ${totalAmount} Tk${calculationNote} for ${person} in ${category}!`);
  } catch (error) {
    bot.sendMessage(chatId, `❌ Error saving to database: ${error.message}`);
  }
});

// --- HELPER FUNCTION: GENERATE ADVANCED SUMMARY TEXT ---
const generateSummaryText = (title, expenses, exclusions) => {
  const bazarTotal = expenses.filter(e => e.category === "Bazar").reduce((sum, e) => sum + e.amount, 0);
  const billsTotal = expenses.filter(e => e.category !== "Bazar").reduce((sum, e) => sum + e.amount, 0);
  const grandTotal = bazarTotal + billsTotal;

  // Calculate Shares
  const bazarParticipants = members.filter(m => !exclusions[m]).length;
  const bazarShare = bazarParticipants > 0 ? bazarTotal / bazarParticipants : 0;
  const billsShare = billsTotal / members.length;

  let text = `📊 *${title} Summary*\n\n`;
  
  // --- BAZAR BREAKDOWN ---
  text += `🛒 *Bazar Total: ${bazarTotal.toFixed(2)} Tk*\n`;
  text += `   _(Per person: ${bazarShare.toFixed(2)} Tk)_\n`;
  const bazarMap = {};
  expenses.filter(e => e.category === "Bazar").forEach(e => {
    bazarMap[e.person] = (bazarMap[e.person] || 0) + e.amount;
  });
  for (const [p, amt] of Object.entries(bazarMap)) {
    const owed = exclusions[p] ? 0 : bazarShare;
    const net = amt - owed;
    let statusText = "";
    if (net < 0) statusText = `, owes: ${Math.abs(net).toFixed(2)} Tk`;
    else if (net > 0) statusText = `, refund: ${net.toFixed(2)} Tk`;
    else statusText = `, settled`;
    
    text += `  • ${p}: spent ${amt.toFixed(2)} Tk${statusText}\n`;
  }

  // --- BILLS BREAKDOWN ---
  text += `\n💡 *Bills Total: ${billsTotal.toFixed(2)} Tk*\n`;
  text += `   _(Per person: ${billsShare.toFixed(2)} Tk)_\n`;
  const billsMap = {};
  expenses.filter(e => e.category !== "Bazar").forEach(e => {
    billsMap[e.person] = (billsMap[e.person] || 0) + e.amount;
  });
  for (const [p, amt] of Object.entries(billsMap)) {
    const owed = billsShare;
    const net = amt - owed;
    let statusText = "";
    if (net < 0) statusText = `, owes: ${Math.abs(net).toFixed(2)} Tk`;
    else if (net > 0) statusText = `, refund: ${net.toFixed(2)} Tk`;
    else statusText = `, settled`;
    
    text += `  • ${p}: spent ${amt.toFixed(2)} Tk${statusText}\n`;
  }

  text += `\n💰 *Grand Total: ${grandTotal.toFixed(2)} Tk*\n`;
  text += `━━━━━━━━━━━━━━━━━━━━\n\n`;

  // --- FINAL SETTLEMENT ---
  text += `⚖️ *FINAL SETTLEMENT*\n\n`;
  members.forEach(m => {
    const paidBazar = bazarMap[m] || 0;
    const paidBills = billsMap[m] || 0;
    const owedBazar = exclusions[m] ? 0 : bazarShare;
    const owedBills = billsShare;

    const net = (paidBazar + paidBills) - (owedBazar + owedBills);

    if (net > 0) {
      text += `🟢 *${m}* gets refund: +${net.toFixed(2)} Tk\n`;
    } else if (net < 0) {
      text += `🔴 *${m}* owes: ${Math.abs(net).toFixed(2)} Tk\n`;
    } else {
      text += `⚪ *${m}* is settled (0.00 Tk)\n`;
    }
  });

  return text;
};

// --- 4. CURRENT MONTH SUMMARY COMMAND ---
bot.onText(/^summary$/i, async (msg) => {
  const chatId = msg.chat.id;
  try {
    const metaDoc = await db.collection("topkhana").doc("metadata").get();
    const currentMonthName = metaDoc.exists ? (metaDoc.data().currentMonthName || "Current Month") : "Current Month";
    const exclusions = metaDoc.exists ? (metaDoc.data().bazarExclusions || { Inan: true, Pulok: true }) : { Inan: true, Pulok: true };
    
    const snapshot = await db.collection("topkhana_expenses").get();
    if (snapshot.empty) return bot.sendMessage(chatId, `No expenses recorded for ${currentMonthName} yet.`);
    
    const expenses = snapshot.docs.map(doc => doc.data());
    bot.sendMessage(chatId, generateSummaryText(currentMonthName, expenses, exclusions), { parse_mode: 'Markdown' });
  } catch (error) {
    bot.sendMessage(chatId, `❌ Error fetching summary: ${error.message}`);
  }
});

// --- 5. ARCHIVED MONTH SUMMARY COMMAND ---
bot.onText(/^summary\s+([a-zA-Z]+)\s+(\d{4})$/i, async (msg, match) => {
  const chatId = msg.chat.id;
  const searchTitle = `${formatWord(match[1])} ${match[2]}`;
  
  try {
    const snapshot = await db.collection("topkhana_history").get();
    const targetMonth = snapshot.docs.map(d => d.data()).find(h => h.title === searchTitle);
    
    if (!targetMonth) return bot.sendMessage(chatId, `❌ Could not find an archive for "${searchTitle}".`);

    const exclusions = targetMonth.exclusions || { Inan: true, Pulok: true };
    bot.sendMessage(chatId, generateSummaryText(targetMonth.title, targetMonth.expenses, exclusions), { parse_mode: 'Markdown' });
  } catch (error) {
    bot.sendMessage(chatId, `❌ Error fetching history: ${error.message}`);
  }
});

console.log("Topkhana Telegram Bot initialized successfully!");