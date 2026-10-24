const TelegramBot = require('node-telegram-bot-api');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const express = require('express');
const https = require('https');
const http = require('http');

// ==========================================
// 1. RENDER WEB SERVER & 14-MIN ANTI-SLEEP
// ==========================================
const app = express();
app.get('/', (req, res) => res.status(200).send('Topkhana Bot v2.0 is running 24/7!'));
const port = process.env.PORT || 3000;

app.listen(port, () => {
  console.log(`✅ Web server listening on port ${port}`);

  // Ping self every 14 minutes so Render free tier never sleeps
  setInterval(() => {
    const url = process.env.RENDER_EXTERNAL_URL;
    if (!url) return;
    const client = url.startsWith('https') ? https : http;
    client.get(url, (res) => {
      console.log(`⏰ Keep-alive ping: ${res.statusCode}`);
    }).on('error', (err) => {
      console.error(`⚠️ Keep-alive error: ${err.message}`);
    });
  }, 14 * 60 * 1000);
});

// ==========================================
// 2. INITIALIZE FIREBASE & TELEGRAM BOT
// ==========================================
const token = process.env.TELEGRAM_TOKEN;
if (!token) {
  console.error("❌ CRITICAL: TELEGRAM_TOKEN is missing in Environment Variables!");
  process.exit(1);
}

initializeApp({
  credential: cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY
      ? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
      : undefined,
  })
});
const db = getFirestore();
const bot = new TelegramBot(token, { polling: true });

// Clear any stuck webhook/polling errors silently
bot.on('polling_error', (err) => console.error('Polling Warning:', err.message));

// ==========================================
// 3. CONSTANTS & IN-MEMORY SESSION STATE
// ==========================================
const MEMBERS = ["Aomy", "Mahin", "Piash", "Sayem", "Inan", "Pulok"];
const CATEGORIES = ["Bazar", "Electricity", "Gas", "Water", "Internet"];
const DEFAULT_EXCLUSIONS = { Inan: true, Pulok: true };

// Tracks what a chat/user is currently doing so they don't have to "Force Reply"
const sessions = {};

const escapeHTML = (str) => String(str || '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;');

const formatWord = (str) => str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();

// ==========================================
// 4. DATABASE & UI HELPER FUNCTIONS
// ==========================================
const getMetadata = async () => {
  const doc = await db.collection("topkhana").doc("metadata").get();
  if (!doc.exists) {
    const defaultMeta = { currentMonthName: "Current Month", bazarExclusions: DEFAULT_EXCLUSIONS };
    await db.collection("topkhana").doc("metadata").set(defaultMeta);
    return defaultMeta;
  }
  const data = doc.data();
  return {
    currentMonthName: data.currentMonthName || "Current Month",
    bazarExclusions: data.bazarExclusions || DEFAULT_EXCLUSIONS
  };
};

const getMainMenuKeyboard = () => ({
  inline_keyboard: [
    [{ text: "➕ Add New Expense", callback_data: "menu_add" }],
    [{ text: "📊 Current Month Summary", callback_data: "menu_summary" }],
    [
      { text: "🗑️ Delete Entry", callback_data: "menu_delete" },
      { text: "⚙️ Bazar Exclusions", callback_data: "menu_exclusions" }
    ],
    [{ text: "📜 Past Months (Last 6)", callback_data: "menu_history" }],
    [{ text: "🆕 Start New Month (Archive)", callback_data: "menu_archive" }]
  ]
});

const getBackKeyboard = () => ({
  inline_keyboard: [[{ text: "🔙 Back to Main Menu", callback_data: "menu_main" }]]
});

// Safe message editor (falls back to sending a new message if editing fails)
const renderScreen = async (chatId, messageId, htmlText, replyMarkup) => {
  try {
    if (messageId) {
      await bot.editMessageText(htmlText, {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'HTML',
        reply_markup: replyMarkup
      });
      return;
    }
  } catch (err) {
    if (err.message && err.message.includes('message is not modified')) return;
  }
  await bot.sendMessage(chatId, htmlText, {
    parse_mode: 'HTML',
    reply_markup: replyMarkup
  });
};

