// index.js (SoulScript Legacy backend)
// Checkout upgraded:
// - Backend calculates prices safely
// - Breeze Edition kept at ₹2 for testing
// - Razorpay signature verification fixed
// - Account login upgraded from magic link to email OTP
// - Existing routes preserved: dispatch hook, email debug, portal link, portal order, submit story
// - Admin API added for SoulScript admin panel
// - Story Portal API added for story intake, voice note add-ons, cover add-ons, balance payments, revisions, extra copies, polaroids

const express = require("express")
const Razorpay = require("razorpay")
const crypto = require("crypto")
const cors = require("cors")
const { Resend } = require("resend")
const { createClient } = require("@supabase/supabase-js")

const app = express()

/* =========================
   BASIC MIDDLEWARE
========================= */
app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "PATCH", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
)

app.use(express.json({ limit: "15mb" }))

/* =========================
   HELPERS
========================= */
const must = (key) => {
  const v = process.env[key]
  if (!v) console.warn(`⚠️ Missing env var: ${key}`)
  return v
}

const safeErr = (e) => {
  const obj = {
    message: e?.message || String(e),
    name: e?.name,
    statusCode: e?.statusCode || e?.status,
  }

  if (e?.response) obj.response = e.response
  if (e?.cause) obj.cause = e.cause
  if (e?.stack) obj.stack = e.stack.split("\n").slice(0, 6).join("\n")

  return obj
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase()
}

function createToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString("hex")
}

function createOtp() {
  return String(crypto.randomInt(100000, 1000000))
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;")
}

function hashOtp(email, otp) {
  const secret =
    process.env.OTP_SECRET ||
    process.env.RAZORPAY_KEY_SECRET ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    "soulscript-otp-fallback-secret"

  return crypto
    .createHmac("sha256", secret)
    .update(`${normalizeEmail(email)}:${String(otp).trim()}`)
    .digest("hex")
}

function normalizeText(value, max = 5000) {
  const text = String(value || "").trim()
  return text.slice(0, max)
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(value || "")
  )
}

function getRazorpayPublicKey() {
  return RAZORPAY_KEY_ID
}

async function sendEmailSafe({ to, subject, html }) {
  try {
    const r = await resend.emails.send({
      from: EMAIL_FROM,
      to: Array.isArray(to) ? to : [to],
      subject,
      html,
    })
    return { ok: true, response: r }
  } catch (e) {
    console.error(`❌ Email failed: ${subject}`, safeErr(e))
    return { ok: false, error: safeErr(e) }
  }
}

/* =========================
   SUPABASE
========================= */
const supabase = createClient(
  must("SUPABASE_URL"),
  must("SUPABASE_SERVICE_ROLE_KEY")
)

/* =========================
   RESEND
========================= */
const resend = new Resend(must("RESEND_API_KEY"))

const EMAIL_FROM =
  process.env.EMAIL_FROM || "SoulScript Legacy <hello@soulscriptlegacy.com>"

const PORTAL_BASE_URL =
  process.env.PORTAL_BASE_URL || "https://soulscriptlegacy.com"

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "soulscriptlegacy@gmail.com"

/* =========================
   RAZORPAY
========================= */
const RAZORPAY_KEY_ID = must("RAZORPAY_KEY_ID")
const RAZORPAY_KEY_SECRET = must("RAZORPAY_KEY_SECRET")

const razorpay = new Razorpay({
  key_id: RAZORPAY_KEY_ID,
  key_secret: RAZORPAY_KEY_SECRET,
})

const AIRTABLE_WEBHOOK_SECRET = process.env.AIRTABLE_WEBHOOK_SECRET || ""

/* =========================
   CUSTOMER ACCOUNT HELPERS
========================= */
const ACCOUNT_SESSION_DAYS = 180
const OTP_EXPIRY_MINUTES = 10

async function getCustomerFromSession(req) {
  const authHeader = String(req.header("Authorization") || "")

  if (!authHeader.startsWith("Bearer ")) {
    return { error: "Missing account session", status: 401 }
  }

  const sessionToken = authHeader.replace("Bearer ", "").trim()

  if (!sessionToken) {
    return { error: "Missing account session", status: 401 }
  }

  const { data: session, error } = await supabase
    .from("customer_sessions")
    .select("*")
    .eq("session_token", sessionToken)
    .eq("revoked", false)
    .single()

  if (error || !session) {
    return { error: "Invalid or expired account session", status: 401 }
  }

  await supabase
    .from("customer_sessions")
    .update({ last_seen_at: new Date().toISOString() })
    .eq("id", session.id)

  return {
    email: normalizeEmail(session.email),
    session,
  }
}

/* =========================
   PRICING RULES
========================= */
const EDITION_PRICES = {
  "Breeze Edition": 2,
  "Confession Edition": 1999,
  "Classic Edition": 2599,
  "Essence Edition": 3499,
}

const ULTRA_PRIORITY_PRICE = 1000

const ADDON_PRICES = {
  voice_note_hour: 349,
  custom_cover: 499,
  extra_softcover_copy: 399,
  extra_hardcover_copy: 499,
  extra_polaroids_pack: 249,
}

function calculateCheckoutAmount({ edition, paymentType, ultraPriority }) {
  const basePrice = EDITION_PRICES[edition]

  if (!basePrice) {
    throw new Error(`Invalid or unpriced edition: ${edition}`)
  }

  const addOnsTotal = ultraPriority ? ULTRA_PRIORITY_PRICE : 0
  const totalOrderValue = basePrice + addOnsTotal

  const amountToPay =
    paymentType === "PREPAID"
      ? totalOrderValue
      : Math.ceil(totalOrderValue / 2)

  const pendingAmount = totalOrderValue - amountToPay

  return {
    basePrice,
    addOnsTotal,
    totalOrderValue,
    amountToPay,
    pendingAmount,
  }
}

function getIncludedVoiceSeconds(edition) {
  if (edition === "Classic Edition") return 30 * 60
  if (edition === "Essence Edition") return 60 * 60
  return 0
}

function getReviewTimeline(edition) {
  if (edition === "Essence Edition") return "12 to 16 working days"
  return "8 to 12 working days"
}

function getAddonAmount({ addonType, quantity = 1, customAmount }) {
  const qty = Math.max(1, Number(quantity || 1))

  if (addonType === "voice_note_hour") return ADDON_PRICES.voice_note_hour * qty
  if (addonType === "custom_cover") return ADDON_PRICES.custom_cover
  if (addonType === "extra_softcover_copy") return ADDON_PRICES.extra_softcover_copy * qty
  if (addonType === "extra_hardcover_copy") return ADDON_PRICES.extra_hardcover_copy * qty
  if (addonType === "extra_polaroids_pack") return ADDON_PRICES.extra_polaroids_pack * qty
  if (addonType === "revision_charge") {
    const amount = Number(customAmount || 0)
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new Error("Valid revision amount required")
    }
    return amount
  }
  if (addonType === "balance_payment") {
    const amount = Number(customAmount || 0)
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new Error("Valid balance amount required")
    }
    return amount
  }

  throw new Error(`Invalid add-on type: ${addonType}`)
}

async function getOrderByIdOrRazorpay(orderId) {
  const clean = String(orderId || "").trim()
  if (!clean) return null

  let query = supabase.from("orders").select("*")

  if (isUuid(clean)) query = query.eq("id", clean)
  else query = query.eq("razorpay_order_id", clean)

  const { data, error } = await query.single()
  if (error || !data) return null
  return data
}

async function refreshOrderTotals(orderId) {
  const { data: order, error: orderErr } = await supabase
    .from("orders")
    .select("*")
    .eq("id", orderId)
    .single()

  if (orderErr || !order) return null

  const basePrice = EDITION_PRICES[order.edition] || Number(order.amount || 0)

  const { data: paidAddons } = await supabase
    .from("order_addons")
    .select("amount, status")
    .eq("order_id", orderId)
    .eq("status", "paid")

  const paidAddonTotal = (paidAddons || []).reduce((sum, item) => {
    const amount = Number(item.amount || 0)
    return Number.isFinite(amount) ? sum + amount : sum
  }, 0)

  const paidAmount = Number(order.amount || 0) + paidAddonTotal
  const totalOrderValue = basePrice + paidAddonTotal
  const balanceDue = Math.max(0, totalOrderValue - paidAmount)

  await supabase
    .from("orders")
    .update({
      total_order_value: totalOrderValue,
      paid_amount: paidAmount,
      balance_due: balanceDue,
    })
    .eq("id", orderId)

  return { totalOrderValue, paidAmount, balanceDue }
}

/* =========================
   PRICING QUOTE
========================= */
app.post("/quote", (req, res) => {
  try {
    const { edition, paymentType = "PREPAID", ultraPriority = false } = req.body

    if (!edition) {
      return res.status(400).json({ error: "Edition required" })
    }

    const pricing = calculateCheckoutAmount({
      edition,
      paymentType,
      ultraPriority: !!ultraPriority,
    })

    return res.json({
      success: true,
      ...pricing,
      ultraPriorityPrice: ULTRA_PRIORITY_PRICE,
    })
  } catch (err) {
    console.error("❌ /quote failed:", safeErr(err))
    return res.status(400).json({ error: err?.message || "Quote failed" })
  }
})

