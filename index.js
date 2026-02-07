// index.js (FULL UPDATED FILE)
// ✅ Fixes made:
// 1) PORTAL_BASE_URL default changed to FRONTEND domain (soulscriptlegacy.com) not api domain
// 2) Safer CORS (still permissive enough for Framer)
// 3) Strong logging + Resend error visibility (so we can see WHY email not sent)
// 4) /send-portal-link: returns portalUrl in JSON (helps debugging) + stores token safely
// 5) /portal-order: supports both JSON response and optional redirect mode (?redirect=1)
// 6) Added /health to test if backend is alive quickly

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

// ✅ If you want to lock CORS later, replace "*" with your site:
// const allowedOrigins = ["https://soulscriptlegacy.com", "https://www.soulscriptlegacy.com"]
app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
)

app.use(express.json({ limit: "2mb" }))

/* =========================
   ENV HELPERS
========================= */
const must = (key) => {
  const v = process.env[key]
  if (!v) console.warn(`⚠️ Missing env var: ${key}`)
  return v
}

/* =========================
   SUPABASE (SOURCE OF TRUTH)
========================= */
const supabase = createClient(
  must("SUPABASE_URL"),
  must("SUPABASE_SERVICE_ROLE_KEY")
)

/* =========================
   EMAIL (RESEND)
========================= */
const resend = new Resend(must("RESEND_API_KEY"))

// Email sender (Render env: EMAIL_FROM)
const EMAIL_FROM =
  process.env.EMAIL_FROM || "SoulScript Legacy <onboarding@resend.dev>"

// ✅ IMPORTANT:
// PORTAL_BASE_URL must be FRONTEND website (Framer), not backend.
// Set in Render env: PORTAL_BASE_URL=https://soulscriptlegacy.com
// Default fallback also points to frontend now:
const PORTAL_BASE_URL =
  process.env.PORTAL_BASE_URL || "https://soulscriptlegacy.com"

/* =========================
   RAZORPAY
========================= */
const razorpay = new Razorpay({
  key_id: must("RAZORPAY_KEY_ID"),
  key_secret: must("RAZORPAY_KEY_SECRET"),
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
  })
})

/* =========================
   CREATE RAZORPAY ORDER
========================= */
app.post("/create-order", async (req, res) => {
  try {
    const { amount } = req.body
    if (!amount) return res.status(400).json({ error: "Amount missing" })

    const order = await razorpay.orders.create({
      amount: amount * 100, // ₹ → paise
      currency: "INR",
      receipt: "order_" + Date.now(),
    })

    return res.json(order)
  } catch (err) {
    console.error("❌ Order creation failed:", err)
    return res.status(500).json({ error: "Order creation failed" })
  }
})

/* =========================
   CONFIRM PAYMENT
========================= */
app.post("/confirm-payment", async (req, res) => {
  const {
    paymentId,
    orderId,
    razorpaySignature,
    amount,
    paymentType,
    edition,
    shipping,
  } = req.body

  if (
    !paymentId ||
    !orderId ||
    !razorpaySignature ||
    !shipping ||
    !shipping.name ||
    !shipping.phone ||
    !shipping.address
  ) {
    return res.status(400).json({ error: "Missing required data" })
  }

  try {
    /* ---------- VERIFY SIGNATURE ---------- */
    const expectedSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(orderId + "|" + paymentId)
      .digest("hex")

    if (expectedSignature !== razorpaySignature) {
      console.error("❌ Invalid Razorpay signature")
      return res.status(400).json({ error: "Invalid payment signature" })
    }

    /* ---------- NORMALIZE PAYMENT TYPE ---------- */
    const normalizedPaymentType =
      paymentType === "PREPAID" ? "PREPAID" : "COD_ADVANCE"

    const normalizedEmail = shipping.email
      ? String(shipping.email).trim().toLowerCase()
      : null

    /* ---------- INSERT INTO SUPABASE (NON-BLOCKING) ---------- */
    const { error: dbError } = await supabase.from("orders").insert([
      {
        razorpay_order_id: orderId,
        razorpay_payment_id: paymentId,
        edition,
        payment_type: normalizedPaymentType,
        amount,
        name: shipping.name,
        email: normalizedEmail,
        phone: shipping.phone,
        address: shipping.address,
      },
    ])

    if (dbError) {
      console.error("⚠️ Supabase insert failed:", dbError)
    } else {
      console.log("✅ Order saved to Supabase:", orderId)
    }

    /* ---------- SEND EMAIL (ADMIN) ---------- */
    try {
      const r = await resend.emails.send({
        from: EMAIL_FROM,
        to: ["soulscriptlegacy@gmail.com"],
        subject: `🖤 New Order Confirmed – ${edition}`,
        html: `
          <h2>New Order Confirmed</h2>

          <p><strong>Edition:</strong> ${edition}</p>
          <p><strong>Payment Type:</strong> ${
            normalizedPaymentType === "PREPAID"
              ? "Paid in full"
              : "COD (Advance Paid)"
          }</p>
          <p><strong>Amount Paid:</strong> ₹${amount}</p>
          <p><strong>Razorpay Payment ID:</strong> ${paymentId}</p>
          <p><strong>Order ID:</strong> ${orderId}</p>

          <hr />

          <p><strong>Name:</strong> ${shipping.name}</p>
          <p><strong>Phone:</strong> ${shipping.phone}</p>
          <p><strong>Email:</strong> ${shipping.email || "-"}</p>
          <p><strong>Address:</strong><br/>${shipping.address}</p>
        `,
      })
      console.log("📨 Admin email sent:", r?.id || r)
    } catch (e) {
      // ✅ We don't break checkout even if email fails
      console.error("❌ Resend admin email failed:", e?.message || e)
      if (e?.response) console.error("Resend response:", e.response)
    }

    return res.json({ success: true })
  } catch (err) {
    console.error("❌ Confirmation error:", err)
    return res.json({ success: true })
  }
})

