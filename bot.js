const TelegramBot = require('node-telegram-bot-api');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const express = require('express');
const https = require('https'); // Built-in Node module for the self-ping

// --- 1. RENDER HEALTH CHECK SERVER & ANTI-SLEEP ---
const app = express();
app.get('/', (req, res) => res.send('Topkhana Bot is running!'));
const port = process.env.PORT || 3000;

app.listen(port, () => {
  console.log(`Web server listening on port ${port}`);
  
  // Anti-Sleep Self-Ping (Fires every 14 minutes)
  setInterval(() => {
    const url = process.env.RENDER_EXTERNAL_URL;
    if (url) {
      https.get(url, (res) => {
        console.log(`⏰ Anti-sleep ping sent. Status: ${res.statusCode} OK`);
      }).on('error', (err) => {
        console.error(`❌ Anti-sleep ping failed: ${err.message}`);
      });
    } else {
      console.log('⚠️ RENDER_EXTERNAL_URL not found. Skipping self-ping.');
    }
  }, 14 * 60 * 1000); // 14 minutes in milliseconds
});

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

// --- 3. CONSTANTS & KEYBOARDS ---
const members = ["Aomy", "Mahin", "Piash", "Sayem", "Inan", "Pulok"];
const categories = ["Bazar", "Electricity", "Gas", "Water", "Internet"];

const getMainMenu = () => ({
  reply_markup: {
    inline_keyboard: [
      [{ text: "➕ Add New Expense", callback_data: "menu_add" }],
      [{ text: "📊 Current Month Summary", callback_data: "menu_summary" }],
      [{ text: "📜 View Past Months (History)", callback_data: "menu_history" }]
    ]
  }
});

const getBackMenu = () => ({
  reply_markup: {
    inline_keyboard: [[{ text: "🔙 Back to Main Menu", callback_data: "menu_main" }]]
  }
});

// --- HELPER: GENERATE SUMMARY TEXT ---
const generateSummaryText = (title, expenses, exclusions) => {
  const bazarTotal = expenses.filter(e => e.category === "Bazar").reduce((sum, e) => sum + e.amount, 0);
  const billsTotal = expenses.filter(e => e.category !== "Bazar").reduce((sum, e) => sum + e.amount, 0);
  const grandTotal = bazarTotal + billsTotal;

  const bazarParticipants = members.filter(m => !exclusions[m]).length;
  const bazarShare = bazarParticipants > 0 ? bazarTotal / bazarParticipants : 0;
  const billsShare = billsTotal / members.length;

  let text = `📊 *${title} Summary*\n\n`;
  
  text += `🛒 *Bazar Total: ${bazarTotal.toFixed(2)} Tk*\n   _(Per person:${bazarShare.toFixed(2)} Tk)_\n`;
  const bazarMap = {};
  expenses.filter(e => e.category === "Bazar").forEach(e => bazarMap[e.person] = (bazarMap[e.person] || 0) + e.amount);
  for (const [p, amt] of Object.entries(bazarMap)) {
    const net = amt - (exclusions[p] ? 0 : bazarShare);
    let statusText = net < 0 ? `, owes: ${Math.abs(net).toFixed(2)} Tk` : net > 0 ? `, refund: ${net.toFixed(2)} Tk` : `, settled`;
    text += `  • ${p}: spent ${amt.toFixed(2)} Tk${statusText}\n`;
  }

  text += `\n💡 *Bills Total: ${billsTotal.toFixed(2)} Tk*\n   _(Per person:${billsShare.toFixed(2)} Tk)_\n`;
  const billsMap = {};
  expenses.filter(e => e.category !== "Bazar").forEach(e => billsMap[e.person] = (billsMap[e.person] || 0) + e.amount);
  for (const [p, amt] of Object.entries(billsMap)) {
    const net = amt - billsShare;
    let statusText = net < 0 ? `, owes: ${Math.abs(net).toFixed(2)} Tk` : net > 0 ? `, refund: ${net.toFixed(2)} Tk` : `, settled`;
    text += `  • ${p}: spent ${amt.toFixed(2)} Tk${statusText}\n`;
  }

  text += `\n💰 *Grand Total: ${grandTotal.toFixed(2)} Tk*\n━━━━━━━━━━━━━━━━━━━━\n\n⚖️ *FINAL SETTLEMENT*\n\n`;
  members.forEach(m => {
    const net = (bazarMap[m] || 0) + (billsMap[m] || 0) - ((exclusions[m] ? 0 : bazarShare) + billsShare);
    if (net > 0) text += `🟢 *${m}* gets refund: +${net.toFixed(2)} Tk\n`;
    else if (net < 0) text += `🔴 *${m}* owes:${Math.abs(net).toFixed(2)} Tk\n`;
    else text += `⚪ *${m}* is settled (0.00 Tk)\n`;
  });

  return text;
};