/* =========================
   HEALTH CHECK
========================= */
app.get("/health", (req, res) => {
  return res.json({
    ok: true,
    time: new Date().toISOString(),
    portalBase: PORTAL_BASE_URL,
    emailFrom: EMAIL_FROM,
    adminEmail: ADMIN_EMAIL,
    pricing: EDITION_PRICES,
    addOns: ADDON_PRICES,
    accountLogin: "email_otp",
    otpExpiryMinutes: OTP_EXPIRY_MINUTES,
  })
})

/* =========================
   AIRTABLE DISPATCH HOOK
========================= */
app.post("/hooks/dispatch", async (req, res) => {
  try {
    const secret = String(req.header("x-hook-secret") || "").trim()

    if (!AIRTABLE_WEBHOOK_SECRET) {
      console.warn("⚠️ AIRTABLE_WEBHOOK_SECRET missing in env")
      return res.status(500).json({ ok: false, error: "Server not configured" })
    }

    if (secret !== AIRTABLE_WEBHOOK_SECRET) {
      return res.status(401).json({ ok: false, error: "Unauthorized" })
    }

    console.log("✅ Dispatch hook hit:", req.body)

    const recordId = String(req.body?.recordId || "").trim()
    if (!recordId) {
      return res.status(400).json({ ok: false, error: "recordId missing" })
    }

    return res.json({ ok: true, received: { recordId } })
  } catch (e) {
    console.error("❌ /hooks/dispatch error:", safeErr(e))
    return res.status(500).json({ ok: false, error: safeErr(e) })
  }
})

/* =========================
   DEBUG RESEND
========================= */
app.get("/debug/email", async (req, res) => {
  try {
    const to = String(req.query.to || ADMIN_EMAIL).trim().toLowerCase()

    const r = await resend.emails.send({
      from: EMAIL_FROM,
      to: [to],
      subject: "✅ Resend test (SoulScript)",
      html: `<p>If you got this, Resend API works.</p><p>Time: ${new Date().toISOString()}</p>`,
    })

    return res.json({ success: true, to, resend: r })
  } catch (e) {
    const err = safeErr(e)
    console.error("❌ /debug/email failed:", err)
    return res.status(500).json({ success: false, error: err })
  }
})

/* =========================
   CREATE RAZORPAY ORDER
========================= */
app.post("/create-order", async (req, res) => {
  try {
    const { edition, productSlug, paymentType, ultraPriority, customer } =
      req.body

    if (!edition || !paymentType || !customer) {
      return res.status(400).json({ error: "Missing checkout data" })
    }

    if (
      !customer.name ||
      !customer.phone ||
      !customer.email ||
      !customer.address
    ) {
      return res.status(400).json({ error: "Customer details missing" })
    }

    if (!["PREPAID", "ADVANCE"].includes(paymentType)) {
      return res.status(400).json({ error: "Invalid payment type" })
    }

    const pricing = calculateCheckoutAmount({
      edition,
      paymentType,
      ultraPriority: !!ultraPriority,
    })

    const receipt = "ssl_" + Date.now()

    const razorpayOrder = await razorpay.orders.create({
      amount: pricing.amountToPay * 100,
      currency: "INR",
      receipt,
      notes: {
        flow: "main_checkout",
        edition,
        productSlug: productSlug || "",
        paymentType,
        ultraPriority: ultraPriority ? "yes" : "no",
        basePrice: String(pricing.basePrice),
        addOnsTotal: String(pricing.addOnsTotal),
        totalOrderValue: String(pricing.totalOrderValue),
        amountToPay: String(pricing.amountToPay),
        pendingAmount: String(pricing.pendingAmount),
        customerName: customer.name,
        customerEmail: String(customer.email).trim().toLowerCase(),
        customerPhone: customer.phone,
      },
    })

    return res.json({
      success: true,
      keyId: RAZORPAY_KEY_ID,
      razorpayKeyId: RAZORPAY_KEY_ID,
      razorpayOrderId: razorpayOrder.id,
      amount: razorpayOrder.amount,
      currency: razorpayOrder.currency,
      amountToPay: pricing.amountToPay,
      totalOrderValue: pricing.totalOrderValue,
      pendingAmount: pricing.pendingAmount,
    })
  } catch (err) {
    console.error("❌ /create-order failed:", safeErr(err))
    return res.status(500).json({
      error: err?.message || "Order creation failed",
    })
  }
})

/* =========================
   CONFIRM PAYMENT
========================= */
app.post("/confirm-payment", async (req, res) => {
  try {
    const {
      razorpay_payment_id,
      razorpay_order_id,
      razorpay_signature,
      customer,
    } = req.body

    if (
      !razorpay_payment_id ||
      !razorpay_order_id ||
      !razorpay_signature ||
      !customer ||
      !customer.name ||
      !customer.phone ||
      !customer.email ||
      !customer.address
    ) {
      return res.status(400).json({ error: "Missing required payment data" })
    }

    const expectedSignature = crypto
      .createHmac("sha256", RAZORPAY_KEY_SECRET)
      .update(razorpay_order_id + "|" + razorpay_payment_id)
      .digest("hex")

    if (expectedSignature !== razorpay_signature) {
      console.error("❌ Invalid Razorpay signature")
      return res.status(400).json({ error: "Invalid payment signature" })
    }

    const razorpayOrder = await razorpay.orders.fetch(razorpay_order_id)
    const notes = razorpayOrder.notes || {}

    const edition = notes.edition
    const paymentType = notes.paymentType
    const amountToPay = Number(notes.amountToPay || 0)
    const totalOrderValue = Number(notes.totalOrderValue || 0)
    const pendingAmount = Number(notes.pendingAmount || 0)
    const ultraPriority = notes.ultraPriority === "yes"

    const normalizedEmail = normalizeEmail(customer.email)

    const normalizedPaymentType =
      paymentType === "PREPAID" ? "PREPAID" : "ADVANCE"

    const { data: insertedOrder, error: dbError } = await supabase
      .from("orders")
      .insert([
        {
          razorpay_order_id,
          razorpay_payment_id,
          edition,
          payment_type: normalizedPaymentType,
          amount: amountToPay,
          total_order_value: totalOrderValue || null,
          paid_amount: amountToPay,
          balance_due: pendingAmount,
          name: customer.name,
          email: normalizedEmail,
          phone: customer.phone,
          address: customer.address,
        },
      ])
      .select("*")
      .single()

    if (dbError) {
      console.error("⚠️ Supabase insert failed:", dbError)
      return res.status(500).json({
        error: "Payment verified but failed to save order",
        details: dbError,
      })
    }

    console.log("✅ Order saved to Supabase:", razorpay_order_id)

    await sendEmailSafe({
      to: ADMIN_EMAIL,
      subject: `🖤 New Order Confirmed – ${edition}`,
      html: `
        <h2>New Order Confirmed</h2>
        <p><strong>Edition:</strong> ${escapeHtml(edition)}</p>
        <p><strong>Payment Type:</strong> ${
          normalizedPaymentType === "PREPAID" ? "Paid in full" : "50% Advance"
        }</p>
        <p><strong>Amount Paid:</strong> ₹${amountToPay}</p>
        <p><strong>Total Order Value:</strong> ₹${totalOrderValue}</p>
        <p><strong>Pending Amount:</strong> ₹${pendingAmount}</p>
        <p><strong>Ultra Priority:</strong> ${ultraPriority ? "Yes" : "No"}</p>
        <p><strong>Razorpay Payment ID:</strong> ${escapeHtml(razorpay_payment_id)}</p>
        <p><strong>Razorpay Order ID:</strong> ${escapeHtml(razorpay_order_id)}</p>
        <hr />
        <p><strong>Name:</strong> ${escapeHtml(customer.name)}</p>
        <p><strong>Phone:</strong> ${escapeHtml(customer.phone)}</p>
        <p><strong>Email:</strong> ${escapeHtml(normalizedEmail)}</p>
        <p><strong>Address:</strong><br/>${escapeHtml(customer.address)}</p>
      `,
    })

    await sendEmailSafe({
      to: normalizedEmail,
      subject: `Your SoulScript Legacy order is confirmed`,
      html: `
        <div style="font-family: Arial, sans-serif; line-height:1.7; color:#111;">
          <h2>Order confirmed</h2>
          <p>Dear ${escapeHtml(customer.name)},</p>
          <p>Your ${escapeHtml(edition)} has been booked successfully.</p>
          <p>You can now open your private story submission portal and submit your details.</p>
          <p><a href="${PORTAL_BASE_URL}/story?order=${encodeURIComponent(razorpay_order_id)}" style="display:inline-block;background:#0E0E0E;color:#fff;padding:12px 16px;text-decoration:none;">Open Story Portal</a></p>
          <p>Best regards,<br/>SoulScript Legacy</p>
        </div>
      `,
    })

    return res.json({
      success: true,
      nextUrl: `/story?order=${razorpay_order_id}`,
      razorpayOrderId: razorpay_order_id,
      order: insertedOrder,
    })
  } catch (err) {
    console.error("❌ /confirm-payment error:", safeErr(err))
    return res.status(500).json({
      error: "Payment confirmation failed",
      details: safeErr(err),
    })
  }
})

