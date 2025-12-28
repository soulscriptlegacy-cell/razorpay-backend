const express = require("express")
const Razorpay = require("razorpay")
const cors = require("cors")
const nodemailer = require("nodemailer")

const app = express()
app.use(cors())
app.use(express.json())

const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
        user: "soulscriptlegacy@gmail.com",
        pass: process.env.GMAIL_APP_PASSWORD,
    },
})

const razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET,
})

app.post("/create-order", async (req, res) => {
  const amount = req.body.amount

  const order = await razorpay.orders.create({
    amount: amount * 100,
    currency: "INR",
    receipt: "order_" + Date.now(),
  })

  res.json(order)
})

app.listen(3000, () => {
  console.log("Server running")
})

app.post("/submit-shipping", async (req, res) => {
    const { name, phone, email, address, edition } = req.body

    if (!name || !phone || !email || !address) {
        return res.status(400).json({ error: "Missing fields" })
    }

    try {
        await transporter.sendMail({
            from: "SoulScript Legacy <soulscriptlegacy@gmail.com>",
            to: "soulscriptlegacy@gmail.com",
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
        console.error(err)
        res.status(500).json({ error: "Failed to send email" })
    }
})

