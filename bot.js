const TelegramBot = require('node-telegram-bot-api');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const express = require('express');
const https = require('https');

// --- 1. RENDER HEALTH CHECK SERVER & ANTI-SLEEP ---
const app = express();
app.get('/', (req, res) => res.send('Topkhana Bot is running!'));
const port = process.env.PORT || 3000;

app.listen(port, () => {
  console.log(`Web server listening on port ${port}`);
  setInterval(() => {
    const url = process.env.RENDER_EXTERNAL_URL;
    if (url) {
      https.get(url, (res) => console.log(`⏰ Anti-sleep ping: ${res.statusCode} OK`))
           .on('error', (err) => console.error(`❌ Ping failed: ${err.message}`));
    }
  }, 14 * 60 * 1000);
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
      [{ text: "📜 View Past Months (History)", callback_data: "menu_history" }],
      [{ text: "🆕 Start New Month (Archive)", callback_data: "menu_archive" }]
    ]
  }
});

const getBackMenu = () => ({
  reply_markup: { inline_keyboard: [[{ text: "🔙 Back to Main Menu", callback_data: "menu_main" }]] }
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
bot.onText(/^\/start$/, async (msg) => {
  const chatId = msg.chat.id;
  try {
    const metaDoc = await db.collection("topkhana").doc("metadata").get();
    const currentMonthName = metaDoc.exists ? (metaDoc.data().currentMonthName || "Unknown Month") : "Unknown Month";
    
    bot.sendMessage(chatId, `👋 Welcome to Topkhana Tracker!\nCurrent month: *${currentMonthName}*\n\nWhat would you like to do?`, { 
      parse_mode: 'Markdown', 
      ...getMainMenu() 
    });
  } catch (error) {
    bot.sendMessage(chatId, `❌ Error connecting to database: ${error.message}`);
  }
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
    
    // -- ADD EXPENSE FLOW --
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

    // -- VIEW CURRENT SUMMARY --
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

    // -- ARCHIVE / START NEW MONTH --
    else if (data === "menu_archive") {
      await bot.deleteMessage(chatId, messageId);
      await bot.sendMessage(chatId, `🆕 *Start New Month*\n\nReply to this message with the name of the NEW month you are starting (e.g., October 2026).\n\n_Note: This will safely archive all current active data to History._`, {
        parse_mode: "Markdown",
        reply_markup: { force_reply: true, selective: true }
      });
    }

    // -- HISTORY & RESTORE FLOW --
    else if (data === "menu_history") {
      // LIMITED TO THE MOST RECENT 6 MONTHS
      const snapshot = await db.collection("topkhana_history")
                               .orderBy("createdAt", "desc")
                               .limit(6)
                               .get();

      if (snapshot.empty) {
        await bot.editMessageText("No archived months found.", { chat_id: chatId, message_id: messageId, ...getBackMenu() });
        return;
      }

      const keyboard = { inline_keyboard: [] };
      snapshot.docs.forEach(doc => {
        keyboard.inline_keyboard.push([{ text: doc.data().title, callback_data: `hist_${doc.id}` }]);
      });
      keyboard.inline_keyboard.push([{ text: "🔙 Back", callback_data: "menu_main" }]);

      await bot.editMessageText("📜 *Recent Archives (Last 6 Months)*\nSelect a month to view its settlement:", {
        chat_id: chatId, message_id: messageId, parse_mode: "Markdown", reply_markup: keyboard
      });
    }

    else if (data.startsWith("hist_")) {
      const docId = data.split("_")[1];
      const docSnap = await db.collection("topkhana_history").doc(docId).get();
      
      if (!docSnap.exists) return;
      const targetMonth = docSnap.data();
      const exclusions = targetMonth.exclusions || { Inan: true, Pulok: true };
      
      const keyboard = {
        inline_keyboard: [
          [{ text: "🔄 Restore This Month", callback_data: `ask_restore_${docId}` }],
          [{ text: "🔙 Back to History", callback_data: "menu_history" }]
        ]
      };

      await bot.editMessageText(generateSummaryText(targetMonth.title, targetMonth.expenses, exclusions), {
        chat_id: chatId, message_id: messageId, parse_mode: 'Markdown', reply_markup: keyboard
      });
    }

    // CONFIRM RESTORE WARNING
    else if (data.startsWith("ask_restore_")) {
      const docId = data.split("ask_restore_")[1];
      const keyboard = {
        inline_keyboard: [
          [{ text: "⚠️ YES, Restore this month", callback_data: `do_restore_${docId}` }],
          [{ text: "❌ Cancel", callback_data: `hist_${docId}` }]
        ]
      };
      await bot.editMessageText("⚠️ *WARNING*\nAre you sure you want to restore this month? Any unsaved data in your *current active month* will be replaced and permanently lost.", {
        chat_id: chatId, message_id: messageId, parse_mode: "Markdown", reply_markup: keyboard
      });
    }

    // EXECUTE RESTORE
    else if (data.startsWith("do_restore_")) {
      const docId = data.split("do_restore_")[1];
      const docSnap = await db.collection("topkhana_history").doc(docId).get();
      
      if (!docSnap.exists) return bot.sendMessage(chatId, "❌ Error: Archive not found.");
      const monthToRestore = docSnap.data();
      
      const batch = db.batch();
      
      // 1. Delete current active expenses
      const activeSnap = await db.collection("topkhana_expenses").get();
      activeSnap.docs.forEach(doc => batch.delete(doc.ref));

      // 2. Insert restored expenses
      monthToRestore.expenses.forEach(exp => {
        const newExpRef = db.collection("topkhana_expenses").doc();
        batch.set(newExpRef, { person: exp.person, category: exp.category, amount: exp.amount, createdAt: Date.now() });
      });

      // 3. Restore metadata
      batch.set(db.collection("topkhana").doc("metadata"), {
        currentMonthName: monthToRestore.title,
        bazarExclusions: monthToRestore.exclusions || { Inan: true, Pulok: true }
      });

      // 4. Remove from history
      batch.delete(docSnap.ref);

      await batch.commit();

      await bot.editMessageText(`✅ Successfully restored *${monthToRestore.title}* and made it the active month!`, {
        chat_id: chatId, message_id: messageId, parse_mode: "Markdown", ...getMainMenu()
      });
    }
  } catch (error) {
    bot.sendMessage(chatId, `❌ Error: ${error.message}`);
  }
});

// --- 6. HANDLE FORCE-REPLIES (Expenses & Archiving) ---
bot.on('message', async (msg) => {
  if (msg.reply_to_message && msg.reply_to_message.from.username === (await bot.getMe()).username) {
    const originalText = msg.reply_to_message.text;
    const chatId = msg.chat.id;
    
    // Add Expense Reply
    if (originalText.includes("Expense Entry")) {
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

        await db.collection("topkhana_expenses").add({ person, category, amount: totalAmount, createdAt: Date.now() });
        
        const calcNote = amountArray.length > 1 ? ` (${amountArray.join(" + ")} = ${totalAmount})` : ``;
        bot.sendMessage(chatId, `✅ Successfully saved!\nAdded ${totalAmount} Tk${calcNote} for ${person} in ${category}.`, getMainMenu());
      } catch (error) {
        bot.sendMessage(chatId, `❌ Error saving: ${error.message}`, getMainMenu());
      }
    }
    
    // Start New Month (Archive) Reply
    else if (originalText.includes("Start New Month")) {
      const newMonthName = msg.text.trim();
      try {
        const metaDoc = await db.collection("topkhana").doc("metadata").get();
        const currentMonthName = metaDoc.exists ? (metaDoc.data().currentMonthName || "Unknown Month") : "Unknown Month";
        const exclusions = metaDoc.exists ? (metaDoc.data().bazarExclusions || { Inan: true, Pulok: true }) : { Inan: true, Pulok: true };
        
        const snapshot = await db.collection("topkhana_expenses").get();
        const expenses = snapshot.docs.map(doc => doc.data());

        const batch = db.batch();
        
        // 1. Save to History
        const newHistoryRef = db.collection("topkhana_history").doc();
        batch.set(newHistoryRef, { title: currentMonthName, expenses: expenses, exclusions: exclusions, createdAt: Date.now() });

        // 2. Wipe active collection
        snapshot.docs.forEach(doc => batch.delete(doc.ref));

        // 3. Update metadata to new month
        batch.set(db.collection("topkhana").doc("metadata"), {
          currentMonthName: newMonthName,
          bazarExclusions: { Inan: true, Pulok: true }
        });

        await batch.commit();

        bot.sendMessage(chatId, `✅ Successfully archived *${currentMonthName}*!\n\nStarted fresh tracking for *${newMonthName}*.`, { parse_mode: "Markdown", ...getMainMenu() });
      } catch (error) {
        bot.sendMessage(chatId, `❌ Error archiving month: ${error.message}`, getMainMenu());
      }
    }
  }
});

console.log("Topkhana Telegram UI Bot initialized successfully!");