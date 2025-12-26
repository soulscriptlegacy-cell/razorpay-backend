const express = require("express")
const Razorpay = require("razorpay")
const cors = require("cors")

const app = express()
app.use(cors())
app.use(express.json())

const razorpay = new Razorpay({
  key_id: "rzp_live_RwK9oaCOSSwCZr",
  key_secret: "Ovk2iS2EClmXTtOIzpC69me8",
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
