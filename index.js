// index.js (SoulScript Legacy backend)
// Checkout upgraded:
// - Backend calculates prices safely
// - Breeze Edition kept at ₹2 for testing
// - Razorpay signature verification fixed
// - Account login upgraded from magic link to email OTP
// - Existing routes preserved: dispatch hook, email debug, portal link, portal order, submit story

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
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
)

app.use(express.json({ limit: "2mb" }))

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

    const { error: dbError } = await supabase.from("orders").insert([
      {
        razorpay_order_id,
        razorpay_payment_id,
        edition,
        payment_type: normalizedPaymentType,
        amount: amountToPay,
        name: customer.name,
        email: normalizedEmail,
        phone: customer.phone,
        address: customer.address,
      },
    ])

    if (dbError) {
      console.error("⚠️ Supabase insert failed:", dbError)
      return res.status(500).json({
        error: "Payment verified but failed to save order",
        details: dbError,
      })
    }

    console.log("✅ Order saved to Supabase:", razorpay_order_id)

    try {
      await resend.emails.send({
        from: EMAIL_FROM,
        to: [ADMIN_EMAIL],
        subject: `🖤 New Order Confirmed – ${edition}`,
        html: `
          <h2>New Order Confirmed</h2>
          <p><strong>Edition:</strong> ${edition}</p>
          <p><strong>Payment Type:</strong> ${
            normalizedPaymentType === "PREPAID" ? "Paid in full" : "50% Advance"
          }</p>
          <p><strong>Amount Paid:</strong> ₹${amountToPay}</p>
          <p><strong>Total Order Value:</strong> ₹${totalOrderValue}</p>
          <p><strong>Pending Amount:</strong> ₹${pendingAmount}</p>
          <p><strong>Ultra Priority:</strong> ${ultraPriority ? "Yes" : "No"}</p>
          <p><strong>Razorpay Payment ID:</strong> ${razorpay_payment_id}</p>
          <p><strong>Razorpay Order ID:</strong> ${razorpay_order_id}</p>
          <hr />
          <p><strong>Name:</strong> ${customer.name}</p>
          <p><strong>Phone:</strong> ${customer.phone}</p>
          <p><strong>Email:</strong> ${normalizedEmail}</p>
          <p><strong>Address:</strong><br/>${customer.address}</p>
        `,
      })

      console.log("📨 Admin order email sent")
    } catch (emailErr) {
      console.error("❌ Admin order email failed:", safeErr(emailErr))
    }

    return res.json({
      success: true,
      nextUrl: `/story?order=${razorpay_order_id}`,
      razorpayOrderId: razorpay_order_id,
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
    .select("id")
    .eq("email", cleanEmail)
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
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <meta name="color-scheme" content="light only" />
        <meta name="supported-color-schemes" content="light only" />
        <title>SoulScript Legacy Login Code</title>
      </head>

      <body style="margin:0;padding:0;background:#f3f3f3;font-family:Arial, Helvetica, sans-serif;color:#111111;">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#f3f3f3;margin:0;padding:0;">
          <tr>
            <td align="center" style="padding:42px 16px;">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:600px;background:#ffffff;margin:0 auto;color:#111111;">
                <tr>
                  <td align="center" style="padding:46px 38px 52px;background:#ffffff;color:#111111;">
                    <div style="font-family:Georgia, 'Cormorant Garamond', 'Times New Roman', serif;font-size:20px;font-weight:500;letter-spacing:5px;color:#0E0E0E;line-height:1;text-transform:uppercase;">
                      SOULSCRIPT
                    </div>

                    <div style="font-family:Arial, 'Jost', Helvetica, sans-serif;font-size:8.5px;font-weight:300;letter-spacing:5.5px;color:rgba(14,14,14,0.65);line-height:1;text-transform:uppercase;margin-top:7px;">
                      LEGACY
                    </div>

                    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                      <tr>
                        <td style="padding-top:72px;text-align:left;background:#ffffff;color:#111111;">
                          <div style="font-size:18px;line-height:1.4;font-weight:700;color:#111111;margin:0 0 46px;">
                            Profile code
                          </div>

                          <div style="font-size:16px;line-height:1.7;color:#111111;margin:0 0 26px;">
                            Dear SoulScript customer,
                          </div>

                          <div style="font-size:16px;line-height:1.7;color:#111111;margin:0 0 12px;">
                            Below you can find the verification code:
                          </div>

                          <div style="font-size:26px;line-height:1.2;letter-spacing:2px;font-weight:400;color:#000000;margin:0 0 18px;">
                            ${otp}
                          </div>

                          <div style="font-size:16px;line-height:1.7;color:#111111;margin:0 0 66px;">
                            This code will expire in ${OTP_EXPIRY_MINUTES} minutes.
                          </div>

                          <div style="font-size:16px;line-height:1.35;color:#111111;margin:0 0 82px;">
                            Best regards,<br />
                            SoulScript Legacy
                          </div>

                          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:0 0 58px;">
                            <tr>
                              <td align="left" style="width:50%;padding:0;">
                                <a href="https://instagram.com/thesoulscriptlegacy" target="_blank" style="display:inline-block;text-decoration:none;color:#111111;font-size:13px;line-height:1;font-weight:700;margin-right:28px;">
                                  Instagram
                                </a>
                              </td>

                              <td align="left" style="width:50%;padding:0;">
                                <a href="https://wa.me/918349614723" target="_blank" style="display:inline-block;text-decoration:none;color:#111111;font-size:13px;line-height:1;font-weight:700;">
                                  WhatsApp Support
                                </a>
                              </td>
                            </tr>
                          </table>

                          <div style="font-size:13px;line-height:1.6;color:#8a8a8a;margin:0;">
                            <a href="${PORTAL_BASE_URL}/privacy" target="_blank" style="color:#8a8a8a;text-decoration:underline;">
                              PRIVACY POLICY
                            </a>
                            <span style="color:#8a8a8a;"> · </span>
                            <a href="${PORTAL_BASE_URL}/terms" target="_blank" style="color:#8a8a8a;text-decoration:underline;">
                              Terms and Conditions
                            </a>
                          </div>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
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

// Backward compatible alias.
// Your old Account page can call this and still receive OTP instead of magic link.
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

// Old magic-link verify endpoint kept only so old links do not crash the backend.
// Frontend should stop using this.
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

    return res.json({
      success: true,
      email: customer.email,
    })
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
        "id, razorpay_order_id, edition, payment_type, amount, name, phone, email, address, created_at, story_submitted"
      )
      .eq("email", customer.email)
      .order("created_at", { ascending: false })

    if (ordersErr) {
      console.error("❌ Failed to fetch account orders:", ordersErr)
      return res.status(500).json({ error: "Failed to fetch orders" })
    }

    return res.json({
      success: true,
      email: customer.email,
      orders: orders || [],
    })
  } catch (err) {
    console.error("❌ /account/orders error:", safeErr(err))
    return res.status(500).json({ error: "Server error" })
  }
})