/* =========================
   CUSTOMER ACCOUNT OTP LOGIN
========================= */
async function sendAccountOtpForEmail(email, res) {
  const cleanEmail = normalizeEmail(email)

  if (!cleanEmail || !cleanEmail.includes("@")) {
    return res.status(400).json({ error: "Valid email required" })
  }

  const { data: existingOrders, error: orderCheckErr } = await supabase
    .from("orders")
    .select("id, name")
    .eq("email", cleanEmail)
    .order("created_at", { ascending: false })
    .limit(1)

  if (orderCheckErr) {
    console.error("❌ Failed to check customer orders:", orderCheckErr)
    return res.status(500).json({ error: "Could not check account" })
  }

  if (!existingOrders || existingOrders.length === 0) {
    return res.status(404).json({
      error: "No orders found with this email. Please use the email entered during checkout.",
    })
  }

  const customerName =
    String(existingOrders?.[0]?.name || "").trim() || "SoulScript customer"

  const safeCustomerName = escapeHtml(customerName)

  const otp = createOtp()
  const otpHash = hashOtp(cleanEmail, otp)
  const expiresAt = new Date(
    Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000
  ).toISOString()

  await supabase
    .from("customer_login_tokens")
    .update({ used: true })
    .eq("email", cleanEmail)
    .eq("used", false)

  const { error: tokenErr } = await supabase
    .from("customer_login_tokens")
    .insert({
      email: cleanEmail,
      token: otpHash,
      expires_at: expiresAt,
      used: false,
    })

  if (tokenErr) {
    console.error("❌ Failed to create account OTP:", tokenErr)
    return res.status(500).json({ error: "Could not create OTP" })
  }

  const html = `
    <!doctype html>
    <html>
      <head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /></head>
      <body style="margin:0;padding:0;background:#f3f3f3;font-family:Arial, Helvetica, sans-serif;color:#111111;">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#f3f3f3;margin:0;padding:0;">
          <tr><td align="center" style="padding:42px 16px;">
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:600px;background:#ffffff;margin:0 auto;color:#111111;">
              <tr><td align="center" style="padding:46px 38px 52px;background:#ffffff;color:#111111;">
                <div style="font-family:Georgia, 'Times New Roman', serif;font-size:20px;font-weight:500;letter-spacing:5px;color:#0E0E0E;line-height:1;text-transform:uppercase;">SOULSCRIPT</div>
                <div style="font-family:Arial, Helvetica, sans-serif;font-size:8.5px;font-weight:300;letter-spacing:5.5px;color:rgba(14,14,14,0.65);line-height:1;text-transform:uppercase;margin-top:7px;">LEGACY</div>
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr><td style="padding-top:72px;text-align:left;background:#ffffff;color:#111111;">
                  <div style="font-size:18px;line-height:1.4;font-weight:700;color:#111111;margin:0 0 46px;">Profile code</div>
                  <div style="font-size:16px;line-height:1.7;color:#111111;margin:0 0 26px;">Dear ${safeCustomerName},</div>
                  <div style="font-size:16px;line-height:1.7;color:#111111;margin:0 0 12px;">Below you can find the verification code:</div>
                  <div style="font-size:26px;line-height:1.2;letter-spacing:2px;font-weight:400;color:#000000;margin:0 0 18px;">${otp}</div>
                  <div style="font-size:16px;line-height:1.7;color:#111111;margin:0 0 66px;">This code will expire in ${OTP_EXPIRY_MINUTES} minutes.</div>
                  <div style="font-size:16px;line-height:1.35;color:#111111;margin:0 0 82px;">Best regards,<br />SoulScript Legacy</div>
                  <div style="font-size:13px;line-height:1.6;color:#8a8a8a;margin:0;">
                    <a href="${PORTAL_BASE_URL}/privacy" target="_blank" style="color:#8a8a8a;text-decoration:underline;">PRIVACY POLICY</a>
                    <span style="color:#8a8a8a;"> · </span>
                    <a href="${PORTAL_BASE_URL}/terms" target="_blank" style="color:#8a8a8a;text-decoration:underline;">Terms and Conditions</a>
                  </div>
                </td></tr></table>
              </td></tr>
            </table>
          </td></tr>
        </table>
      </body>
    </html>
  `

  try {
    const r = await resend.emails.send({
      from: EMAIL_FROM,
      to: [cleanEmail],
      subject: "Your SoulScript Legacy profile code",
      html,
    })

    console.log("📨 Account OTP email sent:", cleanEmail, r?.id || r)

    return res.json({
      success: true,
      message: "OTP sent to your email",
      email: cleanEmail,
      expiresInMinutes: OTP_EXPIRY_MINUTES,
    })
  } catch (emailErr) {
    console.error("❌ Account OTP email failed:", safeErr(emailErr))

    return res.status(500).json({
      error: "Could not send account OTP email",
      details: safeErr(emailErr),
    })
  }
}

app.post("/account/send-otp", async (req, res) => {
  try {
    return await sendAccountOtpForEmail(req.body?.email, res)
  } catch (err) {
    console.error("❌ /account/send-otp error:", safeErr(err))
    return res.status(500).json({ error: "Server error" })
  }
})

app.post("/account/send-login-link", async (req, res) => {
  try {
    return await sendAccountOtpForEmail(req.body?.email, res)
  } catch (err) {
    console.error("❌ /account/send-login-link alias error:", safeErr(err))
    return res.status(500).json({ error: "Server error" })
  }
})

app.post("/account/verify-otp", async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email)
    const otp = String(req.body?.otp || "").trim()

    if (!email || !email.includes("@")) {
      return res.status(400).json({ error: "Valid email required" })
    }

    if (!otp || !/^\d{6}$/.test(otp)) {
      return res.status(400).json({ error: "Valid 6-digit OTP required" })
    }

    const { data: tokens, error: tokenErr } = await supabase
      .from("customer_login_tokens")
      .select("*")
      .eq("email", email)
      .eq("used", false)
      .order("expires_at", { ascending: false })
      .limit(1)

    const loginToken = tokens?.[0]

    if (tokenErr || !loginToken) {
      return res.status(401).json({ error: "Invalid or expired OTP" })
    }

    if (new Date(loginToken.expires_at).getTime() < Date.now()) {
      await supabase
        .from("customer_login_tokens")
        .update({ used: true })
        .eq("id", loginToken.id)

      return res.status(410).json({ error: "OTP expired. Please request a new one." })
    }

    const expectedHash = hashOtp(email, otp)

    if (loginToken.token !== expectedHash) {
      return res.status(401).json({ error: "Incorrect OTP" })
    }

    const sessionToken = createToken(40)

    const { error: sessionErr } = await supabase
      .from("customer_sessions")
      .insert({
        email,
        session_token: sessionToken,
        revoked: false,
      })

    if (sessionErr) {
      console.error("❌ Failed to create customer session:", sessionErr)
      return res.status(500).json({ error: "Could not create account session" })
    }

    await supabase
      .from("customer_login_tokens")
      .update({ used: true })
      .eq("id", loginToken.id)

    return res.json({
      success: true,
      email,
      sessionToken,
      expiresInDays: ACCOUNT_SESSION_DAYS,
    })
  } catch (err) {
    console.error("❌ /account/verify-otp error:", safeErr(err))
    return res.status(500).json({ error: "Server error" })
  }
})

app.get("/account/verify-login", async (req, res) => {
  return res.status(410).json({
    error: "Magic login links are no longer supported. Please request an email OTP.",
  })
})

app.get("/account/me", async (req, res) => {
  try {
    const customer = await getCustomerFromSession(req)

    if (customer.error) {
      return res.status(customer.status || 401).json({ error: customer.error })
    }

    return res.json({ success: true, email: customer.email })
  } catch (err) {
    console.error("❌ /account/me error:", safeErr(err))
    return res.status(500).json({ error: "Server error" })
  }
})

app.get("/account/orders", async (req, res) => {
  try {
    const customer = await getCustomerFromSession(req)

    if (customer.error) {
      return res.status(customer.status || 401).json({ error: customer.error })
    }

    const { data: orders, error: ordersErr } = await supabase
      .from("orders")
      .select(
        "id, razorpay_order_id, edition, payment_type, amount, total_order_value, paid_amount, balance_due, name, phone, email, address, created_at, story_submitted"
      )
      .eq("email", customer.email)
      .order("created_at", { ascending: false })

    if (ordersErr) {
      console.error("❌ Failed to fetch account orders:", ordersErr)
      return res.status(500).json({ error: "Failed to fetch orders" })
    }

    return res.json({ success: true, email: customer.email, orders: orders || [] })
  } catch (err) {
    console.error("❌ /account/orders error:", safeErr(err))
    return res.status(500).json({ error: "Server error" })
  }
})

