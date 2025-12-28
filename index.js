const express = require("express")
const Razorpay = require("razorpay")
const crypto = require("crypto")
const cors = require("cors")
const { Resend } = require("resend")

const app = express()
app.use(cors())
app.use(express.json())

/* =========================
   EMAIL (RESEND)
========================= */
const resend = new Resend(process.env.RESEND_API_KEY)

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
   CONFIRM PAYMENT (VERIFIED)
   + SEND EMAIL
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

    /* ---------- BASIC VALIDATION ---------- */
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
            return res
                .status(400)
                .json({ error: "Invalid payment signature" })
        }

        /* ---------- FORMAT PAYMENT TYPE ---------- */
        const readablePaymentType =
            paymentType === "PREPAID"
                ? "Full Prepaid"
                : "Cash on Delivery (₹1,750 Advance)"

        console.log("✅ Payment verified:", {
            edition,
            paymentType: readablePaymentType,
            amount,
            paymentId,
        })

        /* ---------- SEND EMAIL ---------- */
        await resend.emails.send({
            from: "SoulScript Legacy <onboarding@resend.dev>",
            to: ["soulscriptlegacy@gmail.com"],
            subject: `🖤 New Order Confirmed – ${edition}`,
            html: `
                <h2>New Order Confirmed</h2>

                <p><strong>Edition:</strong> ${edition}</p>
                <p><strong>Payment Type:</strong> ${readablePaymentType}</p>
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

        /* ---------- FINAL RESPONSE ---------- */
        res.json({ success: true })
    } catch (err) {
        console.error("❌ Confirmation error:", err)
        res.status(500).json({
            error: "Payment verified but email failed",
        })
    }
})

/* =========================
   START SERVER
========================= */
const PORT = process.env.PORT || 3000
app.listen(PORT, () => {
    console.log(`✅ Server running on port ${PORT}`)
})
