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
                email: shipping.email,
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
            from: "SoulScript Legacy <onboarding@resend.dev>",
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
   START SERVER
========================= */
const PORT = process.env.PORT || 3000
app.listen(PORT, () => {
    console.log(`✅ Server running on port ${PORT}`)
})