// --- 4. START COMMAND ---
bot.onText(/^\/start$/, (msg) => {
  bot.sendMessage(msg.chat.id, "👋 Welcome to Topkhana Tracker!\nWhat would you like to do?", getMainMenu());
});

// --- 5. HANDLE BUTTON CLICKS ---
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  const data = query.data;

  bot.answerCallbackQuery(query.id);

  try {
    if (data === "menu_main") {
      await bot.editMessageText("👋 Welcome back to the Main Menu!\nWhat would you like to do?", {
        chat_id: chatId, message_id: messageId, ...getMainMenu()
      });
    } 
    
    else if (data === "menu_add") {
      const keyboard = { inline_keyboard: [] };
      for (let i = 0; i < members.length; i += 2) {
        const row = [{ text: members[i], callback_data: `add_person_${members[i]}` }];
        if (members[i + 1]) row.push({ text: members[i + 1], callback_data: `add_person_${members[i + 1]}` });
        keyboard.inline_keyboard.push(row);
      }
      keyboard.inline_keyboard.push([{ text: "🔙 Back", callback_data: "menu_main" }]);

      await bot.editMessageText("👤 *Who is adding the expense?*\nSelect a flatmate:", {
        chat_id: chatId, message_id: messageId, parse_mode: "Markdown", reply_markup: keyboard
      });
    }

    else if (data.startsWith("add_person_")) {
      const person = data.split("_")[2];
      const keyboard = { inline_keyboard: [] };
      for (let i = 0; i < categories.length; i += 2) {
        const row = [{ text: categories[i], callback_data: `add_cat_${person}_${categories[i]}` }];
        if (categories[i + 1]) row.push({ text: categories[i + 1], callback_data: `add_cat_${person}_${categories[i + 1]}` });
        keyboard.inline_keyboard.push(row);
      }
      keyboard.inline_keyboard.push([{ text: "🔙 Cancel", callback_data: "menu_main" }]);

      await bot.editMessageText(`📁 *Category for ${person}*\nWhat did they pay for?`, {
        chat_id: chatId, message_id: messageId, parse_mode: "Markdown", reply_markup: keyboard
      });
    }

    else if (data.startsWith("add_cat_")) {
      const [, , person, category] = data.split("_");
      await bot.deleteMessage(chatId, messageId);
      
      await bot.sendMessage(chatId, `💸 *Expense Entry*\n\nReply to this message with the amount for:\nPerson: ${person}\nCategory:${category}\n\n_(You can type multiple numbers separated by spaces like: 100 50 20)_`, {
        parse_mode: "Markdown",
        reply_markup: { force_reply: true, selective: true }
      });
    }

    else if (data === "menu_summary") {
      const metaDoc = await db.collection("topkhana").doc("metadata").get();
      const currentMonthName = metaDoc.exists ? (metaDoc.data().currentMonthName || "Current Month") : "Current Month";
      const exclusions = metaDoc.exists ? (metaDoc.data().bazarExclusions || { Inan: true, Pulok: true }) : { Inan: true, Pulok: true };
      
      const snapshot = await db.collection("topkhana_expenses").get();
      if (snapshot.empty) {
        await bot.editMessageText(`No expenses recorded for ${currentMonthName} yet.`, { chat_id: chatId, message_id: messageId, ...getBackMenu() });
        return;
      }
      
      const expenses = snapshot.docs.map(doc => doc.data());
      await bot.editMessageText(generateSummaryText(currentMonthName, expenses, exclusions), {
        chat_id: chatId, message_id: messageId, parse_mode: 'Markdown', ...getBackMenu()
      });
    }

    else if (data === "menu_history") {
      const snapshot = await db.collection("topkhana_history").get();
      if (snapshot.empty) {
        await bot.editMessageText("No archived months found.", { chat_id: chatId, message_id: messageId, ...getBackMenu() });
        return;
      }

      const keyboard = { inline_keyboard: [] };
      snapshot.docs.forEach(doc => {
        keyboard.inline_keyboard.push([{ text: doc.data().title, callback_data: `hist_${doc.id}` }]);
      });
      keyboard.inline_keyboard.push([{ text: "🔙 Back", callback_data: "menu_main" }]);

      await bot.editMessageText("📜 *Archived Months*\nSelect a month to view its settlement:", {
        chat_id: chatId, message_id: messageId, parse_mode: "Markdown", reply_markup: keyboard
      });
    }

    else if (data.startsWith("hist_")) {
      const docId = data.split("_")[1];
      const docSnap = await db.collection("topkhana_history").doc(docId).get();
      
      if (!docSnap.exists) return;
      const targetMonth = docSnap.data();
      const exclusions = targetMonth.exclusions || { Inan: true, Pulok: true };
      
      await bot.editMessageText(generateSummaryText(targetMonth.title, targetMonth.expenses, exclusions), {
        chat_id: chatId, message_id: messageId, parse_mode: 'Markdown', ...getBackMenu()
      });
    }
  } catch (error) {
    bot.sendMessage(chatId, `❌ Error: ${error.message}`);
  }
});