// ==========================================
// 5. SUMMARY & SETTLEMENT MATH GENERATOR
// ==========================================
const generateSummaryHTML = (title, expenses, exclusions) => {
  const bazarExpenses = expenses.filter(e => e.category === "Bazar");
  const billExpenses = expenses.filter(e => e.category !== "Bazar");

  const bazarTotal = bazarExpenses.reduce((sum, e) => sum + Number(e.amount || 0), 0);
  const billsTotal = billExpenses.reduce((sum, e) => sum + Number(e.amount || 0), 0);
  const grandTotal = bazarTotal + billsTotal;

  const bazarParticipants = MEMBERS.filter(m => !exclusions[m]).length;
  const bazarShare = bazarParticipants > 0 ? bazarTotal / bazarParticipants : 0;
  const billsShare = billsTotal / MEMBERS.length;

  let text = `📊 <b>${escapeHTML(title)} Summary</b>\n\n`;

  // --- BAZAR SECTION ---
  text += `🛒 <b>Bazar Total: ${bazarTotal.toFixed(2)} Tk</b>\n`;
  text += `   <i>(Per person: ${bazarShare.toFixed(2)} Tk)</i>\n`;
  const bazarMap = {};
  bazarExpenses.forEach(e => {
    bazarMap[e.person] = (bazarMap[e.person] || 0) + Number(e.amount || 0);
  });

  if (Object.keys(bazarMap).length === 0) {
    text += `  • <i>No Bazar entries yet</i>\n`;
  } else {
    for (const [p, amt] of Object.entries(bazarMap)) {
      const owed = exclusions[p] ? 0 : bazarShare;
      const net = amt - owed;
      let status = `, settled`;
      if (net < -0.005) status = `, owes: ${Math.abs(net).toFixed(2)} Tk`;
      else if (net > 0.005) status = `, refund: ${net.toFixed(2)} Tk`;
      text += `  • ${p}: spent ${amt.toFixed(2)} Tk${status}\n`;
    }
  }

  // --- BILLS SECTION ---
  text += `\n💡 <b>Bills Total: ${billsTotal.toFixed(2)} Tk</b>\n`;
  text += `   <i>(Per person: ${billsShare.toFixed(2)} Tk)</i>\n`;
  const billsMap = {};
  billExpenses.forEach(e => {
    billsMap[e.person] = (billsMap[e.person] || 0) + Number(e.amount || 0);
  });

  if (Object.keys(billsMap).length === 0) {
    text += `  • <i>No Utility Bill entries yet</i>\n`;
  } else {
    for (const [p, amt] of Object.entries(billsMap)) {
      const net = amt - billsShare;
      let status = `, settled`;
      if (net < -0.005) status = `, owes: ${Math.abs(net).toFixed(2)} Tk`;
      else if (net > 0.005) status = `, refund: ${net.toFixed(2)} Tk`;
      text += `  • ${p}: spent ${amt.toFixed(2)} Tk${status}\n`;
    }
  }

  text += `\n💰 <b>Grand Total: ${grandTotal.toFixed(2)} Tk</b>\n`;
  text += `━━━━━━━━━━━━━━━━━━━━\n\n`;

  // --- FINAL SETTLEMENT ---
  text += `⚖️ <b>FINAL SETTLEMENT</b>\n\n`;
  MEMBERS.forEach(m => {
    const paid = (bazarMap[m] || 0) + (billsMap[m] || 0);
    const owed = (exclusions[m] ? 0 : bazarShare) + billsShare;
    const net = paid - owed;

    if (net > 0.005) {
      text += `🟢 <b>${m}</b> gets refund: +${net.toFixed(2)} Tk\n`;
    } else if (net < -0.005) {
      text += `🔴 <b>${m}</b> owes: ${Math.abs(net).toFixed(2)} Tk\n`;
    } else {
      text += `⚪ <b>${m}</b> is settled (0.00 Tk)\n`;
    }
  });

  return text;
};

// ==========================================
// 6. BOT COMMANDS (/start, /menu, text shortcuts)
// ==========================================
const sendHomeScreen = async (chatId, messageId = null) => {
  delete sessions[chatId];
  try {
    const meta = await getMetadata();
    const welcomeHTML = `👋 <b>Welcome to Topkhana Tracker!</b>\nCurrent month: <b>${escapeHTML(meta.currentMonthName)}</b>\n\nWhat would you like to do?`;
    await renderScreen(chatId, messageId, welcomeHTML, getMainMenuKeyboard());
  } catch (err) {
    bot.sendMessage(chatId, `❌ Database error: ${err.message}`);
  }
};

bot.onText(/^\/(start|menu)(@\w+)?$/i, (msg) => {
  sendHomeScreen(msg.chat.id);
});