app.post("/account/logout", async (req, res) => {
  try {
    const authHeader = String(req.header("Authorization") || "")

    if (!authHeader.startsWith("Bearer ")) return res.json({ success: true })

    const sessionToken = authHeader.replace("Bearer ", "").trim()

    if (sessionToken) {
      await supabase
        .from("customer_sessions")
        .update({ revoked: true })
        .eq("session_token", sessionToken)
    }

    return res.json({ success: true })
  } catch (err) {
    console.error("❌ /account/logout error:", safeErr(err))
    return res.status(500).json({ error: "Server error" })
  }
})

/* =========================
   CUSTOMER PROFILE FROM ORDERS
========================= */
app.get("/account/profile", async (req, res) => {
  try {
    const customer = await getCustomerFromSession(req)

    if (customer.error) {
      return res.status(customer.status || 401).json({ error: customer.error })
    }

    const { data: latestOrder, error } = await supabase
      .from("orders")
      .select("name, phone, email, address")
      .eq("email", customer.email)
      .order("created_at", { ascending: false })
      .limit(1)
      .single()

    if (error || !latestOrder) {
      return res.status(404).json({ error: "No profile found for this account" })
    }

    return res.json({
      success: true,
      profile: {
        name: latestOrder.name || "",
        phone: latestOrder.phone || "",
        email: latestOrder.email || customer.email,
        address: latestOrder.address || "",
        location: "India",
      },
    })
  } catch (err) {
    console.error("❌ /account/profile error:", safeErr(err))
    return res.status(500).json({ error: "Server error" })
  }
})

app.post("/account/profile", async (req, res) => {
  try {
    const customer = await getCustomerFromSession(req)

    if (customer.error) {
      return res.status(customer.status || 401).json({ error: customer.error })
    }

    const name = String(req.body?.name || "").trim()
    const phone = String(req.body?.phone || "").trim()
    const address = String(req.body?.address || "").trim()

    if (!name) return res.status(400).json({ error: "Name is required" })
    if (!phone || phone.length < 8) return res.status(400).json({ error: "Valid phone number is required" })
    if (!address) return res.status(400).json({ error: "Address is required" })

    const { data, error } = await supabase
      .from("orders")
      .update({ name, phone, address })
      .eq("email", customer.email)
      .select("id, name, phone, email, address")

    if (error) {
      console.error("❌ Failed to update account profile:", error)
      return res.status(500).json({ error: "Failed to update profile" })
    }

    return res.json({
      success: true,
      updatedOrders: data?.length || 0,
      profile: { name, phone, email: customer.email, address, location: "India" },
    })
  } catch (err) {
    console.error("❌ /account/profile update error:", safeErr(err))
    return res.status(500).json({ error: "Server error" })
  }
})

app.get("/my-orders", async (req, res) => {
  try {
    return res.status(410).json({
      error: "Legacy my-orders endpoint is no longer used. Please use /account/orders.",
    })
  } catch (err) {
    console.error("❌ /my-orders error:", safeErr(err))
    return res.status(500).json({ error: "Server error" })
  }
})

/* =========================
   SEND PORTAL LINK
========================= */
app.post("/send-portal-link", async (req, res) => {
  try {
    const { email } = req.body
    const normalizedEmail = normalizeEmail(email)

    if (!normalizedEmail || !normalizedEmail.includes("@")) {
      return res.status(400).json({ error: "Valid email required" })
    }

    const { data: order, error } = await supabase
      .from("orders")
      .select("id, razorpay_order_id, edition, email, created_at")
      .eq("email", normalizedEmail)
      .order("created_at", { ascending: false })
      .limit(1)
      .single()

    if (error || !order) {
      console.error("❌ No order found for email:", normalizedEmail, error)
      return res.status(404).json({ error: "No order found for this email" })
    }

    const token = crypto.randomBytes(24).toString("hex")
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString()

    const { error: upErr } = await supabase
      .from("orders")
      .update({ portal_token: token, portal_token_expires_at: expiresAt, portal_token_used: false })
      .eq("id", order.id)

    if (upErr) {
      console.error("❌ Failed to save token:", upErr)
      return res.status(500).json({ error: "Failed to create link" })
    }

    const portalUrl = `${PORTAL_BASE_URL}/story?token=${token}`

    const html = `
      <div style="font-family: Inter, Arial, sans-serif; line-height:1.6;">
        <p>Hi,</p>
        <p>Here is your secure link to continue your story:</p>
        <p><a href="${portalUrl}" style="display:inline-block;padding:12px 16px;background:#000;color:#fff;text-decoration:none;border-radius:10px;">Open My Story Portal</a></p>
        <p style="color:#555;font-size:13px;">This link expires in 30 minutes.</p>
        <p>— SoulScript Legacy</p>
      </div>
    `

    const sent = await sendEmailSafe({ to: normalizedEmail, subject: "Your SoulScript Legacy writing link", html })

    if (sent.ok) return res.json({ success: true, portalUrl })

    const fallback = await sendEmailSafe({
      to: ADMIN_EMAIL,
      subject: "⚠️ Portal link fallback (customer blocked)",
      html: `<p><b>Customer email blocked:</b> ${escapeHtml(normalizedEmail)}</p><hr/>${html}`,
    })

    if (fallback.ok) {
      return res.json({
        success: true,
        portalUrl,
        warning: "Resend blocked sending to customer. Sent fallback to admin email instead.",
        resend_error: sent.error,
      })
    }

    return res.status(500).json({ error: "Email sending failed (Resend).", portalUrl })
  } catch (e) {
    console.error("❌ /send-portal-link error:", safeErr(e))
    return res.status(500).json({ error: "Server error" })
  }
})

/* =========================
   OPEN PORTAL USING TOKEN OR ORDER ID
========================= */
app.get("/portal-order", async (req, res) => {
  try {
    const token = String(req.query.token || "").trim()
    const orderId = String(req.query.order || "").trim()
    const redirect = String(req.query.redirect || "").trim() === "1"

    if (!token && !orderId) {
      return res.status(400).json({ error: "Token or order ID missing" })
    }

    let query = supabase.from("orders").select("*")

    if (token) query = query.eq("portal_token", token)
    else query = query.eq("razorpay_order_id", orderId)

    const { data: order, error } = await query.single()

    if (error || !order) {
      console.error("❌ Order not found:", error)
      return res.status(404).json({ error: "Invalid link or order not found" })
    }

    if (token) {
      if (order.portal_token_used) {
        return res.status(410).json({ error: "Link already used. Please request a new link." })
      }

      if (order.portal_token_expires_at) {
        const exp = new Date(order.portal_token_expires_at).getTime()
        if (Date.now() > exp) {
          return res.status(410).json({ error: "Link expired. Please request a new link." })
        }
      }

      const { error: usedErr } = await supabase
        .from("orders")
        .update({ portal_token_used: true })
        .eq("id", order.id)

      if (usedErr) console.error("⚠️ Failed to mark token used:", usedErr)
    }

    const [storyIntakeRes, voiceNotesRes, callBookingsRes, deliverablesRes, revisionsRes, addonsRes] = await Promise.all([
      supabase.from("story_intakes").select("*").eq("order_id", order.id).order("submitted_at", { ascending: false }),
      supabase.from("voice_notes").select("*").eq("order_id", order.id).order("created_at", { ascending: false }),
      supabase.from("call_bookings").select("*").eq("order_id", order.id).order("created_at", { ascending: false }),
      supabase.from("deliverables").select("*").eq("order_id", order.id).order("uploaded_at", { ascending: false }),
      supabase.from("revisions").select("*").eq("order_id", order.id).order("created_at", { ascending: false }),
      supabase.from("order_addons").select("*").eq("order_id", order.id).order("created_at", { ascending: false }),
    ])

    if (redirect) {
      const target = `${PORTAL_BASE_URL}/story?order=${encodeURIComponent(order.razorpay_order_id)}`
      return res.redirect(302, target)
    }

    return res.json({
      success: true,
      order: {
        ...order,
        story_intake: storyIntakeRes.data?.[0] || null,
        story_intakes: storyIntakeRes.data || [],
        voice_notes: voiceNotesRes.data || [],
        call_bookings: callBookingsRes.data || [],
        deliverables: deliverablesRes.data || [],
        revisions: revisionsRes.data || [],
        addons: addonsRes.data || [],
        limits: {
          included_voice_seconds: getIncludedVoiceSeconds(order.edition),
          review_timeline: getReviewTimeline(order.edition),
        },
      },
    })
  } catch (e) {
    console.error("❌ /portal-order error:", safeErr(e))
    return res.status(500).json({ error: "Server error" })
  }
})

