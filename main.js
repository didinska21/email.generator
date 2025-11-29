// main.js
require("dotenv").config();
const { Telegraf, Markup } = require("telegraf");
const fs = require("fs");
const path = require("path");

// ===== CONFIG =====
const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  throw new Error("BOT_TOKEN belum di-set di .env");
}

const bot = new Telegraf(BOT_TOKEN);

// ====== STORAGE STATE ALIAS ======
const DATA_DIR = path.join(__dirname, "data");
const STATE_FILE = path.join(DATA_DIR, "aliases_state.json");

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function loadAliasState() {
  try {
    ensureDataDir();
    if (!fs.existsSync(STATE_FILE)) return {};
    const raw = fs.readFileSync(STATE_FILE, "utf8");
    return JSON.parse(raw);
  } catch (e) {
    console.error("Gagal load alias state:", e.message);
    return {};
  }
}

function saveAliasState(state) {
  try {
    ensureDataDir();
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
  } catch (e) {
    console.error("Gagal simpan alias state:", e.message);
  }
}

// aliasState: { [baseEmailKey]: { normalized, domain, offset } }
let aliasState = loadAliasState();

// ===== STATE PER USER (MODE) =====
const userStates = new Map(); // userId -> { mode, emailData }

const getUserState = (id) => userStates.get(id) || {};
const setUserState = (id, st) =>
  userStates.set(id, { ...(userStates.get(id) || {}), ...st });
const clearUserState = (id) => userStates.delete(id);

// reply keyboard utama
const mainKeyboard = () =>
  Markup.keyboard([["🔢 Generate Alias", "ℹ️ Info"]])
    .resize()
    .oneTime(false);

// ===== HELPER EMAIL =====
function isGmailAddress(email) {
  const re = /^[^@\s]+@gmail\.com$/i;
  return re.test(email);
}

/** buang +tag dan titik di local part */
function normalizeLocalPart(localPart) {
  const withoutPlus = localPart.split("+")[0];
  return withoutPlus.replace(/\./g, "");
}

/** hitung jumlah kombinasi teoritis 2^(n-1); pakai BigInt */
function countPossibleAliasesBigInt(n) {
  if (n <= 1) return 1n;
  return 1n << BigInt(n - 1);
}

/**
 * generate kombinasi titik di antara huruf
 * baseLocal: string tanpa titik/plus
 * domain: "gmail.com"
 * startMask: dari index ke berapa (0-based)
 * count: mau berapa alias
 *
 * NOTE: memakai Number bitshift, jadi aman untuk panjang nama wajar (<= 20-an)
 */
function generateDotAliasesFrom(baseLocal, domain, startMask, count) {
  const n = baseLocal.length;
  if (n <= 1) {
    return startMask === 0 && count > 0 ? [`${baseLocal}@${domain}`] : [];
  }

  const maxMasks = 1 << (n - 1); // total kombinasi (Number)
  const endMask = Math.min(startMask + count, maxMasks);
  const aliases = [];

  for (let mask = startMask; mask < endMask; mask++) {
    let local = "";
    for (let i = 0; i < n; i++) {
      local += baseLocal[i];
      if (i < n - 1 && (mask & (1 << i))) {
        local += ".";
      }
    }
    aliases.push(`${local}@${domain}`);
  }

  return aliases;
}

function formatBigInt(b) {
  return b.toString();
}

// ===== HANDLERS =====
bot.start(async (ctx) => {
  const userId = ctx.from.id;
  clearUserState(userId);

  await ctx.replyWithHTML(
    "🔥 <b>Gmail Alias Generator Bot</b>\n\n" +
      "1️⃣ Klik <b>🔢 Generate Alias</b>\n" +
      "2️⃣ Kirim alamat <b>Gmail</b>\n" +
      "3️⃣ Pilih sendiri mau generate berapa alias\n\n" +
      "Kalau kirim email yang sama lagi, bot akan <b>melanjutkan alias berikutnya</b> (tidak mengulang yang lama).\n\n" +
      "Perintah tambahan:\n" +
      "- <code>/statusemail</code> → cek progres alias per email\n" +
      "- <code>/resetemail</code> → reset progres email (manual, tanpa tombol)\n\n" +
      "Contoh email: <code>emailmu@gmail.com</code>",
    mainKeyboard()
  );
});

