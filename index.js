const express = require("express")
const Razorpay = require("razorpay")
const crypto = require("crypto")
const cors = require("cors")
const { Resend } = require("resend")

const app = express()
app.use(cors())
app.use(express.json())

// 🔐 RESEND
const resend = new Resend(process.env.RESEND_API_KEY)

// 💳 RAZORPAY
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
})

// 🧾 CREATE ORDER
app.post("/create-order", async (req, res) => {
  try {
    const { amount } = req.body

    const order = await razorpay.orders.create({
      amount: amount * 100,
      currency: "INR",
      receipt: "order_" + Date.now(),
    })

    res.json(order)
  } catch (err) {
    console.error("Order error:", err)
    res.status(500).json({ error: "Order creation failed" })
  }
})

// ✅ PAYMENT CONFIRMATION (VERIFIED) + EMAIL
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

  // 🔴 Basic validation
  if (
    !paymentId ||
    !orderId ||
    !razorpaySignature ||
    !shipping ||
    !shipping.name
  ) {
    return res.status(400).json({ error: "Missing required data" })
  }

  try {
    // 🔐 STEP 1: VERIFY SIGNATURE (CRITICAL)
    const generatedSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(orderId + "|" + paymentId)
      .digest("hex")

    if (generatedSignature !== razorpaySignature) {
      console.error("❌ Invalid payment signature")
      return res.status(400).json({ error: "Invalid payment signature" })
    }

    // 📧 STEP 2: SEND CONFIRMATION EMAIL
    await resend.emails.send({
      from: "SoulScript Legacy <orders@soulscriptlegacy.com>",
      to: ["soulscriptlegacy@gmail.com"],
      subject: `🖤 New Order Confirmed – ${edition}`,
      html: `
        <h2>New Order Confirmed</h2>

        <p><strong>Edition:</strong> ${edition}</p>
        <p><strong>Payment Type:</strong> ${paymentType}</p>
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

    // ✅ STEP 3: CONFIRM TO FRONTEND
    res.json({ success: true })
  } catch (err) {
    console.error("Email / verification error:", err)
    res.status(500).json({ error: "Payment confirmed but email failed" })
  }
})

// 🚀 START SERVER
app.listen(3000, () => {
  console.log("✅ Server running on port 3000")
})