/* =========================
   STORY PORTAL API
========================= */
app.post("/story/create-addon-order", async (req, res) => {
  try {
    const { orderId, addonType, quantity = 1, customAmount, description, metadata } = req.body

    const order = await getOrderByIdOrRazorpay(orderId)
    if (!order) return res.status(404).json({ error: "Order not found" })

    if (addonType === "extra_hardcover_copy" && order.edition === "Confession Edition") {
      return res.status(400).json({ error: "Hardcover extra copy is not available for Confession Edition" })
    }

    const amount = getAddonAmount({ addonType, quantity, customAmount })
    const receipt = `ssl_addon_${Date.now()}`

    const razorpayOrder = await razorpay.orders.create({
      amount: amount * 100,
      currency: "INR",
      receipt,
      notes: {
        flow: "story_addon",
        orderId: order.id,
        razorpayOrderId: order.razorpay_order_id,
        addonType,
        quantity: String(quantity || 1),
        amount: String(amount),
        customerEmail: order.email,
      },
    })

    const { data: addon, error: addonErr } = await supabase
      .from("order_addons")
      .insert({
        order_id: order.id,
        addon_type: addonType,
        description: description || null,
        quantity: Number(quantity || 1),
        amount,
        status: "payment_created",
        razorpay_order_id: razorpayOrder.id,
        metadata: metadata || {},
      })
      .select("*")
      .single()

    if (addonErr) {
      console.error("❌ Add-on insert failed:", addonErr)
      return res.status(500).json({ error: "Could not create add-on record" })
    }

    return res.json({
      success: true,
      keyId: getRazorpayPublicKey(),
      razorpayKeyId: getRazorpayPublicKey(),
      razorpayOrderId: razorpayOrder.id,
      amount: razorpayOrder.amount,
      currency: razorpayOrder.currency,
      amountRupees: amount,
      addon,
    })
  } catch (err) {
    console.error("❌ /story/create-addon-order error:", safeErr(err))
    return res.status(400).json({ error: err?.message || "Could not create add-on payment" })
  }
})

app.post("/story/confirm-addon-payment", async (req, res) => {
  try {
    const { razorpay_payment_id, razorpay_order_id, razorpay_signature } = req.body

    if (!razorpay_payment_id || !razorpay_order_id || !razorpay_signature) {
      return res.status(400).json({ error: "Missing payment verification data" })
    }

    const expectedSignature = crypto
      .createHmac("sha256", RAZORPAY_KEY_SECRET)
      .update(razorpay_order_id + "|" + razorpay_payment_id)
      .digest("hex")

    if (expectedSignature !== razorpay_signature) {
      return res.status(400).json({ error: "Invalid payment signature" })
    }

    const { data: addon, error: addonErr } = await supabase
      .from("order_addons")
      .update({
        status: "paid",
        razorpay_payment_id,
        paid_at: new Date().toISOString(),
      })
      .eq("razorpay_order_id", razorpay_order_id)
      .select("*")
      .single()

    if (addonErr || !addon) {
      console.error("❌ Add-on payment update failed:", addonErr)
      return res.status(404).json({ error: "Add-on payment record not found" })
    }

    if (addon.addon_type === "custom_cover") {
      await supabase.from("orders").update({ custom_cover_paid: true }).eq("id", addon.order_id)
    }

    if (addon.addon_type === "voice_note_hour") {
      await supabase
        .from("orders")
        .update({ voice_note_addon_paid: true })
        .eq("id", addon.order_id)
    }

    if (addon.addon_type === "balance_payment") {
      await supabase
        .from("orders")
        .update({ balance_due: 0, balance_paid_at: new Date().toISOString() })
        .eq("id", addon.order_id)
    }

    await refreshOrderTotals(addon.order_id)

    const { data: order } = await supabase
      .from("orders")
      .select("*")
      .eq("id", addon.order_id)
      .single()

    await sendEmailSafe({
      to: ADMIN_EMAIL,
      subject: `💳 Add-on paid – ${addon.addon_type}`,
      html: `
        <h2>Add-on payment received</h2>
        <p><strong>Order:</strong> ${escapeHtml(order?.razorpay_order_id || addon.order_id)}</p>
        <p><strong>Customer:</strong> ${escapeHtml(order?.name || "")}</p>
        <p><strong>Email:</strong> ${escapeHtml(order?.email || "")}</p>
        <p><strong>Add-on:</strong> ${escapeHtml(addon.addon_type)}</p>
        <p><strong>Amount:</strong> ₹${addon.amount}</p>
      `,
    })

    return res.json({ success: true, addon })
  } catch (err) {
    console.error("❌ /story/confirm-addon-payment error:", safeErr(err))
    return res.status(500).json({ error: "Add-on payment confirmation failed" })
  }
})

app.post("/story/save-draft", async (req, res) => {
  try {
    const { orderId, story } = req.body
    const order = await getOrderByIdOrRazorpay(orderId)
    if (!order) return res.status(404).json({ error: "Order not found" })
    if (order.story_submitted) return res.json({ success: true, locked: true })

    const cleanStory = normalizeText(story, 50000)

    const { error } = await supabase
      .from("orders")
      .update({ story: cleanStory })
      .eq("id", order.id)

    if (error) return res.status(500).json({ error: "Failed to save draft" })

    return res.json({ success: true })
  } catch (err) {
    console.error("❌ /story/save-draft error:", safeErr(err))
    return res.status(500).json({ error: "Draft save failed" })
  }
})

app.post("/story/register-voice-note", async (req, res) => {
  try {
    const { orderId, filePath, fileName, durationSeconds = 0, paidByAddon = false } = req.body
    const order = await getOrderByIdOrRazorpay(orderId)
    if (!order) return res.status(404).json({ error: "Order not found" })
    if (!filePath) return res.status(400).json({ error: "filePath required" })

    const duration = Number(durationSeconds || 0)

    const { data: existingVoiceNotes } = await supabase
      .from("voice_notes")
      .select("duration_seconds")
      .eq("order_id", order.id)

    const usedSeconds = (existingVoiceNotes || []).reduce((sum, row) => sum + Number(row.duration_seconds || 0), 0)
    const includedSeconds = getIncludedVoiceSeconds(order.edition)

    const { data: paidVoiceAddons } = await supabase
      .from("order_addons")
      .select("quantity")
      .eq("order_id", order.id)
      .eq("addon_type", "voice_note_hour")
      .eq("status", "paid")

    const paidSeconds = (paidVoiceAddons || []).reduce((sum, item) => sum + Number(item.quantity || 1) * 3600, 0)
    const allowedSeconds = includedSeconds + paidSeconds

    if (duration > 0 && usedSeconds + duration > allowedSeconds && !paidByAddon) {
      return res.status(402).json({
        error: "Voice note limit exceeded. Please purchase extra voice note time.",
        usedSeconds,
        allowedSeconds,
      })
    }

    const { data, error } = await supabase
      .from("voice_notes")
      .insert({
        order_id: order.id,
        file_path: filePath,
        file_name: fileName || null,
        duration_seconds: Number.isFinite(duration) ? duration : null,
        paid_by_addon: !!paidByAddon,
      })
      .select("*")
      .single()

    if (error) {
      console.error("❌ Voice note register failed:", error)
      return res.status(500).json({ error: "Could not register voice note" })
    }

    return res.json({ success: true, voice_note: data, usedSeconds: usedSeconds + duration, allowedSeconds })
  } catch (err) {
    console.error("❌ /story/register-voice-note error:", safeErr(err))
    return res.status(500).json({ error: "Voice note registration failed" })
  }
})

