const express = require("express")
const Razorpay = require("razorpay")
const cors = require("cors")
const { Resend } = require("resend")

const app = express()
app.use(cors())
app.use(express.json())

// 📧 RESEND CLIENT
const resend = new Resend(process.env.RESEND_API_KEY)

// 💳 RAZORPAY
const razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET,
})

// 🧾 CREATE RAZORPAY ORDER
app.post("/create-order", async (req, res) => {
    try {
        const amount = req.body.amount

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

// 📦 RECEIVE SHIPPING + SEND EMAIL
app.post("/submit-shipping", async (req, res) => {
    const { name, phone, email, address, edition } = req.body

    if (!name || !phone || !email || !address) {
        return res.status(400).json({ error: "Missing fields" })
    }

    try {
        await resend.emails.send({
            from: "SoulScript Legacy <onboarding@resend.dev>",
            to: ["soulscriptlegacy@gmail.com"],
            subject: `🖤 New Order – ${edition}`,
            html: `
                <h2>New Order Received</h2>
                <p><strong>Edition:</strong> ${edition}</p>
                <p><strong>Name:</strong> ${name}</p>
                <p><strong>Phone:</strong> ${phone}</p>
                <p><strong>Email:</strong> ${email}</p>
                <p><strong>Address:</strong><br/>${address}</p>
            `,
        })

        res.json({ success: true })
    } catch (err) {
        console.error("Email error:", err)
        res.status(500).json({ error: "Email failed" })
    }
})

// 🚀 START SERVER
app.listen(3000, () => {
    console.log("✅ Server running on port 3000")
})