bot.hears("ℹ️ Info", async (ctx) => {
  await ctx.replyWithHTML(
    "ℹ️ <b>Info</b>\n\n" +
      "- Hanya mendukung alamat: <code>@gmail.com</code>\n" +
      "- Bot <b>tidak</b> membuat akun Gmail baru, hanya alias DOT trick.\n" +
      "- Untuk setiap email, bot menyimpan progres alias yang sudah pernah dikirim.\n" +
      "- Cek status dengan <code>/statusemail</code>\n" +
      "- Reset progres email dengan <code>/resetemail</code> (tanpa tombol, supaya aman).\n\n" +
      "Gunakan sesuai <b>Terms of Service Gmail</b> & web yang kamu pakai.",
    mainKeyboard()
  );
});

bot.hears("🔢 Generate Alias", async (ctx) => {
  const userId = ctx.from.id;
  setUserState(userId, { mode: "ask_email", emailData: null });

  await ctx.replyWithHTML(
    "Silakan kirim alamat <b>Gmail</b> kamu.\n\n" +
      "Contoh: <code>emailmu@gmail.com</code>",
    { parse_mode: "HTML", ...mainKeyboard() }
  );
});

// ===== PERINTAH STATUS & RESET (tanpa tombol) =====
bot.command("statusemail", async (ctx) => {
  const userId = ctx.from.id;
  setUserState(userId, { mode: "ask_status_email", emailData: null });

  await ctx.replyWithHTML(
    "Kirim email <b>Gmail</b> yang mau dicek status alias-nya.\n\n" +
      "Contoh: <code>emailmu@gmail.com</code>",
    { parse_mode: "HTML", ...mainKeyboard() }
  );
});

bot.command("resetemail", async (ctx) => {
  const userId = ctx.from.id;
  setUserState(userId, { mode: "ask_reset_email", emailData: null });

  await ctx.replyWithHTML(
    "⚠️ <b>RESET PROGRES EMAIL</b>\n\n" +
      "Kirim email <b>Gmail</b> yang mau di-reset progres alias-nya.\n" +
      "Alias yang sudah tercatat sebagai 'pernah dikirim' akan dihapus progresnya.\n\n" +
      "Contoh: <code>emailmu@gmail.com</code>",
    { parse_mode: "HTML", ...mainKeyboard() }
  );
});

