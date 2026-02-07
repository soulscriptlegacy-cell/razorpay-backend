const express = require("express")
const Razorpay = require("razorpay")
const crypto = require("crypto")
const cors = require("cors")
const { Resend } = require("resend")
const { createClient } = require("@supabase/supabase-js")

const app = express()
app.use(cors())
app.use(express.json())

/* =========================
   SUPABASE (SOURCE OF TRUTH)
========================= */
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

/* =========================
   EMAIL (RESEND)
========================= */
const resend = new Resend(process.env.RESEND_API_KEY)

// Email sender (set in Render env: EMAIL_FROM)
const EMAIL_FROM =
  process.env.EMAIL_FROM || "SoulScript Legacy <onboarding@resend.dev>"

// Your website base URL (set in Render env: PORTAL_BASE_URL)
const PORTAL_BASE_URL = process.env.PORTAL_BASE_URL || "https://api.soulscriptlegacy.com"

/* =========================
   RAZORPAY
========================= */
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
})

/* =========================
   CREATE RAZORPAY ORDER
========================= */
app.post("/create-order", async (req, res) => {
  try {
    const { amount } = req.body

    if (!amount) {
      return res.status(400).json({ error: "Amount missing" })
    }

    const order = await razorpay.orders.create({
      amount: amount * 100, // ₹ → paise
      currency: "INR",
      receipt: "order_" + Date.now(),
    })

    res.json(order)
  } catch (err) {
    console.error("❌ Order creation failed:", err)
    res.status(500).json({ error: "Order creation failed" })
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

    /* ---------- INSERT INTO SUPABASE (NON-BLOCKING) ---------- */
    const { error: dbError } = await supabase.from("orders").insert([
      {
        razorpay_order_id: orderId,
        razorpay_payment_id: paymentId,
        edition,
        payment_type: normalizedPaymentType,
        amount,
        name: shipping.name,
        email: shipping.email ? String(shipping.email).trim().toLowerCase() : null,
        phone: shipping.phone,
        address: shipping.address,
      },
    ])

    if (dbError) {
      // ⚠️ DO NOT FAIL PAYMENT FLOW
      console.error("⚠️ Supabase insert failed:", dbError)
    } else {
      console.log("✅ Order saved to Supabase")
    }

    /* ---------- SEND EMAIL (ALWAYS) ---------- */
    await resend.emails.send({
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
        <p><strong>Email:</strong> ${shipping.email}</p>
        <p><strong>Address:</strong><br/>${shipping.address}</p>
      `,
    })

    console.log("📨 Email sent successfully")

    /* ---------- ALWAYS RETURN SUCCESS ---------- */
    return res.json({ success: true })
  } catch (err) {
    console.error("❌ Confirmation error:", err)
    // 🔒 Never break frontend after payment
    return res.json({ success: true })
  }
})

/* =========================
   PORTAL LINK SYSTEM (CUSTOM)
   - /send-portal-link: email secure link
   - /portal-order: open portal with token
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

    if (!PORTAL_BASE_URL) {
      return res.status(500).json({ error: "PORTAL_BASE_URL missing" })
    }

    const portalUrl = `${PORTAL_BASE_URL}/story?token=${token}`

    // Send email to customer
    await resend.emails.send({
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

    return res.json({ success: true })
  } catch (e) {
    console.error("❌ /send-portal-link error:", e)
    return res.status(500).json({ error: "Server error" })
  }
})

/* Open portal using token */
app.get("/portal-order", async (req, res) => {
  try {
    const token = String(req.query.token || "").trim()
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

    if (usedErr) {
      console.error("⚠️ Failed to mark token used:", usedErr)
      // still continue
    }

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
    /* ---------- FETCH ORDER ---------- */
    const { data: order, error } = await supabase
      .from("orders")
      .select("*")
      .eq("razorpay_order_id", orderId)
      .single()

    if (error || !order) {
      console.error("❌ Order not found:", error)
      return res.status(404).json({ error: "Order not found" })
    }

    /* ---------- PREVENT DOUBLE SUBMIT ---------- */
    if (order.story_submitted) {
      return res.json({ success: true, story_submitted: true })
    }

    /* ---------- SAVE + LOCK (ONE WRITE) ---------- */
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

    /* ---------- SEND EMAIL ---------- */
    await resend.emails.send({
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
        <pre style="white-space: pre-wrap; font-family: serif;">
${story}
        </pre>
      `,
    })

    console.log("📨 Story submitted email sent")

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
})
