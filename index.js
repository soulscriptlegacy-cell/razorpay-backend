// index.js (FULL UPDATED FILE v2)
// ✅ Fixes added in THIS version:
// 1) /send-portal-link returns REAL Resend error message in JSON (no more guessing)
// 2) If Resend blocks customer-send (403), auto-fallback sends to ADMIN (soulscriptlegacy@gmail.com)
//    so you can verify flow while domain is Pending.
// 3) Added /debug/email endpoint to test Resend quickly
// 4) Stronger env validation + safer error serialization

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
  // Normalize random error shapes into something readable
  const obj = {
    message: e?.message || String(e),
    name: e?.name,
    statusCode: e?.statusCode || e?.status,
  }

  // Resend sometimes includes useful fields
  if (e?.response) obj.response = e.response
  if (e?.cause) obj.cause = e.cause
  if (e?.stack) obj.stack = e.stack.split("\n").slice(0, 6).join("\n")
  return obj
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

// Email sender (Render env: EMAIL_FROM)
// IMPORTANT: while domain is Pending, keep this as onboarding@resend.dev
const EMAIL_FROM =
  process.env.EMAIL_FROM || "SoulScript Legacy <onboarding@resend.dev>"

// FRONTEND base URL (Framer)
const PORTAL_BASE_URL =
  process.env.PORTAL_BASE_URL || "https://soulscriptlegacy.com"

// Admin inbox for fallbacks
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "soulscriptlegacy@gmail.com"

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
    adminEmail: ADMIN_EMAIL,
  })
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
    const { amount } = req.body
    if (!amount) return res.status(400).json({ error: "Amount missing" })

    const order = await razorpay.orders.create({
      amount: amount * 100,
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
    const expectedSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(orderId + "|" + paymentId)
      .digest("hex")

    if (expectedSignature !== razorpaySignature) {
      console.error("❌ Invalid Razorpay signature")
      return res.status(400).json({ error: "Invalid payment signature" })
    }

    const normalizedPaymentType =
      paymentType === "PREPAID" ? "PREPAID" : "COD_ADVANCE"

    const normalizedEmail = shipping.email
      ? String(shipping.email).trim().toLowerCase()
      : null

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

    if (dbError) console.error("⚠️ Supabase insert failed:", dbError)
    else console.log("✅ Order saved to Supabase:", orderId)

    // Admin email (don’t break checkout if it fails)
    try {
      const r = await resend.emails.send({
        from: EMAIL_FROM,
        to: [ADMIN_EMAIL],
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
      console.error("❌ Resend admin email failed:", safeErr(e))
    }

    return res.json({ success: true })
  } catch (err) {
    console.error("❌ Confirmation error:", err)
    return res.json({ success: true })
  }
})

/* =========================
   SEND PORTAL LINK
========================= */
app.post("/send-portal-link", async (req, res) => {
  try {
    const { email } = req.body
    const normalizedEmail = String(email || "").trim().toLowerCase()

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

    // 1) Try sending to the customer
    try {
      const r = await resend.emails.send({
        from: EMAIL_FROM,
        to: [normalizedEmail],
        subject: "Your SoulScript Legacy writing link",
        html,
      })
      console.log("📨 Portal email sent to customer:", normalizedEmail, r?.id || r)
      return res.json({ success: true, portalUrl })
    } catch (e) {
      const err = safeErr(e)
      console.error("❌ Resend portal email failed (customer):", err)

      // 2) If Resend blocks (usually 403 during pending domain / test mode),
      // fallback send to ADMIN so flow doesn't block development.
      try {
        const r2 = await resend.emails.send({
          from: EMAIL_FROM,
          to: [ADMIN_EMAIL],
          subject: "⚠️ Portal link fallback (customer blocked)",
          html: `
            <p><b>Customer email (blocked):</b> ${normalizedEmail}</p>
            <p><b>Reason:</b> ${err?.message || "Resend blocked"}</p>
            <hr/>
            ${html}
          `,
        })
        console.log("📨 Portal email fallback sent to admin:", ADMIN_EMAIL, r2?.id || r2)

        return res.json({
          success: true,
          portalUrl,
          warning:
            "Resend blocked sending to customer (domain pending/test mode). Sent fallback to admin email instead.",
          resend_error: err,
        })
      } catch (e2) {
        const err2 = safeErr(e2)
        console.error("❌ Resend portal email failed (admin fallback):", err2)
        return res.status(500).json({
          error: "Email sending failed (Resend).",
          resend_error_customer: err,
          resend_error_admin: err2,
          portalUrl, // still return so you can keep moving
        })
      }
    }
  } catch (e) {
    console.error("❌ /send-portal-link error:", safeErr(e))
    return res.status(500).json({ error: "Server error" })
  }
})

/* =========================
   OPEN PORTAL USING TOKEN
========================= */
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

    const { error: usedErr } = await supabase
      .from("orders")
      .update({ portal_token_used: true })
      .eq("id", order.id)

    if (usedErr) console.error("⚠️ Failed to mark token used:", usedErr)

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

    // Admin email (don’t break customer UX)
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
      console.error("❌ Resend story email failed:", safeErr(e))
    }

    return res.json({ success: true, story_submitted: true })
  } catch (err) {
    console.error("❌ Submit story error:", safeErr(err))
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
  console.log(`✅ ADMIN_EMAIL     = ${ADMIN_EMAIL}`)
})