app.post("/story/submit-intake", async (req, res) => {
  try {
    const {
      orderId,
      textStory,
      wordCount,
      tone,
      noteToWriter,
      coverType,
      coverNotes,
      coverTitle,
      authorName,
      coverPhotoPath,
      referenceImagePaths = [],
      essenceInputChoice,
      callBooking,
    } = req.body

    const order = await getOrderByIdOrRazorpay(orderId)
    if (!order) return res.status(404).json({ error: "Order not found" })
    if (order.story_submitted) return res.json({ success: true, story_submitted: true })

    const cleanStory = normalizeText(textStory || order.story, 80000)
    if (!cleanStory) return res.status(400).json({ error: "Story text is required" })

    const cleanCoverNotes = normalizeText(coverNotes, 3500)
    const cleanNoteToWriter = normalizeText(noteToWriter, 3500)

    const { data: intake, error: intakeErr } = await supabase
      .from("story_intakes")
      .insert({
        order_id: order.id,
        text_story: cleanStory,
        word_count: Number(wordCount || cleanStory.split(/\s+/).filter(Boolean).length),
        tone: tone || null,
        note_to_writer: cleanNoteToWriter || null,
        cover_type: coverType || null,
        cover_notes: cleanCoverNotes || null,
        cover_title: coverTitle || null,
        author_name: authorName || null,
        photo_path: coverPhotoPath || null,
        reference_image_paths: referenceImagePaths || [],
        essence_input_choice: essenceInputChoice || null,
        submitted_at: new Date().toISOString(),
      })
      .select("*")
      .single()

    if (intakeErr) {
      console.error("❌ Story intake insert failed:", intakeErr)
      return res.status(500).json({ error: "Failed to submit story intake" })
    }

    if (order.edition === "Essence Edition" && essenceInputChoice === "call" && callBooking) {
      await supabase.from("call_bookings").insert({
        order_id: order.id,
        preferred_date: callBooking.preferredDate || null,
        preferred_time: callBooking.preferredTime || null,
        listener_pref: callBooking.listenerPref || null,
        call_type: callBooking.callType || "Google Meet / Voice Call",
        duration_hours: 1,
        amount: 0,
        paid: true,
        status: "requested",
      })
    }

    const { error: orderUpdateErr } = await supabase
      .from("orders")
      .update({
        story: cleanStory,
        story_submitted: true,
        story_submitted_at: new Date().toISOString(),
        production_status: "story_submitted",
      })
      .eq("id", order.id)

    if (orderUpdateErr) {
      console.error("❌ Order story submit update failed:", orderUpdateErr)
      return res.status(500).json({ error: "Story saved but order status failed" })
    }

    const timeline = getReviewTimeline(order.edition)

    await sendEmailSafe({
      to: ADMIN_EMAIL,
      subject: `📖 Story Submitted – ${order.edition}`,
      html: `
        <h2>New Story Submitted</h2>
        <p><strong>Edition:</strong> ${escapeHtml(order.edition)}</p>
        <p><strong>Order:</strong> ${escapeHtml(order.razorpay_order_id)}</p>
        <p><strong>Name:</strong> ${escapeHtml(order.name)}</p>
        <p><strong>Email:</strong> ${escapeHtml(order.email)}</p>
        <p><strong>Phone:</strong> ${escapeHtml(order.phone)}</p>
        <hr />
        <p><strong>Cover Type:</strong> ${escapeHtml(coverType || "")}</p>
        <p><strong>Title:</strong> ${escapeHtml(coverTitle || "")}</p>
        <p><strong>Author:</strong> ${escapeHtml(authorName || "")}</p>
        <p><strong>Note to writer:</strong><br/>${escapeHtml(cleanNoteToWriter)}</p>
        <hr />
        <h3>Story</h3>
        <pre style="white-space: pre-wrap; font-family: serif;">${escapeHtml(cleanStory)}</pre>
      `,
    })

    await sendEmailSafe({
      to: order.email,
      subject: "Your story has been submitted",
      html: `
        <div style="font-family: Arial, sans-serif; line-height:1.7;color:#111;">
          <h2>Your story is with us</h2>
          <p>Dear ${escapeHtml(order.name)},</p>
          <p>Your story submission has been received successfully.</p>
          <p>Your review files will be shared within <strong>${timeline}</strong>.</p>
          <p>Because this is a custom novel written specifically around your life and details, the writing and review process takes careful time.</p>
          <p>Best regards,<br/>SoulScript Legacy</p>
        </div>
      `,
    })

    return res.json({ success: true, story_submitted: true, intake, timeline })
  } catch (err) {
    console.error("❌ /story/submit-intake error:", safeErr(err))
    return res.status(500).json({ error: "Story submission failed" })
  }
})

/* Legacy submit story kept */
app.post("/submit-story", async (req, res) => {
  const { orderId, story } = req.body

  if (!orderId || !story || !story.trim()) {
    return res.status(400).json({ error: "Order ID or story missing" })
  }

  try {
    const { data: order, error } = await supabase
      .from("orders")
      .select("*")
      .eq("razorpay_order_id", orderId)
      .single()

    if (error || !order) {
      console.error("❌ Order not found:", error)
      return res.status(404).json({ error: "Order not found" })
    }

    if (order.story_submitted) {
      return res.json({ success: true, story_submitted: true })
    }

    const { error: updateError } = await supabase
      .from("orders")
      .update({ story, story_submitted: true, story_submitted_at: new Date().toISOString() })
      .eq("id", order.id)

    if (updateError) {
      console.error("❌ Story update failed:", updateError)
      return res.status(500).json({ error: "Failed to save story" })
    }

    await sendEmailSafe({
      to: ADMIN_EMAIL,
      subject: `📖 Story Submitted – ${order.edition}`,
      html: `
        <h2>New Story Submitted</h2>
        <p><strong>Edition:</strong> ${escapeHtml(order.edition)}</p>
        <p><strong>Name:</strong> ${escapeHtml(order.name)}</p>
        <p><strong>Email:</strong> ${escapeHtml(order.email)}</p>
        <p><strong>Phone:</strong> ${escapeHtml(order.phone)}</p>
        <hr />
        <h3>Story</h3>
        <pre style="white-space: pre-wrap; font-family: serif;">${escapeHtml(story)}</pre>
      `,
    })

    return res.json({ success: true, story_submitted: true })
  } catch (err) {
    console.error("❌ Submit story error:", safeErr(err))
    return res.status(500).json({ error: "Submit story error" })
  }
})

app.post("/story/request-revision", async (req, res) => {
  try {
    const { orderId, type, description } = req.body
    const order = await getOrderByIdOrRazorpay(orderId)
    if (!order) return res.status(404).json({ error: "Order not found" })

    const revisionType = ["cover", "manuscript", "both"].includes(type) ? type : "both"
    const cleanDescription = normalizeText(description, 6000)
    if (!cleanDescription) return res.status(400).json({ error: "Revision description required" })

    const { data, error } = await supabase
      .from("revisions")
      .insert({
        order_id: order.id,
        type: revisionType,
        description: cleanDescription,
        is_free: null,
        charge: null,
        paid: false,
        status: "requested",
      })
      .select("*")
      .single()

    if (error) {
      console.error("❌ Revision insert failed:", error)
      return res.status(500).json({ error: "Could not request changes" })
    }

    await sendEmailSafe({
      to: ADMIN_EMAIL,
      subject: `📝 Revision requested – ${order.edition}`,
      html: `
        <h2>Revision requested</h2>
        <p><strong>Order:</strong> ${escapeHtml(order.razorpay_order_id)}</p>
        <p><strong>Customer:</strong> ${escapeHtml(order.name)}</p>
        <p><strong>Type:</strong> ${escapeHtml(revisionType)}</p>
        <p><strong>Description:</strong><br/>${escapeHtml(cleanDescription)}</p>
      `,
    })

    await sendEmailSafe({
      to: order.email,
      subject: "We received your change request",
      html: `
        <div style="font-family: Arial, sans-serif; line-height:1.7;color:#111;">
          <h2>Change request received</h2>
          <p>Dear ${escapeHtml(order.name)},</p>
          <p>We have received your requested changes for your novel.</p>
          <p>If the correction falls within the original brief or is a mistake from our side, it will be corrected without additional charge. If it introduces new requirements outside the original brief, our team will share the applicable charges before proceeding.</p>
          <p>You will receive an update within approximately 2 working days.</p>
          <p>Best regards,<br/>SoulScript Legacy</p>
        </div>
      `,
    })

    return res.json({ success: true, revision: data })
  } catch (err) {
    console.error("❌ /story/request-revision error:", safeErr(err))
    return res.status(500).json({ error: "Could not request revision" })
  }
})

app.post("/story/proceed-print", async (req, res) => {
  try {
    const { orderId } = req.body
    const order = await getOrderByIdOrRazorpay(orderId)
    if (!order) return res.status(404).json({ error: "Order not found" })

    const { data, error } = await supabase
      .from("deliverables")
      .update({ print_requested_at: new Date().toISOString() })
      .eq("order_id", order.id)
      .select("*")

    if (error) {
      console.error("❌ Print request update failed:", error)
      return res.status(500).json({ error: "Could not send to print" })
    }

    await supabase
      .from("orders")
      .update({ production_status: "print_requested", print_requested_at: new Date().toISOString() })
      .eq("id", order.id)

    await sendEmailSafe({
      to: order.email,
      subject: "Your book has been sent for printing",
      html: `
        <div style="font-family: Arial, sans-serif; line-height:1.7;color:#111;">
          <h2>Sent for printing</h2>
          <p>Dear ${escapeHtml(order.name)},</p>
          <p>Your manuscript and cover have been approved and your book has now been sent for printing.</p>
          <p>Since this is a customized novel written specifically around your life, the final production and quality checks take careful time.</p>
          <p>You can expect delivery within <strong>16 to 21 working days</strong>.</p>
          <p>Best regards,<br/>SoulScript Legacy</p>
        </div>
      `,
    })

    await sendEmailSafe({
      to: ADMIN_EMAIL,
      subject: `🖨️ Print requested – ${order.edition}`,
      html: `<p>Order ${escapeHtml(order.razorpay_order_id)} has been approved for printing.</p>`,
    })

    return res.json({ success: true, deliverables: data || [] })
  } catch (err) {
    console.error("❌ /story/proceed-print error:", safeErr(err))
    return res.status(500).json({ error: "Could not proceed with print" })
  }
})

/* =========================
   SOULSCRIPT LEGACY ADMIN API
========================= */
const adminCrypto = crypto

const ADMIN_ALLOWED_ORIGINS = new Set([
  "https://admin.soulscriptlegacy.com",
  "https://soulscript-admin.vercel.app",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
])

const ADMIN_TOKEN_TTL_SECONDS = 60 * 60 * 12
const ADMIN_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{12}$/i

class AdminInputError extends Error {
  constructor(message) {
    super(message)
    this.status = 400
  }
}