// Quick Text Command: "summary"
bot.onText(/^\/?summary(@\w+)?$/i, async (msg) => {
  const chatId = msg.chat.id;
  try {
    const meta = await getMetadata();
    const snapshot = await db.collection("topkhana_expenses").get();
    if (snapshot.empty) {
      return bot.sendMessage(chatId, `📭 No expenses recorded for <b>${escapeHTML(meta.currentMonthName)}</b> yet.`, {
        parse_mode: 'HTML',
        reply_markup: getMainMenuKeyboard()
      });
    }
    const expenses = snapshot.docs.map(d => d.data());
    const html = generateSummaryHTML(meta.currentMonthName, expenses, meta.bazarExclusions);
    bot.sendMessage(chatId, html, { parse_mode: 'HTML', reply_markup: getBackKeyboard() });
  } catch (err) {
    bot.sendMessage(chatId, `❌ Error: ${err.message}`);
  }
});

// Quick Text Command: "add aomy bazar 500 100"
bot.onText(/^add\s+([a-zA-Z]+)\s+([a-zA-Z]+)\s+([\d\.\s]+)$/i, async (msg, match) => {
  const chatId = msg.chat.id;
  const person = formatWord(match[1]);
  const category = formatWord(match[2]);
  const nums = match[3].trim().split(/\s+/).map(Number).filter(n => !isNaN(n) && n > 0);
  const totalAmount = nums.reduce((a, b) => a + b, 0);

  if (!MEMBERS.includes(person)) return bot.sendMessage(chatId, `❌ Invalid person. Choose: ${MEMBERS.join(", ")}`);
  if (!CATEGORIES.includes(category)) return bot.sendMessage(chatId, `❌ Invalid category. Choose: ${CATEGORIES.join(", ")}`);
  if (totalAmount <= 0) return bot.sendMessage(chatId, `❌ Invalid amount.`);

  try {
    const batch = db.batch();
    nums.forEach((num, index) => {
      const ref = db.collection("topkhana_expenses").doc();
      batch.set(ref, { person, category, amount: num, createdAt: Date.now() + index });
    });
    await batch.commit();

    const note = nums.length > 1 ? ` (Saved as ${nums.length} separate entries)` : ``;
    bot.sendMessage(chatId, `✅ <b>Expense Saved!</b>\nAdded <b>${totalAmount} Tk</b>${note} for <b>${person}</b> in <b>${category}</b>.`, {
      parse_mode: 'HTML',
      reply_markup: getMainMenuKeyboard()
    });
  } catch (err) {
    bot.sendMessage(chatId, `❌ Error saving: ${err.message}`);
  }
});