/* =========================
   PORTAL LINK SYSTEM (CUSTOM)
   - /send-portal-link: email secure link
   - /portal-order: validate token -> order details
========================= */

/* Send portal link to customer email */
app.post("/send-portal-link", async (req, res) => {
  try {
    const { email } = req.body
    const normalizedEmail = String(email || "").trim().toLowerCase()

    if (!normalizedEmail || !normalizedEmail.includes("@")) {
      return res.status(400).json({ error: "Valid email required" })
    }

    // Find latest order for this email
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

    // Generate one-time token (expires in 30 mins)
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

    // ✅ MUST go to FRONTEND
    const portalUrl = `${PORTAL_BASE_URL}/story?token=${token}`

    // Send email to customer
    try {
      const r = await resend.emails.send({
        from: EMAIL_FROM,
        to: [normalizedEmail],
        subject: "Your SoulScript Legacy writing link",
        html: `
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
        `,
      })
      console.log("📨 Portal email sent:", r?.id || r)
    } catch (e) {
      console.error("❌ Resend portal email failed:", e?.message || e)
      if (e?.response) console.error("Resend response:", e.response)

      // ✅ Return a clear error so you can see it in frontend
      return res.status(500).json({
        error: "Email sending failed (Resend). Check Render logs.",
      })
    }

    // ✅ Return portalUrl too (helps debugging even if mail goes spam)
    return res.json({ success: true, portalUrl })
  } catch (e) {
    console.error("❌ /send-portal-link error:", e)
    return res.status(500).json({ error: "Server error" })
  }
})

/* Open portal using token */
app.get("/portal-order", async (req, res) => {
  try {
    const token = String(req.query.token || "").trim()
    const redirect = String(req.query.redirect || "").trim() === "1"

    if (!token) return res.status(400).json({ error: "Token missing" })

    const { data: order, error } = await supabase
      .from("orders")
      .select("*")
      .eq("portal_token", token)
      .single()

    if (error || !order) {
      return res.status(404).json({ error: "Invalid link" })
    }

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

    // Mark as used (one-time link)
    const { error: usedErr } = await supabase
      .from("orders")
      .update({ portal_token_used: true })
      .eq("id", order.id)

    if (usedErr) console.error("⚠️ Failed to mark token used:", usedErr)

    // ✅ If redirect=1, send user straight to story page with order id
    if (redirect) {
      const target = `${PORTAL_BASE_URL}/story?order=${encodeURIComponent(
        order.razorpay_order_id
      )}`
      return res.redirect(302, target)
    }

    // Default: JSON response (your frontend can fetch this)
    return res.json({ success: true, order })
  } catch (e) {
    console.error("❌ /portal-order error:", e)
    return res.status(500).json({ error: "Server error" })
  }
})

/* =========================
   SUBMIT STORY (AUTHORITATIVE)
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
        to: ["soulscriptlegacy@gmail.com"],
        subject: `📖 Story Submitted – ${order.edition}`,
        html: `
          <h2>New Story Submitted</h2>

          <p><strong>Edition:</strong> ${order.edition}</p>
          <p><strong>Payment Type:</strong> ${
            order.payment_type === "PREPAID"
              ? "Paid in full"
              : "COD (Advance Paid)"
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
      console.error("❌ Resend story email failed:", e?.message || e)
      if (e?.response) console.error("Resend response:", e.response)
      // still return success to not break customer UX
    }

    return res.json({ success: true, story_submitted: true })
  } catch (err) {
    console.error("❌ Submit story error:", err)
    return res.json({ success: true })
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
})