app.use("/admin", (req, res, next) => {
  const origin = req.headers.origin

  if (origin && ADMIN_ALLOWED_ORIGINS.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin)
    res.setHeader("Vary", "Origin")
  }

  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization")
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, OPTIONS")

  if (req.method === "OPTIONS") return res.sendStatus(204)
  return next()
})

function adminJsonError(res, status, message) {
  return res.status(status).json({ success: false, message })
}

function adminAsync(handler) {
  return async (req, res, next) => {
    try {
      await handler(req, res, next)
    } catch (error) {
      if (error instanceof AdminInputError) return adminJsonError(res, error.status, error.message)
      console.error("Admin route error:", error)
      return adminJsonError(res, 500, "Admin request failed.")
    }
  }
}

function adminConfig() {
  const email = process.env.ADMIN_PANEL_EMAIL
  const password = process.env.ADMIN_PANEL_PASSWORD
  const secret = process.env.ADMIN_JWT_SECRET || process.env.ADMIN_SESSION_SECRET

  if (!email || !password || !secret) return null
  return { email, password, secret }
}

function adminSecureEqual(left, right) {
  const leftHash = adminCrypto.createHash("sha256").update(String(left)).digest()
  const rightHash = adminCrypto.createHash("sha256").update(String(right)).digest()
  return adminCrypto.timingSafeEqual(leftHash, rightHash)
}

function adminSignToken(input) {
  const config = adminConfig()
  if (!config) throw new Error("Admin auth environment variables are missing.")

  return adminCrypto.createHmac("sha256", config.secret).update(input).digest("base64url")
}

function adminCreateToken(email) {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url")
  const now = Math.floor(Date.now() / 1000)
  const payload = Buffer.from(JSON.stringify({ sub: "soulscript-admin", email, iat: now, exp: now + ADMIN_TOKEN_TTL_SECONDS })).toString("base64url")
  const signature = adminSignToken(`${header}.${payload}`)
  return `${header}.${payload}.${signature}`
}

function adminVerifyToken(token) {
  if (!token || typeof token !== "string") return null
  const parts = token.split(".")
  if (parts.length !== 3) return null
  const [header, payload, signature] = parts
  const expectedSignature = adminSignToken(`${header}.${payload}`)
  if (!adminSecureEqual(signature, expectedSignature)) return null

  let parsed
  try {
    parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))
  } catch {
    return null
  }

  if (parsed.sub !== "soulscript-admin") return null
  if (!parsed.exp || parsed.exp < Math.floor(Date.now() / 1000)) return null
  return parsed
}

function requireAdmin(req, res, next) {
  const authHeader = req.headers.authorization || ""
  const [scheme, token] = authHeader.split(" ")

  if (scheme !== "Bearer" || !token) return adminJsonError(res, 401, "Admin authentication required.")

  let admin
  try {
    admin = adminVerifyToken(token)
  } catch (error) {
    console.error("Admin token verification failed:", error)
    return adminJsonError(res, 401, "Invalid admin session.")
  }

  if (!admin) return adminJsonError(res, 401, "Invalid admin session.")

  req.admin = admin
  return next()
}

function adminRequireUuid(id, label = "id") {
  if (!id || !ADMIN_UUID_RE.test(String(id))) throw new AdminInputError(`Invalid ${label}.`)
  return String(id)
}

function adminHasOwn(body, key) {
  return Object.prototype.hasOwnProperty.call(body || {}, key)
}

function adminStringOrNull(value, field, maxLength) {
  if (value === undefined) return undefined
  if (value === null) return null
  if (typeof value !== "string") throw new AdminInputError(`${field} must be a string.`)
  const trimmed = value.trim()
  if (trimmed.length > maxLength) throw new AdminInputError(`${field} is too long.`)
  return trimmed || null
}

function adminNumberOrNull(value, field) {
  if (value === undefined) return undefined
  if (value === null || value === "") return null
  const numberValue = typeof value === "number" ? value : Number(value)
  if (!Number.isFinite(numberValue) || numberValue < 0) throw new AdminInputError(`${field} must be a non-negative number.`)
  return numberValue
}

function adminBoolean(value, field) {
  if (value === undefined) return undefined
  if (typeof value === "boolean") return value
  if (value === "true") return true
  if (value === "false") return false
  throw new AdminInputError(`${field} must be a boolean.`)
}

function adminRevisionStatus(value) {
  if (value === undefined) return undefined
  if (typeof value !== "string") throw new AdminInputError("status must be a string.")
  const status = value.trim()
  if (!/^[a-zA-Z0-9 _-]{1,60}$/.test(status)) throw new AdminInputError("status contains invalid characters.")
  return status
}

function adminHandleSupabaseError(res, error, message = "Database request failed.") {
  console.error(message, error)
  return adminJsonError(res, 500, message)
}

const ADMIN_ORDER_LIST_FIELDS = [
  "id",
  "created_at",
  "name",
  "phone",
  "email",
  "edition",
  "payment_type",
  "amount",
  "total_order_value",
  "paid_amount",
  "balance_due",
  "story_submitted",
  "razorpay_order_id",
  "production_status",
].join(",")

const ADMIN_ORDER_DETAIL_FIELDS = [
  "id",
  "razorpay_order_id",
  "razorpay_payment_id",
  "edition",
  "payment_type",
  "amount",
  "total_order_value",
  "paid_amount",
  "balance_due",
  "name",
  "phone",
  "email",
  "address",
  "created_at",
  "story",
  "story_submitted",
  "production_status",
].join(",")

app.post("/admin/login", adminAsync(async (req, res) => {
  const config = adminConfig()
  if (!config) return adminJsonError(res, 500, "Admin auth is not configured.")

  const email = adminStringOrNull(req.body && req.body.email, "email", 320)
  const password = adminStringOrNull(req.body && req.body.password, "password", 1000)

  if (!email || !password) return adminJsonError(res, 400, "Email and password are required.")

  const emailMatches = adminSecureEqual(email.toLowerCase(), config.email.toLowerCase())
  const passwordMatches = adminSecureEqual(password, config.password)

  if (!emailMatches || !passwordMatches) return adminJsonError(res, 401, "Invalid admin credentials.")

  return res.json({ success: true, adminToken: adminCreateToken(config.email) })
}))

app.get("/admin/me", requireAdmin, adminAsync(async (req, res) => {
  return res.json({ success: true, admin: { email: req.admin.email } })
}))

app.get("/admin/dashboard", requireAdmin, adminAsync(async (req, res) => {
  const [ordersResult, revisionsResult, deliverablesResult, addonsResult] = await Promise.all([
    supabase.from("orders").select("amount, paid_amount, story_submitted"),
    supabase.from("revisions").select("status"),
    supabase.from("deliverables").select("delivered_at"),
    supabase.from("order_addons").select("amount, status"),
  ])

  if (ordersResult.error) return adminHandleSupabaseError(res, ordersResult.error, "Unable to load dashboard orders.")
  if (revisionsResult.error) return adminHandleSupabaseError(res, revisionsResult.error, "Unable to load dashboard revisions.")
  if (deliverablesResult.error) return adminHandleSupabaseError(res, deliverablesResult.error, "Unable to load dashboard deliverables.")
  if (addonsResult.error) return adminHandleSupabaseError(res, addonsResult.error, "Unable to load dashboard add-ons.")

  const orders = ordersResult.data || []
  const revisions = revisionsResult.data || []
  const deliverables = deliverablesResult.data || []
  const addons = addonsResult.data || []
  const closedRevisionStatuses = new Set(["complete", "completed", "done", "resolved", "cancelled", "canceled"])

  const orderRevenue = orders.reduce((sum, order) => {
    const amount = Number(order.amount || 0)
    return Number.isFinite(amount) ? sum + amount : sum
  }, 0)

  const addonRevenue = addons.filter((a) => a.status === "paid").reduce((sum, addon) => {
    const amount = Number(addon.amount || 0)
    return Number.isFinite(amount) ? sum + amount : sum
  }, 0)

  return res.json({
    success: true,
    dashboard: {
      total_orders: orders.length,
      pending_story_submissions: orders.filter((order) => !order.story_submitted).length,
      submitted_stories: orders.filter((order) => order.story_submitted).length,
      pending_revisions: revisions.filter((revision) => {
        const status = String(revision.status || "pending").toLowerCase()
        return !closedRevisionStatuses.has(status)
      }).length,
      pending_deliverables: deliverables.filter((deliverable) => !deliverable.delivered_at).length,
      total_revenue_collected: orderRevenue + addonRevenue,
      addon_revenue_collected: addonRevenue,
    },
  })
}))

app.get("/admin/orders", requireAdmin, adminAsync(async (req, res) => {
  const { data, error } = await supabase.from("orders").select(ADMIN_ORDER_LIST_FIELDS).order("created_at", { ascending: false })
  if (error) return adminHandleSupabaseError(res, error, "Unable to load orders.")
  return res.json({ success: true, orders: data || [] })
}))