// ==========================================
// 7. INTERACTIVE BUTTON HANDLER
// ==========================================
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  const data = query.data;

  bot.answerCallbackQuery(query.id).catch(() => {});

  try {
    // --- MAIN MENU ---
    if (data === "menu_main") {
      await sendHomeScreen(chatId, messageId);
    }

    // --- 1. ADD EXPENSE FLOW ---
    else if (data === "menu_add") {
      delete sessions[chatId];
      const keyboard = { inline_keyboard: [] };
      for (let i = 0; i < MEMBERS.length; i += 2) {
        const row = [{ text: `👤 ${MEMBERS[i]}`, callback_data: `add_p_${MEMBERS[i]}` }];
        if (MEMBERS[i + 1]) row.push({ text: `👤 ${MEMBERS[i + 1]}`, callback_data: `add_p_${MEMBERS[i + 1]}` });
        keyboard.inline_keyboard.push(row);
      }
      keyboard.inline_keyboard.push([{ text: "🔙 Back to Main Menu", callback_data: "menu_main" }]);

      await renderScreen(chatId, messageId, "👤 <b>Who paid for the expense?</b>\nTap a flatmate below:", keyboard);
    }

    else if (data.startsWith("add_p_")) {
      const person = data.replace("add_p_", "");
      const keyboard = { inline_keyboard: [] };
      for (let i = 0; i < CATEGORIES.length; i += 2) {
        const row = [{ text: CATEGORIES[i], callback_data: `add_c_${person}_${CATEGORIES[i]}` }];
        if (CATEGORIES[i + 1]) row.push({ text: CATEGORIES[i + 1], callback_data: `add_c_${person}_${CATEGORIES[i + 1]}` });
        keyboard.inline_keyboard.push(row);
      }
      keyboard.inline_keyboard.push([{ text: "🔙 Change Person", callback_data: "menu_add" }]);

      await renderScreen(chatId, messageId, `📁 <b>Category for ${person}</b>\nWhat did ${person} pay for?`, keyboard);
    }

    else if (data.startsWith("add_c_")) {
      const parts = data.split("_");
      const person = parts[2];
      const category = parts[3];

      // Save active session so the user can just type the number normally!
      sessions[chatId] = {
        mode: "AWAITING_AMOUNT",
        person,
        category
      };

      const keyboard = {
        inline_keyboard: [[{ text: "❌ Cancel", callback_data: "menu_main" }]]
      };

      await renderScreen(
        chatId,
        messageId,
        `💸 <b>Enter Amount for ${person} (${category})</b>\n\nJust type the amount in the chat and send it!\n<i>(Tip: You can send multiple amounts separated by spaces like <code>500 120 80</code> and I will add them up automatically)</i>`,
        keyboard
      );
    }

    // --- 2. CURRENT SUMMARY ---
    else if (data === "menu_summary") {
      const meta = await getMetadata();
      const snapshot = await db.collection("topkhana_expenses").get();
      if (snapshot.empty) {
        return renderScreen(
          chatId,
          messageId,
          `📭 No expenses recorded for <b>${escapeHTML(meta.currentMonthName)}</b> yet.`,
          getBackKeyboard()
        );
      }
      const expenses = snapshot.docs.map(d => d.data());
      const html = generateSummaryHTML(meta.currentMonthName, expenses, meta.bazarExclusions);
      await renderScreen(chatId, messageId, html, getBackKeyboard());
    }

    // --- 3. DELETE RECENT EXPENSE ---
    else if (data === "menu_delete") {
      const snapshot = await db.collection("topkhana_expenses").get();
      if (snapshot.empty) {
        return renderScreen(chatId, messageId, "📭 No active expenses to delete.", getBackKeyboard());
      }

      const docs = snapshot.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
        .slice(0, 8);

      const keyboard = { inline_keyboard: [] };
      docs.forEach(item => {
        keyboard.inline_keyboard.push([
          { text: `❌ ${item.person} - ${item.category}: ${item.amount} Tk`, callback_data: `del_exp_${item.id}` }
        ]);
      });
      keyboard.inline_keyboard.push([{ text: "🔙 Back to Main Menu", callback_data: "menu_main" }]);

      await renderScreen(
        chatId,
        messageId,
        "🗑️ <b>Delete an Expense</b>\nTap any recent entry below to permanently remove it:",
        keyboard
      );
    }

    else if (data.startsWith("del_exp_")) {
      const docId = data.replace("del_exp_", "");
      const docRef = db.collection("topkhana_expenses").doc(docId);
      const docSnap = await docRef.get();
      if (docSnap.exists) {
        const exp = docSnap.data();
        await docRef.delete();
        await renderScreen(
          chatId,
          messageId,
          `✅ Deleted <b>${exp.amount} Tk</b> (${exp.person} - ${exp.category}).`,
          getMainMenuKeyboard()
        );
      } else {
        await renderScreen(chatId, messageId, "⚠️ Entry was already deleted.", getMainMenuKeyboard());
      }
    }

    // --- 4. BAZAR EXCLUSIONS TOGGLE ---
    else if (data === "menu_exclusions") {
      const meta = await getMetadata();
      const exclusions = meta.bazarExclusions;

      const keyboard = { inline_keyboard: [] };
      for (let i = 0; i < MEMBERS.length; i += 2) {
        const m1 = MEMBERS[i];
        const m2 = MEMBERS[i + 1];
        const row = [
          { text: `${exclusions[m1] ? "❌ Excluded" : "✅ Included"}: ${m1}`, callback_data: `tog_exc_${m1}` }
        ];
        if (m2) {
          row.push({ text: `${exclusions[m2] ? "❌ Excluded" : "✅ Included"}: ${m2}`, callback_data: `tog_exc_${m2}` });
        }
        keyboard.inline_keyboard.push(row);
      }
      keyboard.inline_keyboard.push([{ text: "🔙 Back to Main Menu", callback_data: "menu_main" }]);

      await renderScreen(
        chatId,
        messageId,
        "⚙️ <b>Bazar Split Settings</b>\nTap a flatmate to toggle whether they share the Bazar cost:",
        keyboard
      );
    }

    else if (data.startsWith("tog_exc_")) {
      const person = data.replace("tog_exc_", "");
      const meta = await getMetadata();
      const updatedExclusions = {
        ...meta.bazarExclusions,
        [person]: !meta.bazarExclusions[person]
      };

      await db.collection("topkhana").doc("metadata").set(
        { bazarExclusions: updatedExclusions },
        { merge: true }
      );

      // Re-render the exclusions screen immediately
      const keyboard = { inline_keyboard: [] };
      for (let i = 0; i < MEMBERS.length; i += 2) {
        const m1 = MEMBERS[i];
        const m2 = MEMBERS[i + 1];
        const row = [
          { text: `${updatedExclusions[m1] ? "❌ Excluded" : "✅ Included"}: ${m1}`, callback_data: `tog_exc_${m1}` }
        ];
        if (m2) {
          row.push({ text: `${updatedExclusions[m2] ? "❌ Excluded" : "✅ Included"}: ${m2}`, callback_data: `tog_exc_${m2}` });
        }
        keyboard.inline_keyboard.push(row);
      }
      keyboard.inline_keyboard.push([{ text: "🔙 Back to Main Menu", callback_data: "menu_main" }]);

      await renderScreen(
        chatId,
        messageId,
        "⚙️ <b>Bazar Split Settings</b>\nTap a flatmate to toggle whether they share the Bazar cost:",
        keyboard
      );
    }

    // --- 5. ARCHIVE / START NEW MONTH ---
    else if (data === "menu_archive") {
      sessions[chatId] = { mode: "AWAITING_NEW_MONTH_NAME" };
      const keyboard = {
        inline_keyboard: [[{ text: "❌ Cancel", callback_data: "menu_main" }]]
      };
      await renderScreen(
        chatId,
        messageId,
        "🆕 <b>Start New Month</b>\n\nType the name of the <b>NEW month</b> in the chat (e.g. <code>November 2026</code>).\n\n<i>All current expenses will be safely archived into History.</i>",
        keyboard
      );
    }

    // --- 6. PAST 6 MONTHS HISTORY & RESTORE ---
    else if (data === "menu_history") {
      const snapshot = await db.collection("topkhana_history").get();
      if (snapshot.empty) {
        return renderScreen(chatId, messageId, "📭 No archived months found in History.", getBackKeyboard());
      }

      // Sort in memory so Firestore never throws a missing index error
      const docs = snapshot.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
        .slice(0, 6);

      const keyboard = { inline_keyboard: [] };
      docs.forEach(item => {
        keyboard.inline_keyboard.push([{ text: `📅 ${item.title}`, callback_data: `hist_view_${item.id}` }]);
      });
      keyboard.inline_keyboard.push([{ text: "🔙 Back to Main Menu", callback_data: "menu_main" }]);

      await renderScreen(
        chatId,
        messageId,
        "📜 <b>Recent Archives (Last 6 Months)</b>\nSelect a month to view its summary or restore it:",
        keyboard
      );
    }

    else if (data.startsWith("hist_view_")) {
      const docId = data.replace("hist_view_", "");
      const docSnap = await db.collection("topkhana_history").doc(docId).get();
      if (!docSnap.exists) {
        return renderScreen(chatId, messageId, "❌ Archive not found.", getBackKeyboard());
      }

      const archive = docSnap.data();
      const html = generateSummaryHTML(archive.title, archive.expenses || [], archive.exclusions || DEFAULT_EXCLUSIONS);
      const keyboard = {
        inline_keyboard: [
          [{ text: "🔄 Restore This Month", callback_data: `hist_ask_${docId}` }],
          [{ text: "🔙 Back to History", callback_data: "menu_history" }]
        ]
      };

      await renderScreen(chatId, messageId, html, keyboard);
    }

    else if (data.startsWith("hist_ask_")) {
      const docId = data.replace("hist_ask_", "");
      const keyboard = {
        inline_keyboard: [
          [{ text: "⚠️ YES, Restore Month", callback_data: `hist_restore_${docId}` }],
          [{ text: "❌ Cancel", callback_data: `hist_view_${docId}` }]
        ]
      };
      await renderScreen(
        chatId,
        messageId,
        "⚠️ <b>Confirm Restore</b>\nAre you sure you want to make this the active month? Any unarchived expenses in your current active month will be overwritten.",
        keyboard
      );
    }

    else if (data.startsWith("hist_restore_")) {
      const docId = data.replace("hist_restore_", "");
      const docRef = db.collection("topkhana_history").doc(docId);
      const docSnap = await docRef.get();
      if (!docSnap.exists) {
        return renderScreen(chatId, messageId, "❌ Archive no longer exists.", getBackKeyboard());
      }

      const monthData = docSnap.data();
      const batch = db.batch();

      // 1. Clear current active expenses
      const activeSnap = await db.collection("topkhana_expenses").get();
      activeSnap.docs.forEach(d => batch.delete(d.ref));

      // 2. Restore archived expenses
      (monthData.expenses || []).forEach(exp => {
        const ref = db.collection("topkhana_expenses").doc();
        batch.set(ref, {
          person: exp.person,
          category: exp.category,
          amount: Number(exp.amount || 0),
          createdAt: exp.createdAt || Date.now()
        });
      });

      // 3. Restore metadata
      batch.set(db.collection("topkhana").doc("metadata"), {
        currentMonthName: monthData.title,
        bazarExclusions: monthData.exclusions || DEFAULT_EXCLUSIONS
      });

      // 4. Delete from history
      batch.delete(docRef);

      await batch.commit();
      await renderScreen(
        chatId,
        messageId,
        `✅ Successfully restored <b>${escapeHTML(monthData.title)}</b> as the current active month!`,
        getMainMenuKeyboard()
      );
    }
  } catch (err) {
    console.error("Callback Error:", err);
    bot.sendMessage(chatId, `❌ Error: ${err.message}`);
  }
});

