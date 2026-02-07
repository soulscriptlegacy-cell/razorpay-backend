// index.js (FULL UPDATED FILE v3)
// ✅ Adds Admin endpoints so admin.tsx can see orders safely
// IMPORTANT: admin.tsx should call backend endpoints (NOT supabase directly)
// Required Render env vars:
// - SUPABASE_URL
// - SUPABASE_SERVICE_ROLE_KEY
// - RESEND_API_KEY (optional for admin panel, but keep for your current flows)
// - ADMIN_KEY (NEW)  <-- this is admin password
// Optional env vars:
// - EMAIL_FROM, PORTAL_BASE_URL, ADMIN_EMAIL

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
    allowedHeaders: ["Content-Type", "Authorization", "x-admin-key"],
  })
)

app.use(express.json({ limit: "4mb" }))

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

/* =========================
   SUPABASE (SERVICE ROLE)
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
  process.env.EMAIL_FROM || "SoulScript Legacy <onboarding@resend.dev>"
const PORTAL_BASE_URL =
  process.env.PORTAL_BASE_URL || "https://soulscriptlegacy.com"
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "soulscriptlegacy@gmail.com"

/* =========================
   ADMIN AUTH (SIMPLE PASSWORD)
========================= */
const ADMIN_KEY = must("ADMIN_KEY") // SET THIS IN RENDER ENV

const requireAdmin = (req, res, next) => {
  try {
    const key = String(req.headers["x-admin-key"] || "").trim()
    if (!key || key !== ADMIN_KEY) {
      return res.status(401).json({ error: "Unauthorized (admin)" })
    }
    return next()
  } catch (e) {
    return res.status(401).json({ error: "Unauthorized (admin)" })
  }
}

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
    adminAuth: Boolean(ADMIN_KEY),
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
   ADMIN API (NEW)
   admin.tsx will call these endpoints
========================= */

// List orders (supports search + pagination)
app.get("/admin/orders", requireAdmin, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page || "1", 10))
    const limit = Math.min(100, Math.max(5, parseInt(req.query.limit || "25", 10)))
    const offset = (page - 1) * limit

    const q = String(req.query.q || "").trim().toLowerCase()
    const submitted = String(req.query.submitted || "").trim() // "true" | "false" | ""

    // Base query
    let query = supabase
      .from("orders")
      .select(
        "id, created_at, razorpay_order_id, edition, payment_type, amount, name, email, phone, story_submitted, story, address, portal_token_used, portal_token_expires_at",
        { count: "exact" }
      )
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1)

    // Filter by story_submitted
    if (submitted === "true") query = query.eq("story_submitted", true)
    if (submitted === "false") query = query.eq("story_submitted", false)

    // Simple search (email/phone/order id/name)
    if (q) {
      // supabase OR filter needs exact format
      // note: ilike is supported for text columns
      query = query.or(
        `email.ilike.%${q}%,phone.ilike.%${q}%,razorpay_order_id.ilike.%${q}%,name.ilike.%${q}%`
      )
    }

    const { data, error, count } = await query
    if (error) {
      console.error("❌ /admin/orders error:", error)
      return res.status(500).json({ error: "Failed to load orders" })
    }

    return res.json({
      success: true,
      page,
      limit,
      total: count || 0,
      orders: data || [],
    })
  } catch (e) {
    console.error("❌ /admin/orders crash:", safeErr(e))
    return res.status(500).json({ error: "Server error" })
  }
})

// Get single order
app.get("/admin/orders/:id", requireAdmin, async (req, res) => {
  try {
    const id = req.params.id
    const { data, error } = await supabase
      .from("orders")
      .select("*")
      .eq("id", id)
      .single()

    if (error || !data) return res.status(404).json({ error: "Order not found" })
    return res.json({ success: true, order: data })
  } catch (e) {
    console.error("❌ /admin/orders/:id crash:", safeErr(e))
    return res.status(500).json({ error: "Server error" })
  }
})

// Update order fields (admin control)
app.patch("/admin/orders/:id", requireAdmin, async (req, res) => {
  try {
    const id = req.params.id

    // Allow only safe fields to be updated from admin panel
    const allowed = [
      "story_submitted",
      "story",
      "payment_type",
      "edition",
      "amount",
      "name",
      "email",
      "phone",
      "address",

      // If you later add these columns, admin can update:
      "status",
      "admin_notes",
      "cover_preview_path",
      "cover_print_path",
      "manuscript_preview_path",
      "manuscript_print_path",
      "allow_extra_voice_notes",
      "revision_allowed",
      "revision_submitted",
      "terminated",
    ]

    const patch = {}
    for (const k of allowed) {
      if (Object.prototype.hasOwnProperty.call(req.body, k)) patch[k] = req.body[k]
    }

    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ error: "No valid fields in update" })
    }

    const { data, error } = await supabase
      .from("orders")
      .update(patch)
      .eq("id", id)
      .select("*")
      .single()

    if (error || !data) {
      console.error("❌ /admin/orders PATCH error:", error)
      return res.status(500).json({ error: "Failed to update order" })
    }

    return res.json({ success: true, order: data })
  } catch (e) {
    console.error("❌ /admin/orders PATCH crash:", safeErr(e))
    return res.status(500).json({ error: "Server error" })
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
      await resend.emails.send({
        from: EMAIL_FROM,
        to: [ADMIN_EMAIL],
        subject: `🖤 New Order Confirmed – ${edition}`,
        html: `<p>Order created: ${orderId}</p>`,
      })
    } catch (e) {
      console.error("❌ Resend admin email failed:", safeErr(e))
    }

    return res.json({ success: true })
  } catch (err) {
    console.error("❌ Confirmation error:", safeErr(err))
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
  console.log(`✅ ADMIN_KEY set?  = ${Boolean(ADMIN_KEY)}`)
})