app.get("/admin/orders/:id", requireAdmin, adminAsync(async (req, res) => {
  const id = adminRequireUuid(req.params.id, "order id")

  const orderResult = await supabase.from("orders").select(ADMIN_ORDER_DETAIL_FIELDS).eq("id", id).single()
  if (orderResult.error) {
    if (orderResult.error.code === "PGRST116") return adminJsonError(res, 404, "Order not found.")
    return adminHandleSupabaseError(res, orderResult.error, "Unable to load order.")
  }

  const [storyIntakesResult, voiceNotesResult, callBookingsResult, deliverablesResult, revisionsResult, addonsResult] = await Promise.all([
    supabase.from("story_intakes").select("*").eq("order_id", id).order("submitted_at", { ascending: false }),
    supabase.from("voice_notes").select("*").eq("order_id", id).order("created_at", { ascending: false }),
    supabase.from("call_bookings").select("*").eq("order_id", id).order("created_at", { ascending: false }),
    supabase.from("deliverables").select("*").eq("order_id", id).order("uploaded_at", { ascending: false }),
    supabase.from("revisions").select("*").eq("order_id", id).order("created_at", { ascending: false }),
    supabase.from("order_addons").select("*").eq("order_id", id).order("created_at", { ascending: false }),
  ])

  const relatedResults = [storyIntakesResult, voiceNotesResult, callBookingsResult, deliverablesResult, revisionsResult, addonsResult]
  const relatedError = relatedResults.find((result) => result.error)
  if (relatedError) return adminHandleSupabaseError(res, relatedError.error, "Unable to load related order data.")

  const storyIntakes = storyIntakesResult.data || []
  return res.json({
    success: true,
    order: {
      ...orderResult.data,
      story_intake: storyIntakes[0] || null,
      story_intakes: storyIntakes,
      voice_notes: voiceNotesResult.data || [],
      call_bookings: callBookingsResult.data || [],
      deliverables: deliverablesResult.data || [],
      revisions: revisionsResult.data || [],
      addons: addonsResult.data || [],
    },
  })
}))

app.patch("/admin/orders/:id", requireAdmin, adminAsync(async (req, res) => {
  const id = adminRequireUuid(req.params.id, "order id")
  const updates = {}

  if (adminHasOwn(req.body, "name")) updates.name = adminStringOrNull(req.body.name, "name", 180)
  if (adminHasOwn(req.body, "phone")) updates.phone = adminStringOrNull(req.body.phone, "phone", 40)
  if (adminHasOwn(req.body, "address")) updates.address = adminStringOrNull(req.body.address, "address", 2000)
  if (adminHasOwn(req.body, "edition")) updates.edition = adminStringOrNull(req.body.edition, "edition", 120)
  if (adminHasOwn(req.body, "payment_type")) updates.payment_type = adminStringOrNull(req.body.payment_type, "payment_type", 80)
  if (adminHasOwn(req.body, "amount")) updates.amount = adminNumberOrNull(req.body.amount, "amount")
  if (adminHasOwn(req.body, "story_submitted")) updates.story_submitted = adminBoolean(req.body.story_submitted, "story_submitted")
  if (adminHasOwn(req.body, "production_status")) updates.production_status = adminStringOrNull(req.body.production_status, "production_status", 80)

  if (Object.keys(updates).length === 0) return adminJsonError(res, 400, "No allowed order fields provided.")

  const { data, error } = await supabase.from("orders").update(updates).eq("id", id).select(ADMIN_ORDER_DETAIL_FIELDS).single()
  if (error) {
    if (error.code === "PGRST116") return adminJsonError(res, 404, "Order not found.")
    return adminHandleSupabaseError(res, error, "Unable to update order.")
  }

  return res.json({ success: true, order: data })
}))

app.get("/admin/story-intakes", requireAdmin, adminAsync(async (req, res) => {
  const { data, error } = await supabase.from("story_intakes").select("*").order("submitted_at", { ascending: false })
  if (error) return adminHandleSupabaseError(res, error, "Unable to load story intakes.")
  return res.json({ success: true, story_intakes: data || [] })
}))

app.get("/admin/voice-notes", requireAdmin, adminAsync(async (req, res) => {
  const { data, error } = await supabase.from("voice_notes").select("*").order("created_at", { ascending: false })
  if (error) return adminHandleSupabaseError(res, error, "Unable to load voice notes.")
  return res.json({ success: true, voice_notes: data || [] })
}))

app.get("/admin/call-bookings", requireAdmin, adminAsync(async (req, res) => {
  const { data, error } = await supabase.from("call_bookings").select("*").order("created_at", { ascending: false })
  if (error) return adminHandleSupabaseError(res, error, "Unable to load call bookings.")
  return res.json({ success: true, call_bookings: data || [] })
}))

app.get("/admin/deliverables", requireAdmin, adminAsync(async (req, res) => {
  const { data, error } = await supabase.from("deliverables").select("*").order("uploaded_at", { ascending: false })
  if (error) return adminHandleSupabaseError(res, error, "Unable to load deliverables.")
  return res.json({ success: true, deliverables: data || [] })
}))

app.get("/admin/revisions", requireAdmin, adminAsync(async (req, res) => {
  const { data, error } = await supabase.from("revisions").select("*").order("created_at", { ascending: false })
  if (error) return adminHandleSupabaseError(res, error, "Unable to load revisions.")
  return res.json({ success: true, revisions: data || [] })
}))

app.get("/admin/addons", requireAdmin, adminAsync(async (req, res) => {
  const { data, error } = await supabase.from("order_addons").select("*").order("created_at", { ascending: false })
  if (error) return adminHandleSupabaseError(res, error, "Unable to load add-ons.")
  return res.json({ success: true, addons: data || [] })
}))

app.patch("/admin/revisions/:id", requireAdmin, adminAsync(async (req, res) => {
  const id = adminRequireUuid(req.params.id, "revision id")
  const updates = {}

  if (adminHasOwn(req.body, "status")) updates.status = adminRevisionStatus(req.body.status)
  if (adminHasOwn(req.body, "paid")) updates.paid = adminBoolean(req.body.paid, "paid")
  if (adminHasOwn(req.body, "is_free")) updates.is_free = adminBoolean(req.body.is_free, "is_free")
  if (adminHasOwn(req.body, "charge")) updates.charge = adminNumberOrNull(req.body.charge, "charge")
  if (adminHasOwn(req.body, "razorpay_order_id")) updates.razorpay_order_id = adminStringOrNull(req.body.razorpay_order_id, "razorpay_order_id", 120)

  if (Object.keys(updates).length === 0) return adminJsonError(res, 400, "No allowed revision fields provided.")

  const { data, error } = await supabase.from("revisions").update(updates).eq("id", id).select("*").single()
  if (error) {
    if (error.code === "PGRST116") return adminJsonError(res, 404, "Revision not found.")
    return adminHandleSupabaseError(res, error, "Unable to update revision.")
  }

  return res.json({ success: true, revision: data })
}))

app.post("/admin/deliverables", requireAdmin, adminAsync(async (req, res) => {
  const orderId = adminRequireUuid(req.body.order_id, "order_id")
  const pdfPath = adminStringOrNull(req.body.pdf_path, "pdf_path", 1200)
  const coverPath = adminStringOrNull(req.body.cover_path, "cover_path", 1200)

  if (!pdfPath && !coverPath) return adminJsonError(res, 400, "PDF path or cover path is required.")

  const { data, error } = await supabase
    .from("deliverables")
    .insert({ order_id: orderId, pdf_path: pdfPath, cover_path: coverPath, uploaded_at: new Date().toISOString() })
    .select("*")
    .single()

  if (error) return adminHandleSupabaseError(res, error, "Unable to create deliverable.")

  await supabase.from("orders").update({ production_status: "review_ready" }).eq("id", orderId)

  const { data: order } = await supabase.from("orders").select("*").eq("id", orderId).single()

  if (order?.email) {
    await sendEmailSafe({
      to: order.email,
      subject: "Your review files are ready",
      html: `
        <div style="font-family: Arial, sans-serif; line-height:1.7;color:#111;">
          <h2>Your review files are ready</h2>
          <p>Dear ${escapeHtml(order.name)},</p>
          <p>Your manuscript and cover review files are now available in your story portal.</p>
          <p>Please review them carefully. You can approve them for printing or request changes from the portal.</p>
          <p><a href="${PORTAL_BASE_URL}/story?order=${encodeURIComponent(order.razorpay_order_id)}" style="display:inline-block;background:#0E0E0E;color:#fff;padding:12px 16px;text-decoration:none;">Open Review Portal</a></p>
          <p>Best regards,<br/>SoulScript Legacy</p>
        </div>
      `,
    })
  }

  return res.json({ success: true, deliverable: data })
}))

/* =========================
   START SERVER
========================= */
const PORT = process.env.PORT || 3000

app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`)
  console.log(`✅ PORTAL_BASE_URL = ${PORTAL_BASE_URL}`)
  console.log(`✅ EMAIL_FROM      = ${EMAIL_FROM}`)
  console.log(`✅ ADMIN_EMAIL     = ${ADMIN_EMAIL}`)
  console.log(`✅ ACCOUNT LOGIN   = Email OTP`)
  console.log(`✅ ADMIN API       = Enabled`)
  console.log(`✅ STORY API       = Enabled`)
})