// --- 6. HANDLE ADD EXPENSE NUMBER REPLIES ---
bot.on('message', async (msg) => {
  if (msg.reply_to_message && msg.reply_to_message.from.username === (await bot.getMe()).username) {
    const originalText = msg.reply_to_message.text;
    
    if (originalText.includes("Expense Entry")) {
      const chatId = msg.chat.id;
      
      try {
        const personMatch = originalText.match(/Person:\s*([a-zA-Z]+)/);
        const categoryMatch = originalText.match(/Category:\s*([a-zA-Z]+)/);
        
        if (!personMatch || !categoryMatch) return;
        
        const person = personMatch[1];
        const category = categoryMatch[1];
        
        const amountString = msg.text.trim();
        const amountArray = amountString.split(/\s+/).map(Number);
        const totalAmount = amountArray.reduce((sum, curr) => sum + curr, 0);

        if (isNaN(totalAmount) || totalAmount <= 0) {
          return bot.sendMessage(chatId, `❌ Invalid numbers provided. Please try again.`, getMainMenu());
        }

        await db.collection("topkhana_expenses").add({
          person,
          category,
          amount: totalAmount,
          createdAt: Date.now()
        });
        
        const calcNote = amountArray.length > 1 ? ` (${amountArray.join(" + ")} = ${totalAmount})` : ``;
        bot.sendMessage(chatId, `✅ Successfully saved!\nAdded ${totalAmount} Tk${calcNote} for ${person} in ${category}.`, getMainMenu());
        
      } catch (error) {
        bot.sendMessage(chatId, `❌ Error saving: ${error.message}`, getMainMenu());
      }
    }
  }
});

console.log("Topkhana Telegram UI Bot initialized successfully!");