app.post("/account/logout", async (req, res) => {
  try {
    const authHeader = String(req.header("Authorization") || "")

    if (!authHeader.startsWith("Bearer ")) {
      return res.json({ success: true })
    }

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

    if (!name) {
      return res.status(400).json({ error: "Name is required" })
    }

    if (!phone || phone.length < 8) {
      return res.status(400).json({ error: "Valid phone number is required" })
    }

    if (!address) {
      return res.status(400).json({ error: "Address is required" })
    }

    const { data, error } = await supabase
      .from("orders")
      .update({
        name,
        phone,
        address,
      })
      .eq("email", customer.email)
      .select("id, name, phone, email, address")

    if (error) {
      console.error("❌ Failed to update account profile:", error)
      return res.status(500).json({ error: "Failed to update profile" })
    }

    return res.json({
      success: true,
      updatedOrders: data?.length || 0,
      profile: {
        name,
        phone,
        email: customer.email,
        address,
        location: "India",
      },
    })
  } catch (err) {
    console.error("❌ /account/profile update error:", safeErr(err))
    return res.status(500).json({ error: "Server error" })
  }
})

/* =========================
   CUSTOMER MY ORDERS
   Legacy API kept, but account page should use /account/orders.
========================= */
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
      .update({
        portal_token: token,
        portal_token_expires_at: expiresAt,
        portal_token_used: false,
      })
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
        <p>
          <a href="${portalUrl}" style="display:inline-block;padding:12px 16px;background:#000;color:#fff;text-decoration:none;border-radius:10px;">
            Open My Story Portal
          </a>
        </p>
        <p style="color:#555;font-size:13px;">This link expires in 30 minutes.</p>
        <p>— SoulScript Legacy</p>
      </div>
    `

    try {
      const r = await resend.emails.send({
        from: EMAIL_FROM,
        to: [normalizedEmail],
        subject: "Your SoulScript Legacy writing link",
        html,
      })

      console.log(
        "📨 Portal email sent to customer:",
        normalizedEmail,
        r?.id || r
      )

      return res.json({ success: true, portalUrl })
    } catch (e) {
      const err = safeErr(e)
      console.error("❌ Resend portal email failed (customer):", err)

      try {
        const r2 = await resend.emails.send({
          from: EMAIL_FROM,
          to: [ADMIN_EMAIL],
          subject: "⚠️ Portal link fallback (customer blocked)",
          html: `
            <p><b>Customer email blocked:</b> ${normalizedEmail}</p>
            <p><b>Reason:</b> ${err?.message || "Resend blocked"}</p>
            <hr/>
            ${html}
          `,
        })

        console.log(
          "📨 Portal email fallback sent to admin:",
          ADMIN_EMAIL,
          r2?.id || r2
        )

        return res.json({
          success: true,
          portalUrl,
          warning:
            "Resend blocked sending to customer. Sent fallback to admin email instead.",
          resend_error: err,
        })
      } catch (e2) {
        const err2 = safeErr(e2)
        console.error("❌ Resend portal email failed (admin fallback):", err2)

        return res.status(500).json({
          error: "Email sending failed (Resend).",
          resend_error_customer: err,
          resend_error_admin: err2,
          portalUrl,
        })
      }
    }
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

    if (token) {
      query = query.eq("portal_token", token)
    } else {
      query = query.eq("razorpay_order_id", orderId)
    }

    const { data: order, error } = await query.single()

    if (error || !order) {
      console.error("❌ Order not found:", error)
      return res.status(404).json({ error: "Invalid link or order not found" })
    }

    if (token) {
      if (order.portal_token_used) {
        return res
          .status(410)
          .json({ error: "Link already used. Please request a new link." })
      }

      if (order.portal_token_expires_at) {
        const exp = new Date(order.portal_token_expires_at).getTime()
        if (Date.now() > exp) {
          return res
            .status(410)
            .json({ error: "Link expired. Please request a new link." })
        }
      }

      const { error: usedErr } = await supabase
        .from("orders")
        .update({ portal_token_used: true })
        .eq("id", order.id)

      if (usedErr) console.error("⚠️ Failed to mark token used:", usedErr)
    }

    if (redirect) {
      const target = `${PORTAL_BASE_URL}/story?order=${encodeURIComponent(
        order.razorpay_order_id
      )}`
      return res.redirect(302, target)
    }

    return res.json({ success: true, order })
  } catch (e) {
    console.error("❌ /portal-order error:", safeErr(e))
    return res.status(500).json({ error: "Server error" })
  }
})

/* =========================
   SUBMIT STORY
========================= */
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
      .update({
        story,
        story_submitted: true,
      })
      .eq("id", order.id)

    if (updateError) {
      console.error("❌ Story update failed:", updateError)
      return res.status(500).json({ error: "Failed to save story" })
    }

    try {
      const r = await resend.emails.send({
        from: EMAIL_FROM,
        to: [ADMIN_EMAIL],
        subject: `📖 Story Submitted – ${order.edition}`,
        html: `
          <h2>New Story Submitted</h2>
          <p><strong>Edition:</strong> ${order.edition}</p>
          <p><strong>Payment Type:</strong> ${
            order.payment_type === "PREPAID"
              ? "Paid in full"
              : "50% Advance"
          }</p>
          <hr />
          <p><strong>Name:</strong> ${order.name}</p>
          <p><strong>Email:</strong> ${order.email}</p>
          <p><strong>Phone:</strong> ${order.phone}</p>
          <hr />
          <h3>Story</h3>
          <pre style="white-space: pre-wrap; font-family: serif;">${story}</pre>
        `,
      })

      console.log("📨 Story email sent:", r?.id || r)
    } catch (e) {
      console.error("❌ Resend story email failed:", safeErr(e))
    }

    return res.json({ success: true, story_submitted: true })
  } catch (err) {
    console.error("❌ Submit story error:", safeErr(err))
    return res.status(500).json({ error: "Submit story error" })
  }
})

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
})