// semua text lain
bot.on("text", async (ctx) => {
  const userId = ctx.from.id;
  const text = ctx.message.text.trim();
  const state = getUserState(userId);
  const mode = state.mode;

  // tombol sudah di-handle di atas
  if (text === "🔢 Generate Alias" || text === "ℹ️ Info") return;

  // ===== MODE: STATUS EMAIL =====
  if (mode === "ask_status_email") {
    if (!isGmailAddress(text)) {
      return ctx.replyWithHTML(
        "❌ Format email tidak valid atau bukan <code>@gmail.com</code>.\n" +
          "Contoh yang benar: <code>emailmu@gmail.com</code>",
        { parse_mode: "HTML", ...mainKeyboard() }
      );
    }

    const [rawLocal, rawDomain] = text.split("@");
    const domain = rawDomain.toLowerCase();
    const normalized = normalizeLocalPart(rawLocal);
    if (!normalized) {
      clearUserState(userId);
      return ctx.reply(
        "Local part email kosong setelah normalisasi. Coba email lain.",
        mainKeyboard()
      );
    }

    const n = normalized.length;
    const totalBig = countPossibleAliasesBigInt(n);
    let maxMasks = 1 << (n - 1);
    if (totalBig <= BigInt(Number.MAX_SAFE_INTEGER)) {
      const t = Number(totalBig);
      if (maxMasks > t) maxMasks = t;
    }

    const baseKey = `${normalized}@${domain}`;
    const prev = aliasState[baseKey] || { offset: 0 };
    let offset = prev.offset || 0;
    if (offset > maxMasks) offset = maxMasks;
    const remaining = maxMasks - offset;

    clearUserState(userId);

    return ctx.replyWithHTML(
      "📊 <b>Status Email Alias</b>\n\n" +
        `Email dasar: <code>${normalized}@${domain}</code>\n` +
        `Jumlah kombinasi teoritis: <b>${formatBigInt(totalBig)}</b>\n` +
        `Alias yang sudah pernah dikirim: <b>${offset}</b>\n` +
        `Alias unik yang masih bisa dibuat: <b>${remaining}</b>\n\n` +
        "Kalau mau generate alias baru, klik <b>🔢 Generate Alias</b>.",
      { parse_mode: "HTML", ...mainKeyboard() }
    );
  }

  // ===== MODE: RESET EMAIL (minta email) =====
  if (mode === "ask_reset_email") {
    if (!isGmailAddress(text)) {
      return ctx.replyWithHTML(
        "❌ Format email tidak valid atau bukan <code>@gmail.com</code>.\n" +
          "Contoh yang benar: <code>emailmu@gmail.com</code>",
        { parse_mode: "HTML", ...mainKeyboard() }
      );
    }

    const [rawLocal, rawDomain] = text.split("@");
    const domain = rawDomain.toLowerCase();
    const normalized = normalizeLocalPart(rawLocal);
    if (!normalized) {
      clearUserState(userId);
      return ctx.reply(
        "Local part email kosong setelah normalisasi. Coba email lain.",
        mainKeyboard()
      );
    }

    const baseKey = `${normalized}@${domain}`;
    const prev = aliasState[baseKey] || { offset: 0 };
    const offset = prev.offset || 0;

    if (!aliasState[baseKey] || offset === 0) {
      clearUserState(userId);
      return ctx.replyWithHTML(
        "Tidak ada progres alias yang tercatat untuk email ini.\n" +
          "Tidak perlu di-reset.",
        { parse_mode: "HTML", ...mainKeyboard() }
      );
    }

    const n = normalized.length;
    const totalBig = countPossibleAliasesBigInt(n);
    let maxMasks = 1 << (n - 1);
    if (totalBig <= BigInt(Number.MAX_SAFE_INTEGER)) {
      const t = Number(totalBig);
      if (maxMasks > t) maxMasks = t;
    }
    const remaining = maxMasks - offset;

    setUserState(userId, {
      mode: "confirm_reset_email",
      emailData: { baseKey, normalized, domain, offset, totalBig, remaining },
    });

    return ctx.replyWithHTML(
      "⚠️ <b>Konfirmasi Reset</b>\n\n" +
        `Email dasar: <code>${normalized}@${domain}</code>\n` +
        `Jumlah kombinasi teoritis: <b>${formatBigInt(totalBig)}</b>\n` +
        `Alias yang sudah pernah dikirim: <b>${offset}</b>\n` +
        `Alias unik yang masih bisa dibuat: <b>${remaining}</b>\n\n` +
        "Kalau kamu yakin mau menghapus progres alias email ini, ketik:\n" +
        "<code>YA RESET</code>\n\n" +
        "Kalau bukan, ketik apa saja selain itu untuk batal.",
      { parse_mode: "HTML", ...mainKeyboard() }
    );
  }

  // ===== MODE: KONFIRMASI RESET =====
  if (mode === "confirm_reset_email") {
    const emailData = state.emailData;
    if (!emailData) {
      clearUserState(userId);
      return ctx.reply(
        "Terjadi kesalahan state. Silakan /start ulang.",
        mainKeyboard()
      );
    }

    if (text.trim().toUpperCase() === "YA RESET") {
      const { baseKey, normalized, domain } = emailData;

      if (aliasState[baseKey]) {
        delete aliasState[baseKey];
        saveAliasState(aliasState);
      }

      clearUserState(userId);

      return ctx.replyWithHTML(
        "✅ Progres alias untuk email berikut sudah di-reset:\n\n" +
          `<code>${normalized}@${domain}</code>\n\n` +
          "Sekarang kalau kamu generate lagi, alias akan dihitung dari awal.",
        { parse_mode: "HTML", ...mainKeyboard() }
      );
    }

    // selain "YA RESET" → batal
    clearUserState(userId);
    return ctx.replyWithHTML(
      "❎ Reset dibatalkan.\nProgres alias tetap seperti semula.",
      { parse_mode: "HTML", ...mainKeyboard() }
    );
  }

  // ===== MODE: GENERATE - MINTA EMAIL =====
  if (mode === "ask_email") {
    if (!isGmailAddress(text)) {
      return ctx.replyWithHTML(
        "❌ Format email tidak valid atau bukan <code>@gmail.com</code>.\n" +
          "Contoh yang benar: <code>emailmu@gmail.com</code>",
        { parse_mode: "HTML", ...mainKeyboard() }
      );
    }

    const [rawLocal, rawDomain] = text.split("@");
    const domain = rawDomain.toLowerCase();
    const normalized = normalizeLocalPart(rawLocal);

    if (!normalized) {
      clearUserState(userId);
      return ctx.reply(
        "Local part email kosong setelah normalisasi. Coba email lain.",
        mainKeyboard()
      );
    }

    const n = normalized.length;
    const totalPossibleBig = countPossibleAliasesBigInt(n); // BigInt
    let maxMasks = 1 << (n - 1); // batas real (Number)

    const baseKey = `${normalized}@${domain}`;
    const prev = aliasState[baseKey] || { offset: 0 };
    let offset = prev.offset || 0;
    if (offset > maxMasks) offset = maxMasks;

    const remaining = maxMasks - offset;

    if (remaining <= 0) {
      clearUserState(userId);
      return ctx.replyWithHTML(
        "☑️ Semua kombinasi alias untuk email ini sudah pernah digenerate.\n\n" +
          "Kalau mau lagi, gunakan email lain atau reset progres dengan <code>/resetemail</code>.",
        { parse_mode: "HTML", ...mainKeyboard() }
      );
    }

    const totalText = formatBigInt(totalPossibleBig);
    let extraInfo = "";
    if (offset > 0) {
      extraInfo =
        `\n\n📌 Email ini sudah pernah digenerate sebelumnya:\n` +
        `- Alias yang sudah dikirim: <b>${offset}</b>\n` +
        `- Sisa alias unik yang masih bisa dibuat: <b>${remaining}</b>`;
    }

    setUserState(userId, {
      mode: "ask_count",
      emailData: {
        normalized,
        domain,
        totalPossibleBig,
        maxMasks,
        offset,
        baseKey,
      },
    });

    return ctx.replyWithHTML(
      "📧 Email diterima: <code>" +
        normalized +
        "@" +
        domain +
        "</code>\n\n" +
        `Jumlah kombinasi alias yang mungkin (teoritis): <b>${totalText}</b>` +
        extraInfo +
        "\n\nSekarang kirim angka berapa alias <b>baru</b> yang kamu mau.\n" +
        `Batas maksimal untuk email ini sekarang: <b>${remaining}</b>\n\n` +
        "Contoh: <code>100</code>",
      { parse_mode: "HTML", ...mainKeyboard() }
    );
  }

  // ===== MODE: GENERATE - MINTA JUMLAH =====
  if (mode === "ask_count") {
    const emailData = state.emailData;
    if (!emailData) {
      clearUserState(userId);
      return ctx.reply(
        "Terjadi kesalahan state. Silakan /start ulang.",
        mainKeyboard()
      );
    }

    const num = Number(text);
    if (!Number.isInteger(num) || num < 1) {
      return ctx.replyWithHTML(
        "❌ Input jumlah tidak valid.\nKirim angka, contoh: <code>50</code>",
        { parse_mode: "HTML", ...mainKeyboard() }
      );
    }

    const {
      normalized,
      domain,
      totalPossibleBig,
      maxMasks,
      offset,
      baseKey,
    } = emailData;

    const remaining = maxMasks - offset;
    if (num > remaining) {
      return ctx.replyWithHTML(
        `❌ Terlalu besar.\nAlias baru yang tersisa untuk email ini hanya: <b>${remaining}</b>\n` +
          "Kirim lagi dengan angka ≤ jumlah tersisa.",
        { parse_mode: "HTML", ...mainKeyboard() }
      );
    }

    const count = num;
    const totalText = formatBigInt(totalPossibleBig);

    // generate alias baru mulai dari offset
    const aliases = generateDotAliasesFrom(
      normalized,
      domain,
      offset,
      count
    );

    // update offset & simpan ke JSON
    const newOffset = offset + aliases.length;
    aliasState[baseKey] = {
      normalized,
      domain,
      offset: newOffset,
    };
    saveAliasState(aliasState);

    // header info
    await ctx.replyWithHTML(
      `📧 <b>Gmail Alias Generator</b>\n\n` +
        `Base email: <code>${normalized}@${domain}</code>\n` +
        `Jumlah kombinasi alias (teoritis): <b>${totalText}</b>\n` +
        `Alias yang sudah pernah dikirim sebelum ini: <b>${offset}</b>\n` +
        `Alias baru yang kamu minta sekarang: <b>${count}</b>\n` +
        `Total alias yang sudah pernah dikirim untuk email ini: <b>${newOffset}</b>\n\n` +
        "Alias akan dikirim 1 pesan 1 email (monospace) supaya gampang di-tap & copy.\n\n" +
        "⚠️ Catatan: Kalau jumlahnya besar banget, Telegram bisa agak lama atau kena limit.",
      { parse_mode: "HTML", ...mainKeyboard() }
    );

    // kirim 1 pesan 1 email
    for (const alias of aliases) {
      await ctx.replyWithHTML(`<code>${alias}</code>`, {
        parse_mode: "HTML",
      });
    }

    clearUserState(userId);

    await ctx.replyWithHTML(
      "✅ Selesai kirim alias baru.\n" +
        "Kalau mau generate lagi email yang sama, bot akan otomatis lanjut dari alias berikutnya.\n\n" +
        "Klik <b>🔢 Generate Alias</b> untuk mulai lagi, atau pakai <code>/statusemail</code> untuk cek progres.",
      mainKeyboard()
    );

    return;
  }

  // ===== MODE DEFAULT =====
  if (!mode) {
    if (isGmailAddress(text)) {
      return ctx.replyWithHTML(
        "Untuk generate alias:\n" +
          "1️⃣ Klik <b>🔢 Generate Alias</b>\n" +
          "2️⃣ Kirim email Gmail kamu di sana.\n\n" +
          "Ini supaya alurnya rapi 😊",
        mainKeyboard()
      );
    }

    return ctx.reply(
      "Kalau mau generate alias, klik tombol <b>🔢 Generate Alias</b> di bawah atau kirim /start.",
      mainKeyboard()
    );
  }
});

// error handler
bot.catch((err, ctx) => {
  console.error("BOT ERROR:", err, "on update", ctx.updateType);
});

// start bot
bot.launch().then(() => {
  console.log("Bot Gmail Alias Generator sudah jalan 🚀 (pakai JSON state + status/reset)");
});

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