// ==========================================
// 8. SMART SESSION MESSAGE LISTENER
// ==========================================
bot.on('message', async (msg) => {
  if (!msg.text) return;
  const text = msg.text.trim();
  const chatId = msg.chat.id;

  // Ignore slash commands or direct text commands handled above
  if (text.startsWith('/') || /^add\s+/i.test(text) || /^summary$/i.test(text)) return;

  const session = sessions[chatId];
  if (!session) return;

  // --- HANDLE AMOUNT ENTRY ---
  if (session.mode === "AWAITING_AMOUNT") {
    const nums = text.split(/\s+/).map(Number).filter(n => !isNaN(n) && n > 0);
    const totalAmount = nums.reduce((a, b) => a + b, 0);

    if (nums.length === 0 || totalAmount <= 0) {
      return bot.sendMessage(
        chatId,
        `❌ Invalid number. Please type only numbers (for example: <code>500</code> or <code>200 150</code>), or tap Cancel.`,
        {
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard: [[{ text: "❌ Cancel", callback_data: "menu_main" }]] }
        }
      );
    }

    const { person, category } = session;
    delete sessions[chatId];

    try {
      const batch = db.batch();
      nums.forEach((num, index) => {
        const ref = db.collection("topkhana_expenses").doc();
        batch.set(ref, { person, category, amount: num, createdAt: Date.now() + index });
      });
      await batch.commit();

      const calcNote = nums.length > 1 ? ` (Saved as ${nums.length} separate entries)` : ``;
      await bot.sendMessage(
        chatId,
        `✅ <b>Expense Saved!</b>\nAdded <b>${totalAmount} Tk</b>${calcNote} for <b>${person}</b> in <b>${category}</b>.`,
        { parse_mode: 'HTML', reply_markup: getMainMenuKeyboard() }
      );
    } catch (err) {
      bot.sendMessage(chatId, `❌ Error saving to database: ${err.message}`);
    }
  }

  // --- HANDLE NEW MONTH ARCHIVE NAME ---
  else if (session.mode === "AWAITING_NEW_MONTH_NAME") {
    const newMonthName = text;
    delete sessions[chatId];

    try {
      const meta = await getMetadata();
      const snapshot = await db.collection("topkhana_expenses").get();
      const expenses = snapshot.docs.map(d => d.data());

      const batch = db.batch();

      // Save current month to History
      const histRef = db.collection("topkhana_history").doc();
      batch.set(histRef, {
        title: meta.currentMonthName,
        expenses,
        exclusions: meta.bazarExclusions,
        createdAt: Date.now()
      });

      // Clear current expenses
      snapshot.docs.forEach(d => batch.delete(d.ref));

      // Update active month name (keep current exclusion preferences)
      batch.set(db.collection("topkhana").doc("metadata"), {
        currentMonthName: newMonthName,
        bazarExclusions: meta.bazarExclusions
      });

      await batch.commit();

      await bot.sendMessage(
        chatId,
        `✅ Archived <b>${escapeHTML(meta.currentMonthName)}</b> to History!\n🎉 Started fresh tracking for <b>${escapeHTML(newMonthName)}</b>.`,
        { parse_mode: 'HTML', reply_markup: getMainMenuKeyboard() }
      );
    } catch (err) {
      bot.sendMessage(chatId, `❌ Error archiving month: ${err.message}`);
    }
  }
});

console.log("🚀 Topkhana Telegram Bot v2.0 initialized!");
